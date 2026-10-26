'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// These tests execute the shipped controller, not a parallel implementation.
// The deterministic DOM is deliberately small; visual/media-engine integration
// remains the responsibility of browser.cjs and manual Chrome smoke tests.
const extension = path.join(__dirname, '..', 'extension');
const coreSource = fs.readFileSync(path.join(extension, 'core.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(extension, 'content.js'), 'utf8');
const fastSettings = {
  enabled: true, minDelay: 1, maxDelay: 1, probability: 100,
  cooldown: 0, oncePerVideo: true, autoResume: true
};

class FakeEvents {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) {
    if (typeof event === 'string') event = { type: event };
    event.preventDefault ??= () => { event.defaultPrevented = true; };
    event.stopPropagation ??= () => { event.propagationStopped = true; };
    for (const listener of [...(this.listeners.get(event.type) || [])]) listener(event);
    return !event.defaultPrevented;
  }
}

class FakeStyle {
  constructor() { this.values = new Map(); }
  setProperty(name, value, priority) { this.values.set(name, { value, priority }); }
  getPropertyValue(name) { return this.values.get(name)?.value || ''; }
}

class FakeElement extends FakeEvents {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.style = new FakeStyle();
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.isRoot = false;
    this.popoverOpen = false;
  }
  get isConnected() { return this.isRoot || Boolean(this.parentNode?.isConnected); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...children) {
    for (const child of children) {
      child.remove();
      child.parentNode = this;
      this.children.push(child);
    }
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  attachShadow() {
    this.shadow = new FakeElement('shadow-root');
    this.shadow.parentNode = this;
    return this.shadow;
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  matches(selector) { return selector === ':popover-open' && this.popoverOpen; }
  showPopover() {
    if (this.popoverFailure) throw new Error('Popover unavailable');
    this.popoverOpen = true;
  }
  hidePopover() { this.popoverOpen = false; }
  closest(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (selector.includes('.ad-showing') && node.ad) return node;
      if (selector === '[hidden],[aria-hidden="true"]' &&
          (node.attributes.has('hidden') || node.attributes.get('aria-hidden') === 'true')) return node;
    }
    return null;
  }
}

class FakeVideo extends FakeElement {
  constructor(options = {}) {
    super('video');
    this.src = 'https://example.test/original.mp4';
    this.currentSrc = this.src;
    this.currentTime = 37.5;
    this.paused = false;
    this.ended = false;
    this.seeking = false;
    this.readyState = 4;
    this._muted = false;
    this._volume = 0.6;
    this.pauseCalls = 0;
    this.playCalls = 0;
    this.visible = true;
    this.intersectionRatio = 1;
    this.rect = { left: 80, top: 60, width: 640, height: 360 };
    this.computed = { display: 'block', visibility: 'visible', opacity: '1' };
    Object.assign(this, options);
  }
  get muted() { return this._muted; }
  set muted(value) {
    const next = Boolean(value), changed = next !== this._muted;
    this._muted = next;
    if (changed) this.dispatchEvent('volumechange');
  }
  get volume() { return this._volume; }
  set volume(value) {
    const changed = value !== this._volume;
    this._volume = value;
    if (changed) this.dispatchEvent('volumechange');
  }
  pause() { this.pauseCalls++; this.paused = true; }
  play() {
    this.playCalls++;
    if (this.rejectPlay) return Promise.reject(new Error('User gesture required'));
    this.paused = false;
    this.dispatchEvent('play');
    return Promise.resolve();
  }
  checkVisibility() { return this.visible; }
  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
}

class FakeTimers {
  constructor() { this.now = 0; this.nextId = 1; this.tasks = new Map(); }
  schedule(fn, delay, interval = 0, kind = 'timeout') {
    const id = this.nextId++;
    this.tasks.set(id, { fn, at: this.now + Math.max(0, Number(delay) || 0), interval, kind });
    return id;
  }
  clear(id) { this.tasks.delete(id); }
  advance(ms) {
    const until = this.now + ms;
    let iterations = 0;
    while (true) {
      let nextId = null, nextTask = null;
      for (const [id, task] of this.tasks) {
        if (task.at <= until && (!nextTask || task.at < nextTask.at || (task.at === nextTask.at && id < nextId))) {
          nextId = id; nextTask = task;
        }
      }
      if (!nextTask) break;
      if (++iterations > 100000) throw new Error('Timer loop did not settle');
      this.now = nextTask.at;
      if (nextTask.interval) nextTask.at += nextTask.interval;
      else this.tasks.delete(nextId);
      nextTask.fn(this.now);
    }
    this.now = until;
  }
  count(kind) { return [...this.tasks.values()].filter(task => task.kind === kind).length; }
}

function listenerChannel() {
  const listeners = new Set();
  return {
    addListener: fn => listeners.add(fn),
    emit: (...args) => { for (const listener of [...listeners]) listener(...args); }
  };
}

async function harness(options = {}) {
  const timers = new FakeTimers();
  const document = new FakeEvents();
  document.hidden = false;
  document.fullscreenElement = null;
  document.pictureInPictureElement = null;
  document.documentElement = new FakeElement('html');
  document.documentElement.isRoot = true;
  const created = [], videos = [], ports = [], observers = [], logs = [];
  document.createElement = tag => {
    const element = tag === 'video' ? new FakeVideo() : new FakeElement(tag);
    created.push(element);
    return element;
  };
  document.querySelectorAll = selector => selector === 'video' ? videos.filter(video => video.isConnected) : [];
  const window = new FakeEvents();
  let reloads = 0;
  const location = { href: 'https://example.test/watch/one', reload: () => { reloads++; } };
  const storageChanged = listenerChannel();
  const chrome = {
    storage: {
      local: { get: async () => ({ settings: { ...fastSettings, ...options.settings } }) },
      onChanged: storageChanged
    },
    runtime: {
      getURL: file => `chrome-extension://test-extension/${file}`,
      connect: () => {
        const port = {
          sent: [], disconnected: false,
          onMessage: listenerChannel(), onDisconnect: listenerChannel(),
          postMessage(message) {
            if (this.disconnected) throw new Error('Disconnected port');
            this.sent.push(JSON.parse(JSON.stringify(message)));
          },
          disconnect() {
            if (this.disconnected) return;
            this.disconnected = true;
            this.onDisconnect.emit();
          },
          receive(message) { this.onMessage.emit(message); }
        };
        ports.push(port);
        return port;
      }
    }
  };
  class FakeIntersectionObserver {
    constructor(callback) { this.callback = callback; this.observed = new Set(); observers.push(this); }
    observe(video) {
      this.observed.add(video);
      if (video.intersectionRatio !== null) this.callback([{ target: video, intersectionRatio: video.intersectionRatio }]);
    }
    unobserve(video) { this.observed.delete(video); }
    disconnect() { this.observed.clear(); }
  }
  const context = vm.createContext({
    document, window, location, chrome,
    HTMLVideoElement: FakeVideo,
    IntersectionObserver: FakeIntersectionObserver,
    getComputedStyle: video => video.computed,
    innerWidth: 1280, innerHeight: 720,
    performance: { now: () => timers.now },
    Date: class extends Date { static now() { return 1800000000000 + timers.now; } },
    console: { info: (...args) => logs.push(args) },
    setTimeout: (fn, delay) => timers.schedule(fn, delay),
    clearTimeout: id => timers.clear(id),
    setInterval: (fn, delay) => timers.schedule(fn, delay, delay, 'interval'),
    clearInterval: id => timers.clear(id),
    requestAnimationFrame: fn => timers.schedule(fn, 16, 0, 'raf'),
    cancelAnimationFrame: id => timers.clear(id)
  });
  vm.runInContext(coreSource, context, { filename: 'core.js' });
  vm.runInContext(contentSource, context, { filename: 'content.js' });
  await Promise.resolve();
  const h = {
    timers, document, window, location, ports, observers, created, logs,
    clipChanged() { storageChanged.emit({ clipVersion: { newValue: 2 } }, 'local'); },
    get reloads() { return reloads; },
    get port() { return ports.at(-1); },
    get host() { return document.documentElement.children.find(child => child.dataset.videoPrankHost === 'true'); },
    addVideo(videoOptions = {}) {
      const video = new FakeVideo(videoOptions);
      videos.push(video); document.documentElement.append(video);
      return video;
    },
    advance(ms) { timers.advance(ms); },
    receive(message) { assert.ok(h.port, 'Controller must connect first'); h.port.receive(message); },
    messages(type) { return ports.flatMap(port => port.sent).filter(message => message.type === type); },
    setSettings(patch) {
      options.settings = { ...options.settings, ...patch };
      storageChanged.emit({ settings: { newValue: { ...fastSettings, ...options.settings } } }, 'local');
    },
    intersect(video, ratio) {
      video.intersectionRatio = ratio;
      for (const observer of observers) if (observer.observed.has(video)) observer.callback([{ target: video, intersectionRatio: ratio }]);
    },
    ready() {
      h.advance(250);
      assert.ok(h.port, 'An eligible video should connect lazily');
      h.receive({ type: 'TOKEN', token: 'opaque-test-token' });
      h.receive({ type: 'READY' });
      return h.host;
    },
    request() {
      h.advance(1000);
      assert.ok(h.messages('REQUEST_START').length, 'Eligible playing video should request a clip');
    },
    grant() {
      h.receive({ type: 'GRANTED' });
      const play = h.messages('PLAY').at(-1);
      assert.ok(play, 'A granted request should send PLAY');
      return play.id;
    },
    start() { h.ready(); h.request(); return h.grant(); },
    playing(id) { h.receive({ type: 'PLAYING', id }); },
    progress(id, currentTime, duration = 420) { h.receive({ type: 'PROGRESS', id, currentTime, duration }); },
    evaluateAgain() { vm.runInContext(contentSource, context, { filename: 'content.js' }); }
  };
  return h;
}

function assertRestored(h, video, { muted = false, volume = 0.6, paused = false } = {}) {
  assert.equal(video.muted, muted, 'Original mute state must be restored');
  assert.equal(video.volume, volume, 'Original volume must be restored');
  assert.equal(video.paused, paused, 'Original playback state must follow the restoration policy');
  if (h.host) {
    assert.equal(h.host.style.getPropertyValue('display'), 'none');
    assert.equal(h.host.popoverOpen, false);
  }
  assert.equal(h.timers.count('raf'), 0, 'Restoration must release the animation loop');
  assert.equal(video.listeners.get('play')?.size || 0, 0);
  assert.equal(video.listeners.get('volumechange')?.size || 0, 0);
}

test('no video means no extension port, player host, or iframe allocation', async () => {
  const h = await harness();
  h.advance(60000);
  assert.equal(h.ports.length, 0);
  assert.equal(h.created.length, 0);
  assert.equal(h.observers[0].observed.size, 0);
});

test('ineligible video regions never allocate a player or trigger a clip', async t => {
  const cases = {
    'too narrow': video => { video.rect.width = 239; },
    'too short': video => { video.rect.height = 134; },
    'hidden attribute': video => video.setAttribute('hidden', ''),
    'aria-hidden ancestor': (video, h) => {
      const parent = new FakeElement('div'); parent.setAttribute('aria-hidden', 'true');
      h.document.documentElement.append(parent); parent.append(video);
    },
    'display none': video => { video.computed.display = 'none'; },
    'invisible CSS': video => { video.computed.visibility = 'hidden'; },
    'transparent CSS': video => { video.computed.opacity = '0.05'; },
    'hidden by ancestor visibility': video => { video.visible = false; },
    'ad ancestor': (video, h) => {
      const parent = new FakeElement('div'); parent.ad = true;
      h.document.documentElement.append(parent); parent.append(video);
    },
    'no intersection observation yet': video => { video.intersectionRatio = null; },
    'clipped by iframe ancestor': video => { video.intersectionRatio = 0.98; },
    'offscreen despite full intersection': video => { video.rect.left = 1100; },
    'picture in picture': (video, h) => { h.document.pictureInPictureElement = video; },
    'native video fullscreen': (video, h) => { h.document.fullscreenElement = video; },
    'unrelated fullscreen region': (video, h) => { h.document.fullscreenElement = new FakeElement('div'); },
    'document hidden': (video, h) => { h.document.hidden = true; },
    'seeking': video => { video.seeking = true; },
    'ended': video => { video.ended = true; },
    'unready media': video => { video.readyState = 1; }
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const h = await harness();
    const video = h.addVideo(); change(video, h);
    h.advance(10000);
    assert.equal(h.ports.length, 0, 'Ineligible region should not load the player');
    assert.equal(h.created.length, 0);
    assert.equal(video.pauseCalls, 0);
    assert.equal(video.muted, false);
  });
});

test('trigger waits for readiness and delay, pauses/mutes source, and shows only its region after PLAYING', async () => {
  const h = await harness();
  const video = h.addVideo();
  h.advance(250);
  assert.equal(h.ports.length, 1);
  h.advance(3000);
  assert.equal(h.messages('REQUEST_START').length, 0, 'No READY means no trigger');
  h.receive({ type: 'TOKEN', token: 'capability' });
  h.receive({ type: 'READY' });
  const host = h.host;
  assert.equal(host.shadow.children[0].src, 'chrome-extension://test-extension/player.html#capability');
  h.advance(750);
  assert.equal(h.messages('REQUEST_START').length, 0);
  h.advance(250);
  assert.equal(h.messages('REQUEST_START').length, 1);
  const id = h.grant();
  assert.equal(video.paused, true);
  assert.equal(video.muted, true);
  assert.equal(video.currentTime, 37.5, 'Controller must not seek the original media');
  assert.equal(video.src, 'https://example.test/original.mp4', 'Controller must never rewrite the source');
  assert.equal(host.style.getPropertyValue('display'), 'none', 'Original remains visible while clip starts');
  assert.deepEqual(h.messages('PLAY')[0], { type: 'PLAY', id, volume: 0.6, muted: false });
  h.playing(id);
  assert.equal(host.style.getPropertyValue('display'), 'block');
  assert.equal(host.style.getPropertyValue('left'), '80px');
  assert.equal(host.style.getPropertyValue('top'), '60px');
  assert.equal(host.style.getPropertyValue('width'), '640px');
  assert.equal(host.style.getPropertyValue('height'), '360px');
  assert.equal(host.popoverOpen, true);
  h.receive({ type: 'RESTORE' });
  assertRestored(h, video);
  assert.equal(video.playCalls, 1);
  assert.equal(h.messages('STOP').length, 1);
  assert.equal(h.messages('RELEASE').length, 1);
  h.advance(5000);
  assert.equal(h.messages('REQUEST_START').length, 1, 'Successful once-per-video playback cannot fire twice');
});

test('snapshot preserves preexisting mute and volume and holds site autoplay until restore', async () => {
  const h = await harness();
  const video = h.addVideo({ muted: true, volume: 0.23 });
  const id = h.start(); h.playing(id);
  video.muted = false;
  assert.equal(video.muted, true, 'Site volume changes must not unmute the original beneath the clip');
  video.volume = 0.9;
  await video.play();
  assert.equal(video.paused, true, 'Site autoplay is held during clip playback');
  h.receive({ type: 'RESTORE' });
  assertRestored(h, video, { muted: true, volume: 0.23 });
});

test('a video paused while requesting the clip is not resumed after the grant', async () => {
  const h = await harness();
  const video = h.addVideo();
  h.ready(); h.request(); video.pause();
  const id = h.grant(); h.playing(id); h.receive({ type: 'RESTORE' });
  assertRestored(h, video, { paused: true });
  assert.equal(video.playCalls, 0);
});

test('paused videos never trigger automatically, even when their player is ready', async () => {
  const h = await harness();
  const video = h.addVideo({ paused: true });
  h.ready(); h.advance(10000);
  assert.equal(h.messages('REQUEST_START').length, 0);
  assert.equal(video.pauseCalls, 0);
});

test('manual recovery overrides disabled autoResume', async () => {
  const h = await harness({ settings: { autoResume: false } });
  const video = h.addVideo();
  const id = h.start(); h.playing(id); h.receive({ type: 'RESTORE' });
  assertRestored(h, video);
});

test('startup timeout restores playback even when normal autoResume is disabled', async () => {
  const h = await harness({ settings: { autoResume: false } });
  const video = h.addVideo();
  h.start(); h.advance(14999);
  assert.equal(video.muted, true);
  h.advance(1);
  assertRestored(h, video);
  assert.equal(h.messages('STOP').length, 1);
});

test('matching playback error restores; stale player error and completion are ignored', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start(); h.playing(id);
  h.receive({ type: 'ERROR', id: 'stale-play', reason: 'Stale failure' });
  h.receive({ type: 'ENDED', id: 'stale-play' });
  assert.equal(video.muted, true);
  h.receive({ type: 'ERROR', id, reason: 'Decode failed' });
  assertRestored(h, video);
  assert.equal(h.logs.length, 1);
  h.advance(29999);
  assert.equal(h.messages('REQUEST_START').length, 1, 'Error must not create an immediate retry loop');
});

test('unscoped player error clears readiness and restores the original', async () => {
  const h = await harness({ settings: { oncePerVideo: false } });
  const video = h.addVideo();
  h.start(); h.receive({ type: 'ERROR', reason: 'Player initialization failed' });
  assertRestored(h, video);
  h.advance(35000);
  assert.equal(h.messages('REQUEST_START').length, 1, 'Initialization failure requires fresh READY');
});

test('45 seconds without playback progress restores even when autoResume is disabled', async () => {
  const h = await harness({ settings: { autoResume: false } });
  const video = h.addVideo();
  const id = h.start(); h.playing(id);
  h.advance(44999);
  assert.equal(video.muted, true);
  h.advance(1);
  assertRestored(h, video);
  assert.equal(h.messages('STOP').length, 1);
  assert.equal(h.messages('RELEASE').length, 1);
});

test('a seven-minute clip remains active through all 420 seconds of advancing progress', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start(); h.playing(id);
  for (let seconds = 5; seconds <= 420; seconds += 5) {
    h.advance(5000);
    h.progress(id, seconds, 420);
    assert.equal(video.muted, true, `Clip must remain active at ${seconds} seconds`);
    assert.equal(video.paused, true);
    assert.equal(h.host.style.getPropertyValue('display'), 'block');
    assert.equal(h.messages('STOP').length, 0, 'There must be no absolute-duration cutoff');
  }
  h.receive({ type: 'RESTORE' });
  assertRestored(h, video);
  h.advance(60000);
  assert.equal(h.messages('STOP').length, 1, 'Completion must clear the remaining watchdog');
});

test('stall timeout is measured from the last actual media advance', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start(); h.playing(id);
  h.advance(40000); h.progress(id, 5, null);
  h.advance(44999);
  assert.equal(video.muted, true, 'An advancing frame must renew the watchdog');
  h.advance(1);
  assertRestored(h, video);
});

test('repeated, regressing, malformed and stale progress cannot keep a stalled clip alive', async t => {
  const cases = {
    'same media time': (h, id) => h.progress(id, 10),
    'regressed media time': (h, id) => h.progress(id, 5),
    'zero media time': (h, id) => h.progress(id, 0),
    'negative media time': (h, id) => h.progress(id, -1),
    'nonfinite media time': (h, id) => h.progress(id, Infinity),
    'NaN media time': (h, id) => h.progress(id, NaN),
    'string media time': (h, id) => h.progress(id, '999'),
    'missing media time': (h, id) => h.receive({ type: 'PROGRESS', id }),
    'stale playback generation': (h, id, seconds) => h.progress(`${id}-old`, seconds + 10),
    'duplicate PLAYING': (h, id) => h.playing(id)
  };
  for (const [name, send] of Object.entries(cases)) await t.test(name, async () => {
    const h = await harness();
    const video = h.addVideo();
    const id = h.start(); h.playing(id); h.progress(id, 10);
    for (let seconds = 5; seconds <= 40; seconds += 5) {
      h.advance(5000); send(h, id, seconds);
      assert.equal(video.muted, true);
    }
    h.advance(4999); assert.equal(video.muted, true);
    h.advance(1); assertRestored(h, video);
  });
});

test('progress before PLAYING cannot bypass the 15-second startup timeout', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start();
  h.advance(5000); h.progress(id, 5);
  h.advance(5000); h.progress(id, 10);
  h.advance(4999); assert.equal(video.muted, true);
  h.advance(1); assertRestored(h, video);
});

test('a slow but successful startup receives a full 45-second progress window', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start();
  h.advance(14000); h.playing(id);
  h.advance(44999); assert.equal(video.muted, true);
  h.advance(1); assertRestored(h, video);
});

test('restoration clears the old watchdog before a later manual playback begins', async () => {
  const h = await harness();
  const video = h.addVideo();
  const oldId = h.start(); h.playing(oldId); h.progress(oldId, 5);
  h.advance(30000); h.receive({ type: 'RESTORE' });
  assertRestored(h, video);
  h.receive({ type: 'MANUAL' });
  const id = h.grant(); h.playing(id);
  h.advance(20000); h.progress(id, 20);
  assert.equal(video.muted, true, 'The earlier generation watchdog must not stop new playback');
  h.progress(oldId, 100);
  h.receive({ type: 'RESTORE' });
  assertRestored(h, video);
  h.advance(60000);
  assert.equal(h.messages('STOP').length, 2);
});

test('unanswered grant requests release after 2.5 seconds without disturbing video', async () => {
  const h = await harness();
  const video = h.addVideo();
  h.ready(); h.request(); h.advance(2500);
  assert.equal(h.messages('RELEASE').length, 1);
  assert.equal(h.messages('PLAY').length, 0);
  assert.equal(video.pauseCalls, 0);
  assert.equal(video.muted, false);
});

test('a denied request waits three seconds before accumulating a new trigger', async () => {
  const h = await harness();
  h.addVideo(); h.ready(); h.request(); h.receive({ type: 'DENIED' });
  h.advance(2999);
  assert.equal(h.messages('REQUEST_START').length, 1);
  h.advance(1001);
  assert.equal(h.messages('REQUEST_START').length, 2);
});

test('settings disable restores original and removes player; re-enable reconnects', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start(); h.playing(id);
  const port = h.port;
  h.setSettings({ enabled: false });
  assertRestored(h, video);
  assert.equal(port.disconnected, true);
  assert.equal(h.host, undefined);
  h.advance(5000);
  assert.equal(h.ports.length, 1);
  h.setSettings({ enabled: true }); h.advance(250);
  assert.equal(h.ports.length, 2);
  h.receive({ type: 'TOKEN', token: 'new-token' }); h.receive({ type: 'READY' });
  assert.ok(h.host?.isConnected);
});

test('clip changes restore original, request reload, and wait for fresh readiness', async () => {
  const h = await harness({ settings: { oncePerVideo: false } });
  const video = h.addVideo();
  const id = h.start(); h.playing(id);
  h.clipChanged();
  assertRestored(h, video);
  assert.equal(h.messages('RELOAD').length, 1);
  h.advance(5000);
  assert.equal(h.messages('REQUEST_START').length, 1);
  h.receive({ type: 'READY' }); h.advance(1000);
  assert.equal(h.messages('REQUEST_START').length, 2);
});

test('source replacement releases mute and never resumes the replacement media', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start(); h.playing(id);
  video.src = video.currentSrc = 'https://example.test/replacement.mp4';
  h.advance(16);
  assertRestored(h, video, { paused: true });
  assert.equal(video.playCalls, 0);
  assert.equal(video.src, 'https://example.test/replacement.mp4');
  await video.play(); h.advance(1250);
  assert.equal(h.messages('REQUEST_START').length, 2, 'New source has its own once-per-video state');
});

test('detached source is unmuted without attempting playback', async () => {
  const h = await harness();
  const video = h.addVideo({ volume: 0.31 });
  const id = h.start(); h.playing(id);
  video.remove(); h.advance(250);
  assertRestored(h, video, { volume: 0.31, paused: true });
  assert.equal(video.playCalls, 0);
  assert.equal(h.observers[0].observed.has(video), false);
});

test('SPA navigation restores without resuming old media or reloading the page', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start(); h.playing(id);
  h.location.href = 'https://example.test/watch/two'; h.advance(250);
  assertRestored(h, video, { paused: true });
  assert.equal(video.playCalls, 0);
  assert.equal(h.reloads, 0);
  await video.play(); h.advance(1000);
  assert.equal(h.messages('REQUEST_START').length, 2, 'SPA route starts fresh tracking');
});

test('intersection loss restores the original according to autoResume', async t => {
  for (const autoResume of [true, false]) await t.test(`autoResume=${autoResume}`, async () => {
    const h = await harness({ settings: { autoResume } });
    const video = h.addVideo();
    const id = h.start(); h.playing(id);
    h.intersect(video, 0.5); h.advance(16);
    assertRestored(h, video, { paused: !autoResume });
  });
});

test('BFCache pagehide cleans up and persisted pageshow reconnects without a page reload', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start(); h.playing(id);
  const originalPort = h.port;
  h.window.dispatchEvent({ type: 'pagehide', persisted: true });
  assertRestored(h, video, { paused: true });
  assert.equal(originalPort.disconnected, true);
  assert.equal(h.host, undefined);
  assert.equal(h.timers.count('interval'), 0);
  assert.equal(h.observers[0].observed.size, 0);
  h.advance(5000);
  assert.equal(h.ports.length, 1);
  h.window.dispatchEvent({ type: 'pageshow', persisted: true });
  assert.equal(h.timers.count('interval'), 2);
  h.advance(250);
  assert.equal(h.ports.length, 2);
  h.receive({ type: 'TOKEN', token: 'bfcache-token' }); h.receive({ type: 'READY' });
  await video.play(); h.advance(1000);
  assert.equal(h.messages('REQUEST_START').length, 2);
  const newId = h.grant(); h.playing(newId); h.receive({ type: 'RESTORE' });
  assertRestored(h, video);
  assert.equal(h.reloads, 0);
});

test('unexpected disconnect restores and reconnects once after 1.5 seconds', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start(); h.playing(id);
  h.port.disconnect();
  assertRestored(h, video);
  assert.equal(h.host, undefined);
  h.advance(1499); assert.equal(h.ports.length, 1);
  h.advance(1); assert.equal(h.ports.length, 2);
  assert.equal(h.host, undefined, 'Reconnect still waits for a fresh TOKEN');
  h.receive({ type: 'TOKEN', token: 'reconnect-token' }); h.receive({ type: 'READY' });
  assert.ok(h.host?.isConnected);
});

test('manual restore and Escape resume original even when autoResume is disabled', async t => {
  for (const trigger of ['message', 'escape', 'shortcut']) await t.test(trigger, async () => {
    const h = await harness({ settings: { autoResume: false } });
    const video = h.addVideo();
    const id = h.start(); h.playing(id);
    if (trigger === 'message') h.receive({ type: 'RESTORE' });
    else {
      const event = trigger === 'escape' ? { type: 'keydown', key: 'Escape' } :
        { type: 'keydown', code: 'KeyR', altKey: true, shiftKey: true };
      h.document.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
      assert.equal(event.propagationStopped, true);
    }
    assertRestored(h, video);
  });
});

test('hidden document restores original according to autoResume and stops triggers', async t => {
  for (const autoResume of [true, false]) await t.test(`autoResume=${autoResume}`, async () => {
    const h = await harness({ settings: { autoResume } });
    const video = h.addVideo();
    const id = h.start(); h.playing(id);
    h.document.hidden = true; h.document.dispatchEvent('visibilitychange');
    assertRestored(h, video, { paused: !autoResume });
    h.advance(10000);
    assert.equal(h.messages('REQUEST_START').length, 1);
  });
});

test('native fullscreen transition restores the original video', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start(); h.playing(id);
  h.document.fullscreenElement = video; h.document.dispatchEvent('fullscreenchange');
  assertRestored(h, video);
});

test('largest eligible playing video is selected; smaller video is left untouched', async () => {
  const h = await harness();
  const small = h.addVideo({ rect: { left: 0, top: 0, width: 320, height: 180 } });
  const large = h.addVideo();
  h.start();
  assert.equal(small.paused, false); assert.equal(small.muted, false);
  assert.equal(large.paused, true); assert.equal(large.muted, true);
});

test('late grant for a now-ineligible region is released without pausing the source', async () => {
  const h = await harness();
  const video = h.addVideo();
  h.ready(); h.request(); h.intersect(video, 0.4); h.receive({ type: 'GRANTED' });
  assert.equal(h.messages('PLAY').length, 0);
  assert.equal(h.messages('RELEASE').length, 1);
  assert.equal(video.pauseCalls, 0);
});

test('failed popover display restores video immediately', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start(); h.host.popoverFailure = true; h.playing(id);
  assertRestored(h, video);
});

test('rejected original play promise keeps controls available and does not leak handlers', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start(); h.playing(id);
  video.rejectPlay = true; h.receive({ type: 'RESTORE' });
  await Promise.resolve();
  assertRestored(h, video, { paused: true });
  assert.equal(h.logs.length, 1);
});

test('duplicate content injection does not create duplicate observers or intervals', async () => {
  const h = await harness();
  h.evaluateAgain();
  assert.equal(h.observers.length, 1);
  assert.equal(h.timers.count('interval'), 2);
});

test('initially disabled settings never allocate a player', async () => {
  const h = await harness({ settings: { enabled: false } });
  const video = h.addVideo(); h.advance(10000);
  assert.equal(h.ports.length, 0);
  assert.equal(h.created.length, 0);
  assert.equal(video.pauseCalls, 0);
});

test('zero probability suppresses automatic triggers but manual preview still works', async () => {
  const h = await harness({ settings: { probability: 0 } });
  const video = h.addVideo(); h.ready(); h.advance(10000);
  assert.equal(h.messages('REQUEST_START').length, 0);
  h.receive({ type: 'MANUAL' });
  assert.equal(h.messages('REQUEST_START').length, 1);
  const id = h.grant(); h.playing(id); h.receive({ type: 'RESTORE' });
  assertRestored(h, video);
});

test('manual preview bypasses once-per-video and cooldown restrictions', async () => {
  const h = await harness({ settings: { cooldown: 120 } });
  const video = h.addVideo();
  const id = h.start(); h.playing(id); h.receive({ type: 'RESTORE' });
  h.receive({ type: 'MANUAL' });
  assert.equal(h.messages('REQUEST_START').length, 2);
  const previewId = h.grant(); h.playing(previewId); h.receive({ type: 'RESTORE' });
  assertRestored(h, video);
});

test('automatic repeat honors cooldown when once-per-video is disabled', async () => {
  const h = await harness({ settings: { oncePerVideo: false, cooldown: 5 } });
  h.addVideo();
  const id = h.start(); h.playing(id); h.receive({ type: 'RESTORE' });
  h.advance(4999);
  assert.equal(h.messages('REQUEST_START').length, 1);
  h.advance(1001);
  assert.equal(h.messages('REQUEST_START').length, 2);
});

test('stale PLAYING cannot expose the player or cancel startup recovery', async () => {
  const h = await harness();
  const video = h.addVideo();
  h.start(); h.receive({ type: 'PLAYING', id: 'an-old-playback' });
  assert.equal(h.host.style.getPropertyValue('display'), 'none');
  h.advance(15000);
  assertRestored(h, video);
});

test('PLAYER_LOST restores original and removes the broken host', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start(); h.playing(id); h.receive({ type: 'PLAYER_LOST' });
  assertRestored(h, video);
  assert.equal(h.host, undefined);
  assert.equal(h.port.disconnected, true);
});

test('removing the overlay host restores the unchanged original safely', async () => {
  const h = await harness();
  const video = h.addVideo();
  const id = h.start(); h.playing(id);
  h.host.remove(); h.advance(16);
  assertRestored(h, video);
});

test('completed clip holds final overlay and never resumes or retriggers, even with legacy autoResume enabled', async () => {
  const h = await harness({ settings: { autoResume: true, oncePerVideo: false } });
  const video = h.addVideo();
  const id = h.start(); h.playing(id); h.progress(id, 420);
  h.receive({ type: 'ENDED', id });
  h.progress(id, 421); // late progress must not restart the watchdog
  h.advance(120000);
  assert.equal(video.paused, true);
  assert.equal(video.muted, true);
  assert.equal(video.playCalls, 0);
  assert.equal(h.host.popoverOpen, true);
  assert.equal(h.messages('STOP').length, 0);
  assert.equal(h.messages('RELEASE').length, 0);
  assert.equal(h.messages('REQUEST_START').length, 1);
  await video.play();
  assert.equal(video.paused, true, 'Site autoplay is still held after completion');
  h.receive({ type: 'RESTORE' });
  assertRestored(h, video);
});

test('hiding a completed clip releases the overlay without resuming the original', async () => {
  const h = await harness({ settings: { autoResume: true } });
  const video = h.addVideo(); const id = h.start(); h.playing(id);
  h.receive({ type: 'ENDED', id });
  h.document.hidden = true; h.document.dispatchEvent({ type: 'visibilitychange' });
  assertRestored(h, video, { paused: true });
  assert.equal(video.playCalls, 0);
});
