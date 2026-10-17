// Runs the WebView Kordoc worker bundle the way a browser worker sees it: Node's Buffer, process and global are
// removed first, so the bundle must bring its own; only web platform globals remain (TextEncoder, crypto.subtle,
// timers, structuredClone). Reads a JSON array of request lines on stdin and writes the response lines as a JSON array.
// Usage (prepare-kordoc-runtime.mjs): node scripts/achmage/kordoc-web-check.mjs <kordoc-web/engine-worker.js>
import fs from 'node:fs';

const {stdin,stdout}=process;
const code=fs.readFileSync(process.argv[2],'utf8');
let text='';for await(const chunk of stdin)text+=chunk;
const lines=JSON.parse(text);
for(const name of ['Buffer','process','global'])delete globalThis[name];
const waiting=new Map();let ready;const started=new Promise(resolve=>{ready=resolve;});
globalThis.self=globalThis;
globalThis.postMessage=data=>{if(data.ready)ready();else waiting.get(data.seq)?.(data.line);};
(0,eval)(code);
await started;
const out=[];
for(const [seq,line] of lines.entries())out.push(await new Promise(resolve=>{waiting.set(seq,resolve);globalThis.onmessage({data:{seq,line}});}));
stdout.write(JSON.stringify(out));
