import './core.js';
const sessions = new Map();
const activeTabs = new Map();
const safePost = (port, message) => { try { port?.postMessage(message); } catch {} };
chrome.runtime.onInstalled.addListener(async () => {
  const { settings, settingsVersion } = await chrome.storage.local.get(['settings', 'settingsVersion']);
  // Apply this requested preset once on upgrade; retain imports, enable switch and later customization.
  if (settingsVersion !== 2) await chrome.storage.local.set({ settings: VideoPrankCore.normalize({ ...settings, minDelay: 1, maxDelay: 15, probability: 100, cooldown: 0, autoResume: false }), settingsVersion: 2 });
});
chrome.runtime.onConnect.addListener(port => {
  if (port.sender?.id !== chrome.runtime.id || !port.sender?.tab) return port.disconnect();
  if (port.name === 'video-prank-controller') {
    if (!/^https?:/.test(port.sender.url || '')) return port.disconnect();
    const token = crypto.randomUUID();
    const session = { port, player: null, tabId: port.sender.tab.id, frameId: port.sender.frameId, token };
    sessions.set(token, session);
    port.onMessage.addListener(message => {
      if (message.type === 'REQUEST_START') {
        const active = activeTabs.get(session.tabId);
        if (active && active !== token) return safePost(port, { type: 'DENIED' });
        activeTabs.set(session.tabId, token);
        safePost(port, { type: 'GRANTED' });
      } else if (message.type === 'RELEASE') {
        if (activeTabs.get(session.tabId) === token) activeTabs.delete(session.tabId);
      } else if (['PLAY', 'STOP', 'RELOAD'].includes(message.type)) {
        safePost(session.player, message);
      } else if (message.type === 'PING') {
        safePost(port, { type: 'PONG' });
      }
    });
    port.onDisconnect.addListener(() => {
      sessions.delete(token);
      if (activeTabs.get(session.tabId) === token) activeTabs.delete(session.tabId);
      try { session.player?.disconnect(); } catch {}
    });
    safePost(port, { type: 'TOKEN', token });
  } else if (port.name.startsWith('video-prank-player:')) {
    const token = port.name.slice('video-prank-player:'.length);
    const session = sessions.get(token);
    if (!session || session.tabId !== port.sender.tab.id || session.player || port.sender.url?.split('#')[0] !== chrome.runtime.getURL('player.html')) return port.disconnect();
    session.player = port;
    port.onMessage.addListener(message => {
      if (['READY', 'PLAYING', 'PROGRESS', 'ENDED', 'RESTORE', 'ERROR', 'STOPPED'].includes(message.type)) safePost(session.port, message);
    });
    port.onDisconnect.addListener(() => {
      session.player = null;
      safePost(session.port, { type: 'PLAYER_LOST' });
    });
    safePost(port, { type: 'AUTHORIZED' });
  } else port.disconnect();
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only our extension UI can issue tab-wide commands. Page scripts have no external messaging entrypoint.
  if (sender.id !== chrome.runtime.id || sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (!['TRIGGER_TAB', 'RESTORE_TAB', 'STATUS_TAB'].includes(message.type)) return;
  const list = [...sessions.values()].filter(s => s.tabId === message.tabId).sort((a, b) => a.frameId - b.frameId);
  if (message.type === 'TRIGGER_TAB') list.forEach(s => safePost(s.port, { type: 'MANUAL' }));
  if (message.type === 'RESTORE_TAB') list.forEach(s => safePost(s.port, { type: 'RESTORE' }));
  respond({ connected: list.length > 0, active: activeTabs.has(message.tabId) });
});
