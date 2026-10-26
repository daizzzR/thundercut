export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
export function storageAdvice(fileSize, estimate = {}) {
  const known = Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage);
  const remaining = known ? Math.max(0, estimate.quota - estimate.usage) : null;
  const warnings = [];
  if (fileSize >= 256 * 1024 ** 2) warnings.push('大文件会复制到本机扩展存储，保存可能较久；实际内存与缓冲由浏览器管理');
  if (remaining !== null && fileSize > remaining) warnings.push(`文件大于估计剩余空间（${formatBytes(remaining)}），将尝试写入；若配额不足会保留旧片`);
  // Estimates are advisory; only the actual write can establish whether quota is sufficient.
  return { remaining, warning: warnings.join('。') };
}
export async function estimateStorage(storage = globalThis.navigator?.storage) {
  try { return storage?.estimate ? await storage.estimate() : {}; }
  catch { return {}; }
}
export function importErrorMessage(error) {
  if (error?.name === 'QuotaExceededError') return '浏览器配额或磁盘空间不足，旧片未被覆盖。请释放空间后重试；也可使用较小的文件。';
  if (error?.name === 'AbortError') return '已取消导入，旧片未被覆盖。';
  return error?.message || '导入失败，旧片未被覆盖，请重试。';
}
export async function inspectMedia(file, { signal, document = globalThis.document, urls = URL, timeoutMs = 60000 } = {}) {
  if (!file || !Number.isFinite(file.size) || file.size <= 0) throw new Error('请选择非空的视频文件。');
  if (signal?.aborted) throw new DOMException('导入已取消', 'AbortError');
  const url = urls.createObjectURL(file), probe = document.createElement('video');
  probe.preload = 'metadata'; probe.muted = true;
  try {
    return await new Promise((resolve, reject) => {
      let finished = false;
      const abort = () => finish(new DOMException('导入已取消', 'AbortError'));
      const timer = setTimeout(() => finish(new Error('视频元数据读取超时；文件可能仍可用，请重试或检查文件格式。')), timeoutMs);
      function finish(error) {
        if (finished) return; finished = true;
        clearTimeout(timer); probe.onloadedmetadata = null; probe.onerror = null; signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve({ duration: Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : null, width: probe.videoWidth, height: probe.videoHeight });
      }
      probe.onloadedmetadata = () => finish(probe.videoWidth > 0 && probe.videoHeight > 0 ? null : new Error('文件中未检测到可读取的视频画面。'));
      probe.onerror = () => finish(new Error('浏览器无法读取此视频格式，请换用受支持的 WebM 或 MP4。'));
      signal?.addEventListener('abort', abort, { once: true });
      probe.src = url; probe.load();
    });
  } finally { probe.pause(); probe.removeAttribute('src'); probe.load(); urls.revokeObjectURL(url); }
}
