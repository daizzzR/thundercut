(() => {
  'use strict';
  if (globalThis.__videoPlotTwist) return;
  globalThis.__videoPlotTwist = true;
  const Core = globalThis.VideoPrankCore;
  let settings = Core.normalize(), records = new Map(), port = null, host = null, ready = false;
  let pending = null, active = null, cooldownUntil = 0, lastTick = performance.now(), pageURL = location.href;
  let stopped = false, reconnectTimer = 0, startupTimer = 0, maxClipTimer = 0, raf = 0, playSequence = 0;
  const AD_SELECTOR = '.ad-showing,.ad-interrupting,[data-ad],video[data-is-ad="true"],.video-ads,.bilibili-player-video-ad,.bpx-player-ad-video,.ad-container,[id^="google_ads_"]';
  const intersections = new WeakMap();
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) intersections.set(entry.target, entry.intersectionRatio);
  }, { threshold: [0, 0.99, 1] });
  const post = message => { try { port?.postMessage(message); } catch { disconnect(); } };
  const style = (element, values) => Object.entries(values).forEach(([key, value]) => element.style.setProperty(key, value, 'important'));
  function disconnect() {
    if (stopped) return;
    restore('connection', true);
    ready = false;
    host?.remove(); host = null;
    const previousPort = port; port = null;
    try { previousPort?.disconnect(); } catch {}
    clearTimeout(reconnectTimer);
    reconnectTimer = settings.enabled ? setTimeout(connect, 1500) : 0;
  }
  function connect() {
    reconnectTimer = 0;
    if (stopped || port || !settings.enabled) return;
    try {
      port = chrome.runtime.connect({ name: 'video-prank-controller' });
      port.onDisconnect.addListener(disconnect);
      port.onMessage.addListener(onMessage);
    } catch { stopped = true; restore('extension', true); host?.remove(); }
  }
  function createPlayer(token) {
    host?.remove();
    host = document.createElement('div');
    host.dataset.videoPrankHost = 'true';
    host.setAttribute('popover', 'manual');
    style(host, { all: 'initial', display: 'none', position: 'fixed', margin: '0', padding: '0', border: '0', inset: 'auto', 'z-index': '2147483647', overflow: 'hidden', background: '#000', 'box-sizing': 'border-box', 'pointer-events': 'none', opacity: '0' });
    const shadow = host.attachShadow({ mode: 'closed' });
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('player.html') + '#' + token;
    iframe.title = '本地彩蛋短片；可恢复原视频';
    iframe.allow = 'autoplay';
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    style(iframe, { display: 'block', width: '100%', height: '100%', border: '0', margin: '0', padding: '0', background: '#000' });
    shadow.append(iframe);
    document.documentElement.append(host);
  }
  function onMessage(message) {
    if (message.type === 'TOKEN') createPlayer(message.token);
    if (message.type === 'READY') ready = true;
    if (message.type === 'GRANTED') {
      if (!pending || !eligible(pending.video, true) || !settings.enabled) { pending = null; post({ type: 'RELEASE' }); return; }
      start(pending); pending = null;
    }
    if (message.type === 'DENIED') { pending = null; cooldownUntil = performance.now() + 3000; }
    if (message.type === 'PLAYING' && active && !active.started && message.id === active.id) {
      clearTimeout(startupTimer);
      active.started = true;
      active.record.fired = true;
      armProgressWatchdog();
      show();
    }
    if (message.type === 'PROGRESS' && active?.started && !active.ended && message.id === active.id && Number.isFinite(message.currentTime) && message.currentTime > active.clipTime + 0.01) {
      active.clipTime = message.currentTime;
      armProgressWatchdog();
    }
    if (message.type === 'ENDED' && active && message.id === active.id) {
      active.ended = true;
      clearTimeout(startupTimer); clearTimeout(maxClipTimer);
      // Hold the final frame and original pause/mute until explicit recovery or navigation.
    }
    if (message.type === 'ERROR') {
      const currentError = !message.id || active?.id === message.id;
      if (currentError) {
        restore('error', true);
        cooldownUntil = performance.now() + Math.max(settings.cooldown * 1000, 30000);
        if (!message.id) ready = false;
        // Do not expose clip names or media data to the host page.
        console.info('[半路彩蛋]', message.reason || '无法播放；原视频已保留。');
      }
    }
    if (message.type === 'PLAYER_LOST') disconnect();
    if (message.type === 'MANUAL') requestStart(bestCandidate(), true);
    if (message.type === 'RESTORE') restore('manual', true);
  }
  function sourceKey(video) { return `${video.currentSrc || video.src || ''}`; }
  function scan() {
    if (stopped) return;
    for (const video of document.querySelectorAll('video')) {
      if (!records.has(video)) {
        records.set(video, { video, source: sourceKey(video), elapsed: 0, delay: Core.delay(settings), fired: false });
        observer.observe(video);
      }
    }
    for (const [video, record] of records) {
      if (!video.isConnected) {
        if (active?.record === record) restore('removed', false);
        records.delete(video);
        observer.unobserve(video);
      } else if (record.source !== sourceKey(video)) {
        if (active?.record === record) restore('source', false);
        record.source = sourceKey(video); record.elapsed = 0; record.delay = Core.delay(settings); record.fired = false;
      }
    }
  }
  function eligible(video, allowPaused = false) {
    if (!video?.isConnected || document.hidden || video.ended || video.seeking || video.readyState < 2 || (!allowPaused && video.paused)) return false;
    if (video.closest(AD_SELECTOR) || video.closest('[hidden],[aria-hidden="true"]')) return false;
    // IntersectionObserver clips through ancestor browsing contexts, unlike getBoundingClientRect alone.
    if ((intersections.get(video) ?? 0) < 0.99) return false;
    if (document.pictureInPictureElement === video) return false;
    const fullscreen = document.fullscreenElement;
    // Native video fullscreen has browser-owned controls/top-layer behavior. Defer until it exits.
    if (fullscreen instanceof HTMLVideoElement || (fullscreen && !fullscreen.contains(video))) return false;
    const computed = getComputedStyle(video);
    if (computed.display === 'none' || computed.visibility !== 'visible' || Number(computed.opacity) < 0.1) return false;
    if (typeof video.checkVisibility === 'function' && !video.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const rect = video.getBoundingClientRect();
    if (rect.width < 240 || rect.height < 135) return false;
    return Core.visibleArea(rect, innerWidth, innerHeight) >= rect.width * rect.height * 0.99;
  }
  function bestCandidate() {
    scan();
    return [...records.values()].filter(record => eligible(record.video)).sort((a, b) => {
      const ra = a.video.getBoundingClientRect(), rb = b.video.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[0];
  }
  function requestStart(record, manual = false) {
    if (!record || active || pending || !ready || !host?.isConnected || !settings.enabled || document.hidden) return;
    if (!manual && (performance.now() < cooldownUntil || (settings.oncePerVideo && record.fired))) return;
    pending = record;
    post({ type: 'REQUEST_START' });
    setTimeout(() => { if (pending === record) { pending = null; post({ type: 'RELEASE' }); } }, 2500);
  }
  function start(record) {
    const video = record.video;
    active = { record, video, id: `${Date.now()}-${++playSequence}`, source: sourceKey(video), url: location.href, paused: video.paused, muted: video.muted, volume: video.volume, started: false, clipTime: 0 };
    const hold = () => { if (active?.video === video) { video.muted = true; video.pause(); } };
    active.hold = hold;
    video.addEventListener('play', hold);
    video.addEventListener('volumechange', hold);
    video.muted = true; video.pause();
    // Original remains visible while the local player starts. Never leave an empty video box.
    position();
    post({ type: 'PLAY', id: active.id, volume: active.volume, muted: active.muted });
    startupTimer = setTimeout(() => { if (active && !active.started) restore('timeout', true); }, 15000);
    animate();
  }
  function armProgressWatchdog() {
    clearTimeout(maxClipTimer);
    // No total-duration cap. Healthy long videos keep this alive through actual playback progress.
    maxClipTimer = setTimeout(() => restore('stalled', true), 45000);
  }
  function show() {
    if (!host || !active) return;
    style(host, { display: 'block', opacity: '1', 'pointer-events': 'auto' });
    try { if (!host.matches(':popover-open')) host.showPopover(); } catch { restore('display', true); return; }
    position();
  }
  function position() {
    if (!active || !host) return;
    const rect = active.video.getBoundingClientRect();
    style(host, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  function animate() {
    cancelAnimationFrame(raf);
    if (!active) return;
    if (!host?.isConnected || location.href !== active.url || sourceKey(active.video) !== active.source || !eligible(active.video, true)) {
      restore('context'); return;
    }
    position(); raf = requestAnimationFrame(animate);
  }
  function restore(reason, resumeOverride) {
    pending = null;
    clearTimeout(startupTimer); clearTimeout(maxClipTimer); cancelAnimationFrame(raf);
    const previous = active; active = null;
    if (host) {
      try { if (host.matches(':popover-open')) host.hidePopover(); } catch {}
      style(host, { display: 'none', opacity: '0', 'pointer-events': 'none' });
    }
    if (!previous) return;
    post({ type: 'STOP' }); post({ type: 'RELEASE' });
    const { video, record } = previous;
    video.removeEventListener('play', previous.hold);
    video.removeEventListener('volumechange', previous.hold);
    // Always release our mute, including detach/source changes; don't resume the wrong content.
    video.muted = previous.muted; video.volume = previous.volume;
    record.elapsed = 0; record.delay = Core.delay(settings);
    cooldownUntil = performance.now() + settings.cooldown * 1000;
    const sameMedia = video.isConnected && sourceKey(video) === previous.source && location.href === previous.url;
    const resume = resumeOverride ?? (previous.ended ? false : settings.autoResume);
    if (sameMedia && resume && !previous.paused) video.play().catch(() => {
      // Browser policy can require another click; native controls stay available.
      console.info('[半路彩蛋] 原视频已恢复，请点击播放继续。');
    });
  }
  function tick() {
    if (stopped) return;
    const now = performance.now(), elapsed = Math.min(now - lastTick, 500); lastTick = now;
    if (location.href !== pageURL) {
      restore('navigation', false); observer.disconnect(); records.clear(); pageURL = location.href; cooldownUntil = 0;
    }
    scan();
    if (settings.enabled && !port && !reconnectTimer && [...records.values()].some(record => eligible(record.video, true))) connect();
    if (!settings.enabled || active || pending || !ready || document.hidden || now < cooldownUntil) return;
    const record = bestCandidate();
    if (!record || (settings.oncePerVideo && record.fired)) return;
    record.elapsed += elapsed;
    if (record.elapsed >= record.delay) {
      record.elapsed = 0; record.delay = Core.delay(settings);
      if (Core.chance(settings.probability)) requestStart(record);
    }
  }
  chrome.storage.local.get('settings').then(({ settings: saved }) => { settings = Core.normalize(saved); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = Core.normalize(changes.settings.newValue);
      if (!settings.enabled) disconnect();
      for (const record of records.values()) { record.elapsed = 0; record.delay = Core.delay(settings); }
    }
    if (changes.clipVersion) { restore('clip', true); ready = false; post({ type: 'RELOAD' }); }
  });
  document.addEventListener('keydown', event => {
    if (active && (event.key === 'Escape' || (event.altKey && event.shiftKey && event.code === 'KeyR'))) {
      event.preventDefault(); event.stopPropagation(); restore('keyboard', true);
    }
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) restore('background'); lastTick = performance.now(); });
  document.addEventListener('fullscreenchange', () => {
    if (!active) return;
    if (document.fullscreenElement instanceof HTMLVideoElement) restore('native-fullscreen', true);
    else { try { host?.hidePopover(); } catch {} show(); }
  });
  // Scan periodically: supports SPA video replacement without an expensive whole-page mutation observer.
  let interval = setInterval(tick, 250);
  let heartbeat = setInterval(() => post({ type: 'PING' }), 20000);
  window.addEventListener('pagehide', () => {
    restore('pagehide', false); stopped = true;
    clearInterval(interval); clearInterval(heartbeat); clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    observer.disconnect();
    const oldPort = port; port = null;
    try { oldPort?.disconnect(); } catch {} host?.remove(); host = null;
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    stopped = false; ready = false; records.clear(); pageURL = location.href; lastTick = performance.now();
    interval = setInterval(tick, 250);
    heartbeat = setInterval(() => post({ type: 'PING' }), 20000);
  });
})();
