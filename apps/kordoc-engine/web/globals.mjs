// Node globals the Kordoc closure reads, installed in the WebView worker before any engine module is evaluated.
import { Buffer } from 'buffer/index.js';
import process from './process.mjs';

// Vendor warnings must never log document content: every console method is silent before the engine loads.
for(const name of Object.keys(console))if(typeof console[name]==='function')console[name]=()=>{};
globalThis.global??=globalThis;
globalThis.Buffer??=Buffer;
globalThis.process??=process;
