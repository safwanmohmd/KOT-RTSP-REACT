import express from 'express';
import cors from 'cors';
import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// --- Cross-Platform FFmpeg Timeout Flag Detection ---
// FFmpeg 4.x (Ubuntu 20.04) uses -stimeout
// FFmpeg 5.x+ (Windows modern builds) uses -timeout
let timeoutFlag = '-timeout';
try {
  const check = spawnSync('ffmpeg', ['-h', 'full']);
  const helpOutput = check.stdout ? check.stdout.toString() : '';
  if (helpOutput.includes('-stimeout')) {
    timeoutFlag = '-stimeout';
  } else {
    timeoutFlag = '-timeout';
  }
} catch (e) {
  timeoutFlag = '-timeout';
}
console.log(`[FFMPEG] Detected RTSP timeout flag: ${timeoutFlag}`);

let progressClients = [];

const formatDahuaTime = (isoString) => {
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}_${pad(d.getMonth() + 1)}_${pad(d.getDate())}_${pad(d.getHours())}_${pad(d.getMinutes())}_${pad(d.getSeconds())}`;
};

const getDriveClient = async () => {
  const credentialsPath = path.join(__dirname, 'credentials.json');
  const tokenPath = path.join(__dirname, 'token.json');

  if (!fs.existsSync(credentialsPath)) {
    throw new Error('credentials.json not found in root folder.');
  }

  const credentials = JSON.parse(fs.readFileSync(credentialsPath));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(tokenPath)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(tokenPath)));
  } else {
    throw new Error('token.json missing. Authorize Google account first.');
  }

  return google.drive({ version: 'v3', auth: oAuth2Client });
};

// SSE Progress Endpoint
app.get('/api/progress', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n');
  progressClients.push(res);

  req.on('close', () => {
    progressClients = progressClients.filter(client => client !== res);
  });
});

const broadcastProgress = (data) => {
  progressClients.forEach(res => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
};

// 1. Live & Playback Stream Route
app.get('/api/stream', (req, res) => {
  const { ip = '192.168.1.175', port = '554', user = 'admin', password = '', channel = '1', mode = 'playback', start_time } = req.query;
  const encUser = encodeURIComponent(user);
  const encPass = encodeURIComponent(password);

  let rtspUrl = '';
  if (mode === 'live') {
    rtspUrl = `rtsp://${encUser}:${encPass}@${ip}:${port}/cam/realmonitor?channel=${channel}&subtype=0`;
  } else {
    const start = formatDahuaTime(start_time);
    const endDate = new Date(new Date(start_time).getTime() + 4 * 60 * 60 * 1000);
    const end = formatDahuaTime(endDate.toISOString());
    rtspUrl = `rtsp://${encUser}:${encPass}@${ip}:${port}/cam/playback?channel=${channel}&subtype=0&starttime=${start}&endtime=${end}`;
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache'
  });

  const ffmpegArgs = [
    '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    timeoutFlag, '5000000',
    '-i', rtspUrl,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-an',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);

  ffmpeg.stdout.pipe(res);

  ffmpeg.stderr.on('data', (d) => {
    console.error('Stream stderr:', d.toString());
  });

  req.on('close', () => {
    ffmpeg.kill('SIGKILL');
  });
});

// 2. High-Speed Extraction with 1x / 2x Speed Options
app.post('/api/extract', (req, res) => {
  const { ip = '192.168.1.175', port = '554', user = 'admin', password = '', channel = '1', mode = 'playback', start_time, end_time, duration = 10, speed = '1x' } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'DVR Password is required' });
  }

  const encUser = encodeURIComponent(user);
  const encPass = encodeURIComponent(password);

  let rtspUrl = '';
  let durationSec = parseInt(duration, 10);
  let outFile = '';

  if (mode === 'live') {
    const stamp = Date.now();
    outFile = `Live_Ch${channel}_${speed}_${stamp}.mp4`;
    rtspUrl = `rtsp://${encUser}:${encPass}@${ip}:${port}/cam/realmonitor?channel=${channel}&subtype=0`;
  } else {
    const dtStart = new Date(start_time);
    const dtEnd = new Date(end_time);
    durationSec = Math.floor((dtEnd - dtStart) / 1000);

    if (durationSec <= 0) {
      return res.status(400).json({ error: 'End time must be after start time' });
    }

    const startFmt = formatDahuaTime(start_time);
    const endFmt = formatDahuaTime(end_time);
    outFile = `Footage_Ch${channel}_${speed}_${startFmt}.mp4`;
    rtspUrl = `rtsp://${encUser}:${encPass}@${ip}:${port}/cam/playback?channel=${channel}&subtype=0&starttime=${startFmt}&endtime=${endFmt}`;
  }

  const outFilePath = path.join(__dirname, outFile);

  broadcastProgress({ percent: 0, currentSec: 0, totalSec: durationSec, speed: '0x' });

  if (fs.existsSync(outFilePath)) {
    fs.unlinkSync(outFilePath);
  }

  const args = [
    '-y',
    '-rtsp_transport', 'tcp',
    timeoutFlag, '5000000',
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-i', rtspUrl,
    '-t', String(durationSec)
  ];

  if (speed === '2x') {
    args.push('-vf', 'setpts=0.5*PTS');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-avoid_negative_ts', 'make_zero',
    '-an',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    outFilePath
  );

  const ffmpeg = spawn('ffmpeg', args);
  let speedValue = '1.0x';
  let stderrLog = '';

  ffmpeg.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (line.startsWith('speed=')) {
        speedValue = line.split('=')[1].trim();
      }
      if (line.startsWith('out_time_us=')) {
        const timeUs = parseInt(line.split('=')[1].trim(), 10);
        if (!isNaN(timeUs)) {
          const currentSec = Math.floor(timeUs / 1000000);
          const targetDuration = speed === '2x' ? Math.floor(durationSec / 2) : durationSec;
          const percent = Math.min(100, Math.max(0, Math.floor((currentSec / (targetDuration || 1)) * 100)));
          broadcastProgress({
            percent,
            currentSec,
            totalSec: durationSec,
            speed: speedValue
          });
        }
      }
    });
  });

  ffmpeg.stderr.on('data', (data) => {
    stderrLog += data.toString();
  });

  ffmpeg.on('close', () => {
    const fileExists = fs.existsSync(outFilePath);
    const fileSize = fileExists ? fs.statSync(outFilePath).size : 0;

    if (stderrLog.includes('401 Unauthorized') || stderrLog.includes('Connection refused')) {
      if (fileExists) fs.unlinkSync(outFilePath);
      return res.status(401).json({ error: 'Authentication failed. Incorrect DVR password.' });
    }

    if (!fileExists || fileSize < 50000) {
      if (fileExists) fs.unlinkSync(outFilePath);
      return res.status(500).json({ error: 'No video stream received. Check DVR password or time range.' });
    }

    broadcastProgress({ percent: 100, currentSec: durationSec, totalSec: durationSec, speed: speedValue });
    res.json({ file: outFile });
  });
});

// Download Route
app.get('/api/download/:filename', (req, res) => {
  const filePath = path.join(__dirname, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath, req.params.filename);
  } else {
    res.status(404).send('File not found');
  }
});

// File Serving for Preview Box
app.get('/api/files/:filename', (req, res) => {
  const filePath = path.join(__dirname, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// Drive Upload
app.post('/api/upload_drive', async (req, res) => {
  const { filename } = req.body;
  const filePath = path.join(__dirname, filename);

  if (!filename || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  try {
    const drive = await getDriveClient();
    const fileMetadata = { name: filename };
    const media = {
      mimeType: 'video/mp4',
      body: fs.createReadStream(filePath)
    };

    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink'
    });

    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: { role: 'reader', type: 'anyone' }
    });

    res.json({ link: file.data.webViewLink });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Drive upload failed' });
  }
});

app.listen(5000, () => {
  console.log('⚡ CCTV Node Backend running on http://localhost:5000');
});