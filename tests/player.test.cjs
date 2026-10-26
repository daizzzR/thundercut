'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../extension/player.js'), 'utf8')
  .replace("import { readClip } from './db.js';", 'const readClip = globalThis.mockReadClip;')
  .replace("import { DEFAULT_VIDEO } from './video-config.js';", "const DEFAULT_VIDEO = 'videos/default.webm';");

class Element {
  constructor() {
    this.listeners = new Map();
    this.readyState = 1;
    this.currentTime = 0;
    this.duration = 420;
    this.paused = true;
    this.volume = 1;
    this.muted = false;
    this.pauseCount = 0;
    this.loads = [];
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(event) {
    if (typeof event === 'string') event = { type: event };
    event.preventDefault ??= () => { event.defaultPrevented = true; };
    for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event);
    return event;
  }
  pause() { this.paused = true; this.pauseCount++; }
  play() { this.paused = false; return Promise.resolve(); }
  load() { this.loads.push({ src: this.src, preload: this.preload }); }
  removeAttribute(name) { delete this[name]; }
}

class Timers {
  constructor() { this.now = 0; this.nextId = 1; this.tasks = new Map(); }
  schedule(fn, delay, interval = 0) {
    const id = this.nextId++;
    this.tasks.set(id, { fn, at: this.now + delay, interval });
    return id;
  }
  clear(id) { this.tasks.delete(id); }
  advance(ms) {
    const until = this.now + ms;
    while (true) {
      const due = [...this.tasks].filter(([, task]) => task.at <= until)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, task] = due;
      this.now = task.at;
      if (task.interval) task.at += task.interval;
      else this.tasks.delete(id);
      task.fn();
    }
    this.now = until;
  }
}

function setup(clip, properties = {}) {
  const video = Object.assign(new Element(), properties);
  const button = new Element(), document = new Element(), window = new Element();
  const sent = [], urls = [], revoked = [], timers = new Timers();
  let listener, disconnect, reads = 0;
  const port = {
    postMessage: message => sent.push(message),
    onMessage: { addListener: fn => { listener = fn; } },
    onDisconnect: { addListener: fn => { disconnect = fn; } }
  };
  document.getElementById = id => id === 'clip' ? video : button;
  const context = vm.createContext({
    document, window, location: { hash: '#secret' },
    chrome: { runtime: { connect: () => port, getURL: file => `chrome-extension://test/${file}` } },
    mockReadClip: async () => { reads++; return clip; },
    Blob,
    URL: {
      createObjectURL: blob => { urls.push(blob); return `blob:local-${urls.length}`; },
      revokeObjectURL: url => revoked.push(url)
    },
    setTimeout: (fn, delay) => timers.schedule(fn, delay),
    clearTimeout: id => timers.clear(id),
    setInterval: (fn, delay) => timers.schedule(fn, delay, delay),
    clearInterval: id => timers.clear(id),
    console
  });
  vm.runInContext(source, context, { filename: 'player.js' });
  return {
    video, button, document, window, sent, urls, revoked, timers,
    reads: () => reads, send: listener, disconnect,
    messages: type => sent.filter(message => message.type === type),
    advance: ms => timers.advance(ms)
  };
}

async function waitForMetadataListener(p) {
  // readClip resolves in the host realm and load continues in the VM realm.
  // Drain both promise queues before dispatching the synthetic media event.
  for (let turn = 0; turn < 10 && !p.video.listeners.get('loadedmetadata')?.size; turn++) {
    await Promise.resolve();
  }
  assert.equal(p.video.listeners.get('loadedmetadata')?.size, 1, 'Metadata listener must be registered');
}

async function start(p, id = '1') {
  await p.send({ type: 'AUTHORIZED' });
  await p.send({ type: 'PLAY', id, volume: 1, muted: false });
}

test('player will not load local media until authenticated', async () => {
  const p = setup();
  await p.send({ type: 'PLAY' });
  await p.send({ type: 'RELOAD' });
  assert.equal(p.reads(), 0);
  assert.equal(p.video.src, undefined);
  await p.send({ type: 'AUTHORIZED' });
  assert.equal(p.reads(), 1);
  assert.match(p.video.src, /videos\/default.webm$/);
  assert.equal(p.sent.at(-1).type, 'READY');
});

test('player requests metadata preload and reports READY at HAVE_METADATA without decoded frames', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../extension/player.html'), 'utf8');
  assert.match(html, /<video\b[^>]*\bpreload="metadata"/);
  const p = setup(undefined, { readyState: 1 });
  await p.send({ type: 'AUTHORIZED' });
  assert.equal(p.video.preload, 'metadata');
  assert.equal(p.video.loads[0].preload, 'metadata');
  assert.equal(p.video.readyState, 1, 'No loadeddata or decoded frame is needed');
  assert.equal(p.messages('READY').length, 1);
  assert.equal(p.messages('READY')[0].duration, 420);
  assert.equal(p.timers.tasks.size, 0);
});

test('loadedmetadata alone completes asynchronous preload and removes its listeners', async () => {
  const p = setup(undefined, { readyState: 0 });
  const loading = p.send({ type: 'AUTHORIZED' });
  await waitForMetadataListener(p);
  assert.equal(p.messages('READY').length, 0);
  assert.equal(p.video.listeners.get('loadedmetadata').size, 1);
  assert.equal(p.video.listeners.get('loadeddata')?.size || 0, 0);
  p.video.readyState = 1;
  p.video.dispatch('loadedmetadata');
  await loading;
  assert.equal(p.messages('READY').length, 1);
  assert.equal(p.video.listeners.get('loadedmetadata').size, 0);
  assert.equal(p.timers.tasks.size, 0);
});

test('imported Blob stays local and loads by URL without arrayBuffer, text or stream decoding', async () => {
  const blob = new Blob(['fixture'], { type: 'video/webm' });
  for (const method of ['arrayBuffer', 'text', 'stream']) {
    blob[method] = () => { assert.fail(`Player must not materialize the clip with ${method}()`); };
  }
  const p = setup({ blob });
  await p.send({ type: 'AUTHORIZED' });
  assert.match(p.video.src, /^blob:/);
  assert.equal(p.urls[0], blob);
  assert.equal(p.messages('READY').length, 1);
  assert.equal(p.video.loads[0].preload, 'metadata');
});

test('play propagates source mute and volume; denied autoplay reports recoverable error', async () => {
  const p = setup();
  await p.send({ type: 'AUTHORIZED' });
  p.video.play = () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
  await p.send({ type: 'PLAY', id: '1', volume: .35, muted: false });
  assert.equal(p.video.volume, .35);
  assert.equal(p.video.muted, false);
  assert.equal(p.sent.at(-1).type, 'ERROR');
  assert.match(p.sent.at(-1).reason, /自动播放/);
  p.advance(60000);
  assert.equal(p.messages('PROGRESS').length, 0);
  assert.equal(p.timers.tasks.size, 0);
});

test('active player reports real currentTime and duration immediately and every five seconds', async () => {
  const p = setup();
  await start(p, 'seven-minutes');
  assert.equal(p.messages('PLAYING').length, 1);
  assert.equal(p.messages('PROGRESS').length, 1);
  assert.equal(p.messages('PROGRESS')[0].currentTime, 0);
  p.video.currentTime = 4.75;
  p.advance(4999);
  assert.equal(p.messages('PROGRESS').length, 1);
  p.advance(1);
  const progress = p.messages('PROGRESS').at(-1);
  assert.deepEqual({ ...progress }, { type: 'PROGRESS', id: 'seven-minutes', currentTime: 4.75, duration: 420 });
  for (let seconds = 10; seconds <= 420; seconds += 5) {
    p.video.currentTime = seconds;
    p.advance(5000);
  }
  assert.equal(p.messages('PROGRESS').length, 85);
  assert.equal(p.messages('PROGRESS').at(-1).currentTime, 420);
  assert.equal(p.video.paused, false, 'Seven-minute clip must not hit an absolute duration cap');
  p.video.dispatch('ended');
  assert.equal(p.messages('ENDED')[0].id, 'seven-minutes');
  assert.equal(p.timers.tasks.size, 0);
});

test('stalled media reports its unchanged position rather than invented elapsed progress', async () => {
  const p = setup();
  await start(p);
  p.video.currentTime = 2;
  p.advance(5000);
  p.advance(45000);
  assert.ok(p.messages('PROGRESS').slice(1).every(message => message.currentTime === 2));
});

test('nonfinite duration is reported as null without blocking metadata readiness or progress', async () => {
  const p = setup(undefined, { duration: Infinity });
  await start(p);
  assert.equal(p.messages('READY')[0].duration, null);
  assert.equal(p.messages('PROGRESS')[0].duration, null);
});

test('stale play resolution cannot pause a newer generation or create an extra progress timer', async () => {
  const p = setup();
  await p.send({ type: 'AUTHORIZED' });
  let resolveOld, resolveNew;
  p.video.play = () => new Promise(resolve => { resolveOld = resolve; });
  const old = p.send({ type: 'PLAY', id: 'old', volume: 1, muted: false });
  await p.send({ type: 'STOP' });
  p.video.play = () => new Promise(resolve => { resolveNew = resolve; });
  const newer = p.send({ type: 'PLAY', id: 'new', volume: 1, muted: false });
  const pauses = p.video.pauseCount;
  resolveOld(); await old;
  assert.equal(p.video.pauseCount, pauses);
  assert.equal(p.messages('PLAYING').length, 0);
  assert.equal(p.messages('PROGRESS').length, 0);
  resolveNew(); await newer;
  assert.equal(p.messages('PLAYING').at(-1).id, 'new');
  assert.equal(p.messages('PROGRESS').at(-1).id, 'new');
  assert.equal(p.timers.tasks.size, 1);
});

test('STOP, completion, errors, restore controls and lifecycle exits stop all progress', async t => {
  const actions = {
    STOP: p => p.send({ type: 'STOP' }),
    error: p => p.video.dispatch('error'),
    Escape: p => p.document.dispatch({ type: 'keydown', key: 'Escape' }),
    shortcut: p => p.document.dispatch({ type: 'keydown', altKey: true, shiftKey: true, code: 'KeyR' }),
    disconnect: p => p.disconnect(),
    pagehide: p => p.window.dispatch('pagehide')
  };
  for (const [name, action] of Object.entries(actions)) await t.test(name, async () => {
    const p = setup();
    await start(p);
    p.video.currentTime = 5; p.advance(5000);
    const count = p.messages('PROGRESS').length;
    await action(p);
    assert.equal(p.video.paused, true);
    assert.equal(p.video.currentTime, 0);
    assert.equal(p.timers.tasks.size, 0);
    p.advance(120000);
    assert.equal(p.messages('PROGRESS').length, count);
  });
});

test('bridge disconnect stops playback and unloads media', async () => {
  const p = setup();
  await start(p);
  p.disconnect();
  assert.equal(p.video.paused, true);
  assert.equal(p.video.src, undefined);
  assert.equal(p.timers.tasks.size, 0);
});

test('reloading local media releases the previous Blob URL and clears active progress', async () => {
  const p = setup({ blob: new Blob(['fixture'], { type: 'video/webm' }) });
  await start(p);
  const oldURL = p.video.src;
  await p.send({ type: 'RELOAD' });
  assert.equal(p.revoked[0], oldURL);
  assert.notEqual(p.video.src, oldURL);
  assert.equal(p.messages('READY').length, 2);
  assert.equal(p.video.paused, true);
  assert.equal(p.timers.tasks.size, 0);
});

test('STOP during metadata loading suppresses stale READY', async () => {
  const p = setup(undefined, { readyState: 0 });
  const loading = p.send({ type: 'AUTHORIZED' });
  await waitForMetadataListener(p);
  await p.send({ type: 'STOP' });
  p.video.readyState = 1; p.video.dispatch('loadedmetadata');
  await loading;
  assert.equal(p.messages('READY').length, 0);
  assert.equal(p.messages('STOPPED').length, 1);
  assert.equal(p.timers.tasks.size, 0);
});

test('metadata load failure and timeout report initialization errors and clean listeners', async t => {
  for (const failure of ['error', 'timeout']) await t.test(failure, async () => {
    const p = setup(undefined, { readyState: 0 });
    const loading = p.send({ type: 'AUTHORIZED' });
    await waitForMetadataListener(p);
    if (failure === 'error') p.video.dispatch('error');
    else p.advance(60000);
    await loading;
    assert.equal(p.messages('READY').length, 0);
    assert.equal(p.messages('ERROR').length, 1);
    assert.equal(p.messages('ERROR')[0].id, undefined);
    assert.equal(p.video.listeners.get('loadedmetadata').size, 0);
    assert.equal(p.timers.tasks.size, 0);
  });
});

test('completion keeps final frame, clears progress, and has no in-picture return button', async () => {
  const p = setup(); await start(p, 'finish');
  p.video.currentTime = 420; p.video.dispatch('ended');
  assert.equal(p.video.currentTime, 420);
  assert.equal(p.video.paused, true);
  assert.equal(p.messages('ENDED').length, 1);
  assert.equal(p.timers.tasks.size, 0);
  p.video.dispatch('ended');
  assert.equal(p.messages('ENDED').length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../extension/player.html'), 'utf8'), /<button|id="restore"/);
  p.button.dispatch('click'); assert.equal(p.messages('RESTORE').length, 0);
});
