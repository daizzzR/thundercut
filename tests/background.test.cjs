const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const core = require('../extension/core.js');
const code = fs.readFileSync(require('node:path').join(__dirname,'../extension/background.js'),'utf8').replace("import './core.js';",'');
function event(){const handlers=[];return {addListener:fn=>handlers.push(fn),fire:(...a)=>handlers.forEach(fn=>fn(...a))};}
function port(name, tabId=1, frameId=0, url='https://example.test/watch'){
 return {name,sender:{id:'extension-id',tab:{id:tabId},frameId,url},onMessage:event(),onDisconnect:event(),sent:[],closed:false,postMessage(m){this.sent.push(m);},disconnect(){if(!this.closed){this.closed=true;this.onDisconnect.fire();}}};
}
function setup(){
 const runtime={id:'extension-id',onInstalled:event(),onConnect:event(),onMessage:event(),getURL:p=>`chrome-extension://extension-id/${p}`};
 let sequence=0;
 vm.runInNewContext(code,{chrome:{runtime,storage:{local:{get:async()=>({}),set:async()=>{}}}},crypto:{randomUUID:()=>`token-${++sequence}`},VideoPrankCore:core,console});
 const connect=(tabId,frameId)=>{const c=port('video-prank-controller',tabId,frameId);runtime.onConnect.fire(c);return c;};
 return {runtime,connect};
}
test('bridge authenticates matching same-tab player, rejects token theft from another tab',()=>{
 const {runtime,connect}=setup();const controller=connect(1,0),token=controller.sent[0].token;
 const bad=port(`video-prank-player:${token}`,2,8,`chrome-extension://extension-id/player.html#${token}`);runtime.onConnect.fire(bad);assert.equal(bad.closed,true);
 const player=port(`video-prank-player:${token}`,1,8,`chrome-extension://extension-id/player.html#${token}`);runtime.onConnect.fire(player);assert.equal(player.sent[0].type,'AUTHORIZED');
 controller.onMessage.fire({type:'PLAY',id:'clip',volume:.5});assert.equal(player.sent.at(-1).type,'PLAY');
 player.onMessage.fire({type:'READY'});assert.equal(controller.sent.at(-1).type,'READY');
 player.onMessage.fire({type:'PROGRESS',id:'clip',currentTime:420,duration:420});assert.equal(controller.sent.at(-1).type,'PROGRESS');assert.equal(controller.sent.at(-1).currentTime,420);
});
test('one replacement at a time per tab, while other tabs remain independent',()=>{
 const {connect}=setup();const a=connect(1,0),b=connect(1,2),c=connect(2,0);
 a.onMessage.fire({type:'REQUEST_START'});b.onMessage.fire({type:'REQUEST_START'});c.onMessage.fire({type:'REQUEST_START'});
 assert.equal(a.sent.at(-1).type,'GRANTED');assert.equal(b.sent.at(-1).type,'DENIED');assert.equal(c.sent.at(-1).type,'GRANTED');
 a.onMessage.fire({type:'RELEASE'});b.onMessage.fire({type:'REQUEST_START'});assert.equal(b.sent.at(-1).type,'GRANTED');
});
test('controller disconnect releases tab lock and stops player connection',()=>{
 const {runtime,connect}=setup();const a=connect(1,0),b=connect(1,2),token=a.sent[0].token;
 const player=port(`video-prank-player:${token}`,1,3,`chrome-extension://extension-id/player.html#${token}`);runtime.onConnect.fire(player);
 a.onMessage.fire({type:'REQUEST_START'});a.disconnect();assert.equal(player.closed,true);
 b.onMessage.fire({type:'REQUEST_START'});assert.equal(b.sent.at(-1).type,'GRANTED');
});
test('page sender cannot issue privileged tab UI commands',()=>{
 const {runtime,connect}=setup();const c=connect(1,0);const before=c.sent.length;
 runtime.onMessage.fire({type:'TRIGGER_TAB',tabId:1},{id:'extension-id',tab:{id:1},url:'https://example.test/'},()=>{throw Error('must not respond');});
 assert.equal(c.sent.length,before);
 let response;runtime.onMessage.fire({type:'TRIGGER_TAB',tabId:1},{id:'extension-id',url:'chrome-extension://extension-id/popup.html'},r=>response=r);
 assert.equal(c.sent.at(-1).type,'MANUAL');assert.equal(response.connected,true);
});

test('upgrade applies requested preset once while retaining disabled state and later custom settings', async () => {
 let installed, writes = [], saved = {settings:{...core.DEFAULTS,enabled:false,minDelay:20,maxDelay:90,probability:25,autoResume:true}};
 const runtime={id:'extension-id',onInstalled:{addListener:fn=>installed=fn},onConnect:event(),onMessage:event()};
 vm.runInNewContext(code,{chrome:{runtime,storage:{local:{get:async()=>saved,set:async value=>{writes.push(value);saved={...saved,...value};}}}},VideoPrankCore:core,console});
 await installed(); assert.equal(writes.length,1); assert.equal(saved.settings.enabled,false);
 assert.equal(saved.settings.minDelay,1); assert.equal(saved.settings.maxDelay,15); assert.equal(saved.settings.probability,100); assert.equal(saved.settings.autoResume,false);
 saved.settings.minDelay=7; await installed(); assert.equal(writes.length,1); assert.equal(saved.settings.minDelay,7);
});
