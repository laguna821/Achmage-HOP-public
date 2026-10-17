// Kordoc engine as a WebView Web Worker: the same request and response lines as worker.mjs, carried by postMessage
// ({seq,line} in, {seq,line} out) instead of stdin/stdout. prepare-kordoc-runtime.mjs bundles it for the browser
// with the Node built-in replacements in web/.
import './web/globals.mjs';
import { LIMITS } from './engine.mjs';
import { respond,inputLimit } from './respond.mjs';

const utf8=new TextEncoder();
self.onmessage=async({data})=>{if(!data||typeof data.line!=='string')return;const line=utf8.encode(data.line).length>LIMITS.inputBytes?inputLimit():await respond(data.line);self.postMessage({seq:data.seq,line});};
self.postMessage({ready:true});
