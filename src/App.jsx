import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, Download, CloudUpload, RefreshCw, AlertCircle, CheckCircle, Video } from 'lucide-react';

const API_URL = 'http://localhost:5000/api';

export default function App() {
  const [mode, setMode] = useState('playback');
  const [loading, setLoading] = useState(false);
  const [isPlayingStream, setIsPlayingStream] = useState(false);
  const [status, setStatus] = useState({ text: 'Ready', type: 'idle' });

  const [progress, setProgress] = useState({ percent: 0, currentSec: 0, totalSec: 0, speed: '0x' });

  const [form, setForm] = useState({
    ip: '192.168.1.175',
    port: '554',
    user: 'admin',
    password: '',
    channel: '1',
    start_time: '',
    end_time: '',
    duration: 10
  });

  const [previewSrc, setPreviewSrc] = useState('');
  const [previewTitle, setPreviewTitle] = useState('Preview Screen');
  const [lastExtractedFile, setLastExtractedFile] = useState(null);
  const videoRef = useRef(null);

  useEffect(() => {
    const now = new Date();
    const start = new Date(now.getTime() - 61 * 60 * 1000);
    const end = new Date(now.getTime() - 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

    setForm((prev) => ({
      ...prev,
      start_time: toISO(start),
      end_time: toISO(end)
    }));

    const eventSource = new EventSource(`${API_URL}/progress`);
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setProgress(data);
      } catch (err) {}
    };

    return () => {
      eventSource.close();
    };
  }, []);

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const adjustTime = (seconds) => {
    if (!form.start_time) return;
    const current = new Date(form.start_time);
    const updated = new Date(current.getTime() + seconds * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

    setForm(prev => ({ ...prev, start_time: toISO(updated) }));

    if (isPlayingStream) {
      startLiveDVRStream(toISO(updated));
    }
  };

  // Start live/playback continuous stream in preview box
  const startLiveDVRStream = (customStartTime = null) => {
    if (!form.password) return alert('Enter DVR password first');

    const queryTime = customStartTime || form.start_time;
    const params = new URLSearchParams({
      ip: form.ip,
      port: form.port,
      user: form.user,
      password: form.password,
      channel: form.channel,
      mode: mode,
      start_time: queryTime,
      t: Date.now()
    });

    const url = `${API_URL}/stream?${params.toString()}`;
    setPreviewSrc(url);
    setPreviewTitle(`Live Footage: ${mode === 'playback' ? queryTime : 'Channel ' + form.channel}`);
    setIsPlayingStream(true);
    setStatus({ text: `Streaming from: ${mode === 'playback' ? queryTime : 'Live'}`, type: 'loading' });

    if (videoRef.current) {
      videoRef.current.load();
      videoRef.current.play().catch(() => {});
    }
  };

  const stopStream = () => {
    setPreviewSrc('');
    setIsPlayingStream(false);
    setStatus({ text: 'Stream stopped.', type: 'idle' });
  };

  // Extract, Auto-Play in the Preview Box, and trigger background download without jumping
  const handleDownloadVideo = async () => {
    if (!form.password) return alert('Enter DVR password');
    setLoading(true);
    setIsPlayingStream(false);
    setProgress({ percent: 0, currentSec: 0, totalSec: 0, speed: '0x' });
    setStatus({ text: 'Extracting video...', type: 'loading' });

    try {
      const res = await fetch(`${API_URL}/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, mode })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setLastExtractedFile(data.file);

      // 1. Point preview box directly to the static video file and play inside the box
      const previewFileUrl = `${API_URL}/files/${data.file}?t=${Date.now()}`;
      setPreviewTitle(`Extracted Clip: ${data.file}`);
      setPreviewSrc(previewFileUrl);

      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.load();
          videoRef.current.play().catch(() => {});
        }
      }, 100);

      // 2. Trigger background download without taking over the screen
      const downloadResponse = await fetch(`${API_URL}/download/${data.file}`);
      const blob = await downloadResponse.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = blobUrl;
      a.download = data.file;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(blobUrl);
      document.body.removeChild(a);

      setStatus({ text: `Extracted & Downloaded: ${data.file}`, type: 'success' });
    } catch (err) {
      setStatus({ text: err.message, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleUploadDrive = async () => {
    if (!lastExtractedFile) return alert('Extract a video first before uploading.');
    setLoading(true);
    setStatus({ text: 'Uploading to Google Drive...', type: 'loading' });

    try {
      const res = await fetch(`${API_URL}/upload_drive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: lastExtractedFile })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setStatus({ text: `Uploaded to Drive! URL: ${data.link}`, type: 'success' });
      window.open(data.link, '_blank');
    } catch (err) {
      setStatus({ text: err.message, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-4">
          <h1 className="text-lg font-bold text-sky-400 flex items-center gap-2">
            <Video className="w-5 h-5" /> CP Plus High-Speed Video Extractor
          </h1>
          <span className="text-xs bg-sky-950 text-sky-400 border border-sky-800 px-2.5 py-0.5 rounded-full font-medium">Turbo Pass-through</span>
        </div>

        {/* Embedded Preview Box (Never triggers fullscreen) */}
        <div className="mb-4">
          <div className="flex justify-between items-center mb-1 text-xs text-slate-400 font-medium px-1">
            <span>{previewTitle}</span>
            {previewSrc && <span className="text-emerald-400">Playing in container</span>}
          </div>
          <div className="bg-black border border-slate-800 rounded-xl overflow-hidden aspect-video flex items-center justify-center relative">
            {previewSrc ? (
              <video
                ref={videoRef}
                src={previewSrc}
                autoPlay
                controls
                muted
                playsInline
                disablePictureInPicture
                className="w-full h-full object-contain pointer-events-auto"
              />
            ) : (
              <div className="text-center text-slate-600">
                <Video className="w-10 h-10 mx-auto mb-2 opacity-40" />
                <p className="text-xs">No active video. Select time and stream or extract.</p>
              </div>
            )}
          </div>
        </div>

        {/* Playback Scrubbing Bar */}
        <div className="bg-slate-950 border border-slate-800 p-3 rounded-xl mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {!isPlayingStream ? (
              <button
                type="button"
                onClick={() => startLiveDVRStream()}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 fill-current" /> Stream Selected Time
              </button>
            ) : (
              <button
                type="button"
                onClick={stopStream}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-semibold cursor-pointer"
              >
                <Pause className="w-3.5 h-3.5 fill-current" /> Stop Stream
              </button>
            )}
          </div>

          {mode === 'playback' && (
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => adjustTime(-30)} className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs cursor-pointer">-30s</button>
              <button type="button" onClick={() => adjustTime(-10)} className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs cursor-pointer">-10s</button>
              <button type="button" onClick={() => adjustTime(10)} className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs cursor-pointer">+10s</button>
              <button type="button" onClick={() => adjustTime(30)} className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs cursor-pointer">+30s</button>
            </div>
          )}
        </div>

        {/* Live Extraction Progress Bar */}
        {loading && (
          <div className="mb-4 p-3 bg-slate-950 border border-sky-900/60 rounded-xl">
            <div className="flex justify-between items-center text-xs font-semibold text-sky-400 mb-1.5">
              <span>Extracting Video ({progress.percent}%)</span>
              <span>{progress.currentSec}s / {progress.totalSec}s ({progress.speed})</span>
            </div>
            <div className="w-full bg-slate-800 h-2.5 rounded-full overflow-hidden">
              <div
                className="bg-sky-500 h-full rounded-full transition-all duration-200 ease-out shadow-sm shadow-sky-400"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
        )}

        {/* Mode Selector */}
        <div className="grid grid-cols-2 gap-2 bg-slate-950 p-1.5 rounded-xl border border-slate-800 mb-4">
          <button
            type="button"
            onClick={() => { setMode('playback'); stopStream(); }}
            className={`py-2 text-xs font-semibold rounded-lg transition cursor-pointer ${mode === 'playback' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white'}`}
          >
            Past Recorded Footage
          </button>
          <button
            type="button"
            onClick={() => { setMode('live'); stopStream(); }}
            className={`py-2 text-xs font-semibold rounded-lg transition cursor-pointer ${mode === 'live' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white'}`}
          >
            Live Camera Monitor
          </button>
        </div>

        {/* Inputs */}
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-semibold text-slate-400 block mb-1">DVR IP Address</label>
              <input type="text" name="ip" value={form.ip} onChange={handleChange} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs text-white focus:border-sky-500 outline-none" />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1">Channel</label>
              <select name="channel" value={form.channel} onChange={handleChange} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs text-white focus:border-sky-500 outline-none">
                {[1, 2, 3, 4, 5, 6, 7, 8].map((ch) => (
                  <option key={ch} value={ch}>Channel {ch}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1">Username</label>
              <input type="text" name="user" value={form.user} onChange={handleChange} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs text-white focus:border-sky-500 outline-none" />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1">Password</label>
              <input type="password" name="password" value={form.password} onChange={handleChange} placeholder="DVR Password" className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs text-white focus:border-sky-500 outline-none" />
            </div>
          </div>

          {mode === 'playback' ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1">Start Time (with Secs)</label>
                <input
                  type="datetime-local"
                  step="1"
                  name="start_time"
                  value={form.start_time}
                  onChange={handleChange}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs text-white focus:border-sky-500 outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1">End Time for Clip Download</label>
                <input
                  type="datetime-local"
                  step="1"
                  name="end_time"
                  value={form.end_time}
                  onChange={handleChange}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs text-white focus:border-sky-500 outline-none"
                />
              </div>
            </div>
          ) : (
            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1">Duration to Record (Seconds)</label>
              <input type="number" name="duration" min="5" max="300" value={form.duration} onChange={handleChange} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-white focus:border-sky-500 outline-none" />
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            onClick={handleDownloadVideo}
            disabled={loading}
            className="flex items-center justify-center gap-2 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-xs rounded-lg transition cursor-pointer shadow-lg shadow-emerald-950"
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Extract & Download (.MP4)
          </button>

          <button
            onClick={handleUploadDrive}
            disabled={loading || !lastExtractedFile}
            className="flex items-center justify-center gap-2 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-xs rounded-lg transition cursor-pointer shadow-lg shadow-blue-950"
          >
            <CloudUpload className="w-4 h-4" /> Upload to Drive
          </button>
        </div>

        {/* Status */}
        <div className="mt-3 flex items-center justify-center gap-1.5 text-xs">
          {status.type === 'loading' && <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin" />}
          {status.type === 'success' && <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />}
          {status.type === 'error' && <AlertCircle className="w-3.5 h-3.5 text-rose-500" />}
          <span className={`break-all text-center ${status.type === 'error' ? 'text-rose-400' : status.type === 'success' ? 'text-emerald-400' : 'text-slate-400'}`}>
            {status.text}
          </span>
        </div>
      </div>
    </div>
  );
} 