const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const results = [];
async function run(name, task) { await task(); results.push(name); console.log('PASS',name); }
(async()=>{
 const server = http.createServer((req,res)=>{
  const file = req.url.startsWith('/demo.mp4') ? path.join(root,'extension/videos/default.mp4') : path.join(__dirname,'fixture.html');
  res.setHeader('Content-Type',file.endsWith('.mp4')?'video/mp4':'text/html');
  res.end(fs.readFileSync(file));
 }).listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));
 const origin = `http://127.0.0.1:${server.address().port}`;
 const userData = fs.mkdtempSync(path.join(os.tmpdir(),'video-prank-test-'));
 let context;
 try {
  context = await chromium.launchPersistentContext(userData,{headless:true,executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',viewport:{width:1100,height:900},args:['--no-sandbox',`--disable-extensions-except=${path.join(root,'extension')}`,`--load-extension=${path.join(root,'extension')}`]});
 } catch(error) {
  server.close();fs.rmSync(userData,{recursive:true,force:true});
  console.error('Browser launch failed before any integration test ran:',error.message);process.exitCode=1;return;
 }
 let page, options;
 try {
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForSelector('#preview');
  await options.waitForFunction(()=>document.getElementById('preview').readyState>=2);
  const config = async patch => options.evaluate(async patch=>{ const {settings}=await chrome.storage.local.get('settings'); await chrome.storage.local.set({settings:{...settings,...patch}}); },patch);
  await config({enabled:true,minDelay:1,maxDelay:1,probability:100,cooldown:0,oncePerVideo:true,autoResume:true});
  page = await context.newPage();
  page.on('console',m=>{ if(m.type()==='error' || m.text().includes('半路')) console.log('PAGE',m.type(),m.text()); });
  page.on('pageerror',e=>console.log('PAGEERROR',e.message));
  await page.goto(origin);
  const playerFrame = async()=>{ for(let i=0;i<100;i++){const f=page.frames().find(f=>f.url().includes('/player.html'));if(f) return f;await sleep(100);}throw Error('Extension player frame missing');};
  const frame = await playerFrame();
  frame.on?.('console',()=>{});
  await frame.waitForFunction(()=>document.querySelector('video').readyState>=1);
  const active = () => page.evaluate(()=>document.querySelector('[data-video-prank-host]')?.matches(':popover-open') || false);
  const waitActive = () => page.waitForFunction(()=>document.querySelector('[data-video-prank-host]')?.matches(':popover-open'),null,{timeout:10000});
  const waitIdle = () => page.waitForFunction(()=>!document.querySelector('[data-video-prank-host]')?.matches(':popover-open'),null,{timeout:10000});
  const restart = async()=>{await page.reload();await playerFrame();await page.click('#play');};
  await run('preloads bundled media in isolated extension frame',async()=>{assert.equal(await frame.evaluate(()=>document.querySelector('video').paused),true);assert.equal(await active(),false);});
  await run('random trigger pauses/mutes original and overlays exact video box without layout/navigation',async()=>{
    const before = await page.evaluate(()=>({url:location.href,after:document.getElementById('after').getBoundingClientRect().y}));
    await page.evaluate(()=>{main.volume=0.37;main.muted=false;});
    await page.click('#play');await waitActive();
    const state=await page.evaluate(()=>{const v=main.getBoundingClientRect(),h=document.querySelector('[data-video-prank-host]').getBoundingClientRect();return {paused:main.paused,muted:main.muted,url:location.href,after:document.getElementById('after').getBoundingClientRect().y,v:[v.x,v.y,v.width,v.height],h:[h.x,h.y,h.width,h.height]};});
    assert.equal(state.paused,true);assert.equal(state.muted,true);assert.equal(state.url,before.url);assert.equal(state.after,before.after);assert.deepEqual(state.h,state.v);
    assert.equal(await frame.evaluate(()=>document.querySelector('video').volume),0.37);
  });
  await run('clip end holds final frame and original remains paused',async()=>{await frame.waitForFunction(()=>document.querySelector('video').ended);const s=await page.evaluate(()=>({paused:main.paused,muted:main.muted,volume:main.volume}));assert.deepEqual(s,{paused:true,muted:true,volume:0.37});assert.equal(await active(),true);assert.equal(await frame.locator('#restore').count(),0);await frame.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));await waitIdle();});
  await run('once-per-video prevents repeated automatic triggers',async()=>{await sleep(2200);assert.equal(await active(),false);});
  await run('local import persists and reloads extension player',async()=>{
    await options.bringToFront();
    await options.locator('#file').setInputFiles(path.join(root,'extension/videos/default.mp4'));
    await options.waitForFunction(()=>document.getElementById('file-status').textContent.includes('视频已替换'));
    assert.match(await options.locator('#clip-name').textContent(),/default.mp4/);
    await options.reload();await options.waitForFunction(()=>document.getElementById('preview').src.startsWith('blob:'));
    await page.bringToFront();await restart();const f=await playerFrame();await f.waitForFunction(()=>document.querySelector('video').src.startsWith('blob:'));await waitActive();
    assert.equal(await f.evaluate(()=>document.querySelector('video').src.startsWith('blob:')),true);
  });
  await run('keyboard safety escape cancels clip and preserves page',async()=>{const f=await playerFrame();await f.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));await waitIdle();assert.equal(await page.evaluate(()=>main.muted),false);assert.equal(page.url(),origin+'/');});
  await run('disabled setting restores active clip and suppresses triggers',async()=>{await restart();await waitActive();await config({enabled:false});await waitIdle();await sleep(1500);assert.equal(await active(),false);assert.equal(await page.evaluate(()=>main.muted),false);});
  await config({enabled:true});
  await run('SPA URL/source replacement cleans up without resuming stale video',async()=>{await restart();await waitActive();await page.evaluate(()=>{history.pushState({},'', '/next');main.pause();main.src='/demo.mp4?v=2';});await waitIdle();assert.equal(await page.evaluate(()=>main.muted),false);assert.equal(page.url(),origin+'/next');await page.click('#play');await waitActive();const f=await playerFrame();await f.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));});
  await run('removed video releases overlay and mute',async()=>{await restart();await waitActive();await page.evaluate(()=>{window.oldVideo=main;main.remove();});await waitIdle();assert.equal(await page.evaluate(()=>oldVideo.muted),false);});
  await run('tiny, hidden, and marked-ad videos never trigger',async()=>{await page.reload();await page.evaluate(()=>{main.remove();small.play();ad.play();hidden.play();});await sleep(2500);assert.equal(await active(),false);});
  await run('zero probability never auto-triggers',async()=>{await config({probability:0});await restart();await sleep(2200);assert.equal(await active(),false);});
  await config({probability:100});
  await run('keyboard restore handles Escape',async()=>{await restart();await waitActive();await page.keyboard.press('Escape');await waitIdle();assert.equal(await page.evaluate(()=>main.muted),false);});
  await run('container fullscreen retains localized overlay',async()=>{await restart();await page.click('#full');await waitActive();assert.equal(await page.evaluate(()=>document.fullscreenElement?.id),'player');await page.evaluate(()=>document.exitFullscreen());await page.keyboard.press('Escape');await waitIdle();});
  await options.bringToFront();await options.screenshot({path:path.join(root,'tests/options.png'),fullPage:true});
  fs.writeFileSync(path.join(root,'tests/browser-results.json'),JSON.stringify({browser:await context.browser()?.version(),passed:results,autoplayPolicy:'Browser default; no autoplay bypass flags.',realSites:'Not tested'},null,2));
  console.log(`\n${results.length} browser tests passed.`);
 } catch(error) {
  console.error(error);
  if(page) {console.log('FRAMES',page.frames().map(f=>f.url()));console.log('STATE',await page.evaluate(()=>({host:document.querySelector('[data-video-prank-host]')?.outerHTML,video:document.querySelector('video')?.outerHTML})).catch(()=>null));await page.screenshot({path:path.join(root,'tests/failure.png')}).catch(()=>{});}
  process.exitCode=1;
 } finally {await context.close();server.close();fs.rmSync(userData,{recursive:true,force:true});}
})();
