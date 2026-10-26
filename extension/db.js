const DB_NAME = 'video-plot-twist';
export function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('clips');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transact(mode, operation, { signal } = {}) {
  const db = await openDB();
  try {
    if (signal?.aborted) throw new DOMException('导入已取消', 'AbortError');
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('clips', mode);
      let request, failure;
      const abort = () => { try { transaction.abort(); } catch {} };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      transaction.oncomplete = () => { cleanup(); resolve(request?.result); };
      transaction.onerror = event => { failure = event.target?.error || transaction.error; };
      transaction.onabort = () => {
        cleanup();
        reject(failure || transaction.error || new DOMException(signal?.aborted ? '导入已取消' : '存储被中止', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      try { request = operation(transaction.objectStore('clips')); }
      catch (error) { failure = error; abort(); }
    });
  } finally { db.close(); }
}
export const readClip = () => transact('readonly', store => store.get('current'));
// Store the File/Blob directly. Never turn the entire media into a JS ArrayBuffer or base64 string.
// IndexedDB replacement is atomic: an aborted/quota-failed write leaves the previous clip intact.
export const writeClip = (clip, options) => transact('readwrite', store => store.put(clip, 'current'), options);
export const deleteClip = () => transact('readwrite', store => store.delete('current'));
