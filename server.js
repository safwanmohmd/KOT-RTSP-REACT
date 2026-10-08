import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

let progressClients = [];

// Helper: Format to YYYY_MM_DD_HH_MM_SS
const formatDahuaTime = (isoString) => {
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}_${pad(d.getMonth() + 1)}_${pad(d.getDate())}_${pad(d.getHours())}_${pad(d.getMinutes())}_${pad(d.getSeconds())}`;
};

// Google Drive Client
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

// 1. SSE Progress Endpoint
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

// 2. Stream Live/Playback in the UI box
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

  const ffmpeg = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-timeout', '8000000',
    '-fflags', '+genpts+igndts+nobuffer',
    '-i', rtspUrl,
    '-c:v', 'copy',
    '-tag:v', 'hvc1',
    '-avoid_negative_ts', 'make_zero',
    '-an',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  ]);

  ffmpeg.stdout.pipe(res);

  req.on('close', () => {
    ffmpeg.kill('SIGKILL');
  });
});

// 3. Extraction Endpoint
app.post('/api/extract', (req, res) => {
  const { ip = '192.168.1.175', port = '554', user = 'admin', password = '', channel = '1', mode = 'playback', start_time, end_time, duration = 10 } = req.body;
  const encUser = encodeURIComponent(user);
  const encPass = encodeURIComponent(password);

  let rtspUrl = '';
  let durationSec = parseInt(duration, 10);
  let outFile = '';

  if (mode === 'live') {
    const stamp = Date.now();
    outFile = `Live_Ch${channel}_${stamp}.mp4`;
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
    outFile = `Footage_Ch${channel}_${startFmt}.mp4`;
    rtspUrl = `rtsp://${encUser}:${encPass}@${ip}:${port}/cam/playback?channel=${channel}&subtype=0&starttime=${startFmt}&endtime=${endFmt}`;
  }

  broadcastProgress({ percent: 0, currentSec: 0, totalSec: durationSec, speed: '0x' });

  const args = [
    '-y',
    '-timeout', '10000000',
    '-rtsp_transport', 'tcp',
    '-reorder_queue_size', '4096',
    '-buffer_size', '10240000',
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-i', rtspUrl,
    '-t', String(durationSec),
    '-c:v', 'copy',
    '-tag:v', 'hvc1',
    '-avoid_negative_ts', 'make_zero',
    '-an',
    '-movflags', '+faststart+frag_keyframe+empty_moov+default_base_moof',
    '-progress', 'pipe:1',
    outFile
  ];

  const ffmpeg = spawn('ffmpeg', args);
  let speedValue = '1.0x';

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
          const percent = Math.min(100, Math.max(0, Math.floor((currentSec / durationSec) * 100)));
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

  ffmpeg.on('close', () => {
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 5000) {
      broadcastProgress({ percent: 100, currentSec: durationSec, totalSec: durationSec, speed: speedValue });
      res.json({ file: outFile });
    } else {
      res.status(500).json({ error: 'Extraction failed. Make sure DVR has recorded data for this range.' });
    }
  });
});

// 4. Download Route with Content-Disposition (Forces Browser Download)
app.get('/api/download/:filename', (req, res) => {
  const filePath = path.join(__dirname, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath, req.params.filename);
  } else {
    res.status(404).send('File not found');
  }
});

// 5. Normal File Serving (For In-App Preview Video Box)
app.get('/api/files/:filename', (req, res) => {
  const filePath = path.join(__dirname, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// 6. Drive Upload
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