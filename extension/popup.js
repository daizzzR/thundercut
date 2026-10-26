import './core.js';
const enabled = document.getElementById('enabled');
const status = document.getElementById('status');
const { settings } = await chrome.storage.local.get('settings');
enabled.checked = VideoPrankCore.normalize(settings).enabled;
const refresh = () => document.getElementById('state').textContent = enabled.checked ? '已开启' : '已暂停';
refresh();
enabled.addEventListener('change', async () => {
  const { settings: latest } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...VideoPrankCore.normalize(latest), enabled: enabled.checked } });
  refresh(); status.textContent = enabled.checked ? '正在播放的视频将按规则触发。' : '随机触发已暂停，原视频已恢复。';
});
async function command(type) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.runtime.sendMessage({ type, tabId: tab?.id });
    status.textContent = result?.connected ? (type === 'TRIGGER_TAB' ? '已请求试播。请保持页面内的大视频正在播放；首次预加载可能需要几秒。' : '已请求恢复原视频。') : '此页暂不可用。安装后请刷新视频页；浏览器内部页面不受支持。';
  } catch { status.textContent = '请刷新视频页面后再试。'; }
}
document.getElementById('try').addEventListener('click', () => {
  if (!enabled.checked) { status.textContent = '请先开启彩蛋。'; return; }
  command('TRIGGER_TAB');
});
document.getElementById('restore').addEventListener('click', () => command('RESTORE_TAB'));
document.getElementById('options').addEventListener('click', event => { event.preventDefault(); chrome.runtime.openOptionsPage(); });
