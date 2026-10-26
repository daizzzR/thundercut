const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../extension/media-import.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
function probeHarness({duration=420,width=1920,height=1080,error=false,pending=false}={}) {
 const created=[],revoked=[];
 const probe={duration,videoWidth:width,videoHeight:height,loadCount:0,pauseCount:0,load(){this.loadCount++;if(this.src&&!pending)queueMicrotask(()=>error?this.onerror?.():this.onloadedmetadata?.());},pause(){this.pauseCount++;},removeAttribute(key){delete this[key];}};
 return {probe,created,revoked,document:{createElement:()=>probe},urls:{createObjectURL:file=>{created.push(file);return 'blob:metadata-only';},revokeObjectURL:url=>revoked.push(url)}};
}
test('66 MiB / 7 minute local video imports metadata without a byte buffer or playback',async()=>{
 const {inspectMedia}=await modulePromise;const h=probeHarness();
 const file={size:66*1024*1024,name:'seven-minutes.mp4',arrayBuffer(){throw Error('must not read full file');},stream(){throw Error('must not read full file');}};
 const metadata=await inspectMedia(file,h);
 assert.deepEqual(metadata,{duration:420,width:1920,height:1080});assert.equal(h.probe.preload,'metadata');assert.equal(h.created[0],file);assert.equal(h.probe.play,undefined);assert.deepEqual(h.revoked,['blob:metadata-only']);
});
test('large size / long duration has no arbitrary ceiling',async()=>{
 const {inspectMedia}=await modulePromise;const h=probeHarness({duration:7200});
 assert.equal((await inspectMedia({size:3*1024**3},h)).duration,7200);
});
test('unknown duration can be tracked during actual playback',async()=>{
 const {inspectMedia}=await modulePromise;assert.equal((await inspectMedia({size:66*1024**2},probeHarness({duration:Infinity}))).duration,null);
});
test('quota estimate warns without rejecting a large file',async()=>{
 const {storageAdvice}=await modulePromise;const result=storageAdvice(66*1024**2,{quota:100*1024**2,usage:80*1024**2});
 assert.equal(result.remaining,20*1024**2);assert.match(result.warning,/将尝试写入/);
 assert.match(storageAdvice(300*1024**2,{}).warning,/保存可能较久/);
 assert.equal(storageAdvice(66*1024**2,{}).remaining,null);
});
test('missing/failed storage estimates do not block file imports',async()=>{
 const {estimateStorage}=await modulePromise;assert.deepEqual(await estimateStorage({}),{});assert.deepEqual(await estimateStorage({estimate:async()=>{throw Error('unavailable');}}),{});
});
test('empty and unreadable video files report genuine validation errors',async()=>{
 const {inspectMedia}=await modulePromise;await assert.rejects(inspectMedia({size:0},probeHarness()),/非空/);
 await assert.rejects(inspectMedia({size:66*1024**2},probeHarness({error:true})),/无法读取/);
 await assert.rejects(inspectMedia({size:66*1024**2},probeHarness({width:0,height:0})),/视频画面/);
});
test('metadata cancellation cleans up the blob URL and media element',async()=>{
 const {inspectMedia}=await modulePromise;const controller=new AbortController(),h=probeHarness({pending:true});
 const promise=inspectMedia({size:66*1024**2},{...h,signal:controller.signal});controller.abort();
 await assert.rejects(promise,{name:'AbortError'});assert.equal(h.probe.pauseCount,1);assert.deepEqual(h.revoked,['blob:metadata-only']);
});
test('quota and cancel errors explain old-clip retention',async()=>{
 const {importErrorMessage}=await modulePromise;
 assert.match(importErrorMessage({name:'QuotaExceededError'}),/旧片未被覆盖/);
 assert.match(importErrorMessage({name:'AbortError'}),/已取消导入/);
});
