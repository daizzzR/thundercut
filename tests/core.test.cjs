const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, normalize, delay, chance, visibleArea } = require('../extension/core.js');
test('defaults are complete and immutable', () => {
  assert.deepEqual(normalize(), DEFAULTS); assert.equal(Object.isFrozen(DEFAULTS), true);
});
test('settings clamp and recover malformed inputs', () => {
  assert.deepEqual(normalize(null), DEFAULTS);
  const s = normalize({minDelay:-9,maxDelay:-50,probability:999,cooldown:-7,enabled:'false'});
  assert.equal(s.minDelay,1); assert.equal(s.maxDelay,1); assert.equal(s.probability,100); assert.equal(s.cooldown,0); assert.equal(s.enabled,true);
  assert.equal(normalize({minDelay:'oops'}).minDelay,1);
});
test('delay deterministic boundaries', () => {
  const s = normalize({minDelay:3,maxDelay:7});
  assert.equal(delay(s,()=>0),3000); assert.equal(delay(s,()=>0.5),5000); assert.equal(delay(s,()=>1),7000);
});
test('probability zero never triggers; 100 always does', () => {
  assert.equal(chance(0,()=>0),false); assert.equal(chance(100,()=>0.999999),true);
  assert.equal(chance(25,()=>0.2499),true); assert.equal(chance(25,()=>0.25),false);
});
test('visible intersection rejects offscreen video', () => {
  assert.equal(visibleArea({left:10,right:110,top:10,bottom:110},100,100),8100);
  assert.equal(visibleArea({left:110,right:210,top:10,bottom:110},100,100),0);
});

test('requested default preset is 1–15 seconds, 100 percent, no cooldown or automatic resume', () => {
  assert.equal(DEFAULTS.minDelay, 1); assert.equal(DEFAULTS.maxDelay, 15);
  assert.equal(DEFAULTS.probability, 100); assert.equal(DEFAULTS.cooldown, 0);
  assert.equal(DEFAULTS.autoResume, false);
  assert.equal(delay(DEFAULTS, () => 0), 1000);
  assert.equal(delay(DEFAULTS, () => .999999) < 15000, true);
});
