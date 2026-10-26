import { DEFAULT_VIDEO } from './video-config.js';
import { readClip } from './db.js';
const video = document.getElementById('clip');
const port = chrome.runtime.connect({ name: `video-prank-player:${location.hash.slice(1)}` });
let objectURL = null, generation = 0, authorized = false, playId = null, progressTimer = 0;
const send = message => { try { port.postMessage(message); } catch {} };
function stop() { generation++; clearInterval(progressTimer); progressTimer = 0; playId = null; video.pause(); video.currentTime = 0; }
function reportProgress() {
  if (playId) send({ type: 'PROGRESS', id: playId, currentTime: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null });
}
async function load() {
  stop();
  const current = generation;
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = null;
  try {
    const stored = await readClip();
    if (current !== generation) return;
    video.preload = 'metadata';
    video.src = stored?.blob instanceof Blob ? (objectURL = URL.createObjectURL(stored.blob)) : chrome.runtime.getURL(DEFAULT_VIDEO);
    video.load();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('视频元数据读取超时')), 60000);
      const finish = error => { clearTimeout(timer); video.removeEventListener('loadedmetadata', ready); video.removeEventListener('error', fail); error ? reject(error) : resolve(); };
      const ready = () => finish();
      const fail = () => finish(new Error('浏览器无法解码这段短片'));
      video.addEventListener('loadedmetadata', ready, { once: true });
      video.addEventListener('error', fail, { once: true });
      if (video.readyState >= 1) ready();
    });
    if (current === generation) send({ type: 'READY', duration: Number.isFinite(video.duration) ? video.duration : null });
  } catch (error) { if (current === generation) send({ type: 'ERROR', reason: error.message }); }
}
port.onMessage.addListener(async message => {
  if (message.type === 'AUTHORIZED') { authorized = true; await load(); return; }
  if (!authorized) return;
  if (message.type === 'RELOAD') { await load(); return; }
  if (message.type === 'STOP') { stop(); send({ type: 'STOPPED' }); return; }
  if (message.type === 'PLAY') {
    clearInterval(progressTimer); progressTimer = 0;
    const current = ++generation;
    playId = message.id;
    video.currentTime = 0;
    video.volume = Math.max(0, Math.min(1, Number(message.volume) || 0));
    video.muted = Boolean(message.muted);
    try {
      await video.play();
      if (current !== generation) return;
      send({ type: 'PLAYING', id: playId });
      reportProgress(); progressTimer = setInterval(reportProgress, 5000);
    } catch (error) {
      if (current === generation) send({ type: 'ERROR', id: playId, reason: error.name === 'NotAllowedError' ? '浏览器阻止了短片自动播放，已恢复原视频' : '短片播放失败，已恢复原视频' });
    }
  }
});
video.addEventListener('ended', () => {
  if (!playId) return;
  const id = playId; playId = null; generation++;
  clearInterval(progressTimer); progressTimer = 0; video.pause();
  // Keep the final frame; do not seek back or restore the original automatically.
  send({ type: 'ENDED', id });
});
video.addEventListener('error', () => { if (playId) { send({ type: 'ERROR', id: playId, reason: '视频播放错误' }); stop(); } });
document.addEventListener('keydown', event => { if (event.key === 'Escape' || (event.altKey && event.shiftKey && event.code === 'KeyR')) { event.preventDefault(); stop(); send({ type: 'RESTORE' }); } });
port.onDisconnect.addListener(() => { stop(); video.removeAttribute('src'); video.load(); });
window.addEventListener('pagehide', () => { stop(); if (objectURL) URL.revokeObjectURL(objectURL); });
