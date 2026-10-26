const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = path.resolve(__dirname,'../extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
if (manifest.manifest_version !== 3) throw Error('Expected Manifest V3');
for (const file of fs.readdirSync(root).filter(x=>x.endsWith('.js'))) cp.execFileSync(process.execPath,['--check',path.join(root,file)],{stdio:'inherit'});
for (const file of [manifest.background.service_worker,manifest.action.default_popup,manifest.options_page,...manifest.content_scripts.flatMap(x=>x.js),...manifest.web_accessible_resources.flatMap(x=>x.resources),...Object.values(manifest.icons),'videos/default.mp4']) if(!fs.statSync(path.join(root,file)).size) throw Error(`Missing ${file}`);
console.log('All JavaScript parses; manifest references and bundled clip verified.');
