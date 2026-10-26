import { DEFAULT_VIDEO } from './video-config.js';
import './core.js';
import { readClip, writeClip, deleteClip } from './db.js';
import { inspectMedia, estimateStorage, storageAdvice, importErrorMessage, formatBytes } from './media-import.js';
const $ = id => document.getElementById(id);
let previewURL = null, importController = null;
const status = (id, text, error = false) => { $(id).textContent = text; $(id).classList.toggle('error', error); };
const { settings } = await chrome.storage.local.get('settings');
for (const [key, value] of Object.entries(VideoPrankCore.normalize(settings))) {
  if (!$(key)) continue;
  if ($(key).type === 'checkbox') $(key).checked = value; else $(key).value = value;
}
$('settings').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(Object.keys(VideoPrankCore.DEFAULTS).filter(key => $(key)).map(key => [key, $(key).type === 'checkbox' ? $(key).checked : Number($(key).value)]));
  if (values.maxDelay < values.minDelay) return status('settings-status', '最长等待不能小于最短等待。', true);
  try { await chrome.storage.local.set({ settings: VideoPrankCore.normalize({ ...values, autoResume: false }) }); status('settings-status', '已保存，已打开的视频页会自动更新。'); }
  catch { status('settings-status', '保存失败，请重试。', true); }
});
async function refreshPreview() {
  if (previewURL) URL.revokeObjectURL(previewURL);
  const clip = await readClip();
  $('preview').src = clip?.blob ? (previewURL = URL.createObjectURL(clip.blob)) : chrome.runtime.getURL(DEFAULT_VIDEO);
  $('clip-name').textContent = clip ? `${clip.name} · ${formatBytes(clip.blob.size)} · ${clip.duration ? `${Math.round(clip.duration)} 秒` : '时长由播放时读取'}` : '文件夹默认视频（见 video-config.js；随附文件是 5 秒原创演示片）';
}
async function refreshStorage() {
  const estimate = await estimateStorage();
  $('storage-info').textContent = Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)
    ? `浏览器估计已用 ${formatBytes(estimate.usage)} / 配额 ${formatBytes(estimate.quota)}。配额是估计值，实际写入时确认。`
    : '浏览器未提供可用空间估计；保存时会报告实际存储错误。';
}
$('file').addEventListener('change', async () => {
  const file = $('file').files[0]; if (!file) return;
  importController = new AbortController();
  const { signal } = importController;
  $('file').disabled = true; $('reset-clip').disabled = true;
  $('cancel-import').hidden = false; $('cancel-import').disabled = false;
  status('file-status', '正在读取视频元数据…');
  let committed = false;
  try {
    const advice = storageAdvice(file.size, await estimateStorage());
    $('file-warning').textContent = advice.warning;
    const metadata = await inspectMedia(file, { signal });
    status('file-status', `正在将 ${formatBytes(file.size)} 保存到本机；请保持此页打开。`);
    await writeClip({ blob: file, name: file.name, ...metadata, importedAt: Date.now() }, { signal });
    committed = true; $('cancel-import').disabled = true;
    await chrome.storage.local.set({ clipVersion: crypto.randomUUID() });
    await refreshPreview(); status('file-status', '视频已替换，网页播放器正在预读元数据；实际解码在播放时确认。');
  } catch (error) { status('file-status', committed ? '视频已存入本机，但页面更新失败。请刷新设置页及视频网页。' : importErrorMessage(error), true); }
  finally { importController = null; $('file').disabled = false; $('reset-clip').disabled = false; $('cancel-import').hidden = true; $('file').value = ''; await refreshStorage(); }
});
$('cancel-import').addEventListener('click', () => { importController?.abort(); status('file-status', '正在取消尚未提交的导入…'); });
$('reset-clip').addEventListener('click', async () => {
  try { await deleteClip(); await chrome.storage.local.set({ clipVersion: crypto.randomUUID() }); await refreshPreview(); await refreshStorage(); status('file-status', '已切换为文件夹默认视频。'); }
  catch { status('file-status', '恢复失败，请重试。', true); }
});
await refreshPreview().catch(() => status('file-status', '无法读取本机短片，重新导入可重试。', true));
await refreshStorage();
window.addEventListener('pagehide', () => { importController?.abort(); if (previewURL) URL.revokeObjectURL(previewURL); });
