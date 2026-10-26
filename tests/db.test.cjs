const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../extension/db.js'),'utf8').replaceAll('export ','')+'\nglobalThis.api={readClip,writeClip,deleteClip};';
function setup(mode='success'){
 const old={name:'old.webm',blob:{size:123}},state={current:old,pending:null,closed:0,transaction:null};
 const db={close(){state.closed++;},transaction(){
  let aborted=false,request;const tx={error:null,objectStore(){return {get(){request={result:state.current};queueMicrotask(()=>tx.oncomplete?.());return request;},put(value){state.pending=value;request={};if(mode!=='pending')queueMicrotask(()=>{if(aborted)return;if(mode==='quota'){const error=new DOMException('quota','QuotaExceededError');tx.error=error;tx.onerror?.({target:{error}});tx.abort();}else{state.current=value;tx.oncomplete?.();}});return request;}};},abort(){if(aborted)return;aborted=true;queueMicrotask(()=>tx.onabort?.());}};
  state.transaction=tx;return tx;
 }};
 const indexedDB={open(){const request={result:db};queueMicrotask(()=>request.onsuccess?.());return request;}};
 const context=vm.createContext({indexedDB,DOMException});vm.runInContext(source,context);return {...context.api,state,old};
}
test('66 MiB Blob handle is written directly without full-byte conversion',async()=>{
 const h=setup(),blob={size:66*1024**2,arrayBuffer(){throw Error('full copy');}},clip={blob,duration:420};await h.writeClip(clip);
 assert.equal(h.state.current,clip);assert.equal(h.state.pending.blob,blob);assert.equal(h.state.closed,1);
});
test('quota failure aborts replacement and preserves previous clip',async()=>{
 const h=setup('quota');await assert.rejects(h.writeClip({name:'66MB.mp4'}),{name:'QuotaExceededError'});assert.equal(h.state.current,h.old);assert.equal(h.state.closed,1);
});
test('cancelling an uncommitted write preserves previous clip',async()=>{
 const h=setup('pending'),controller=new AbortController();const result=h.writeClip({name:'new.mp4'},{signal:controller.signal});await Promise.resolve();await Promise.resolve();controller.abort();
 await assert.rejects(result,{name:'AbortError'});assert.equal(h.state.current,h.old);
});
test('already-cancelled writes do not open a transaction',async()=>{
 const h=setup(),controller=new AbortController();controller.abort();await assert.rejects(h.writeClip({},{signal:controller.signal}),{name:'AbortError'});assert.equal(h.state.transaction,null);assert.equal(h.state.current,h.old);
});
