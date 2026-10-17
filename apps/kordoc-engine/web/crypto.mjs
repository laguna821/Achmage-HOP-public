// node:crypto for the WebView worker: synchronous createHash for the two digests Kordoc uses (sha1, sha256).
// Its cipher and key-derivation imports belong to Kordoc's reading of protected documents, which packaging leaves out
// of the bundles (prepare-kordoc-runtime.mjs); they stay only so the imports resolve.
import { sha256 } from '@noble/hashes/sha2.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { unavailable } from './unavailable.mjs';

const ALGORITHMS={sha256,sha1},utf8=new TextEncoder();
function bytes(data,encoding){
 if(typeof data==='string')return !encoding||/^utf-?8$/i.test(encoding)?utf8.encode(data):Buffer.from(data,encoding);
 if(data instanceof Uint8Array)return data;
 if(ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
 if(data instanceof ArrayBuffer)return new Uint8Array(data);
 throw new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.');
}
export function createHash(algorithm){
 const make=ALGORITHMS[String(algorithm).toLowerCase()];
 if(!make)throw new Error('Digest method not supported');
 const hash=make.create();let finished=false;
 return {
  update(data,encoding){if(finished)throw new Error('Digest already called');hash.update(bytes(data,encoding));return this;},
  digest(encoding){if(finished)throw new Error('Digest already called');finished=true;const out=Buffer.from(hash.digest());return encoding?out.toString(encoding):out;},
 };
}
export const createCipheriv=/* @__PURE__ */unavailable('crypto.createCipheriv'),createDecipheriv=/* @__PURE__ */unavailable('crypto.createDecipheriv'),pbkdf2Sync=/* @__PURE__ */unavailable('crypto.pbkdf2Sync'),timingSafeEqual=/* @__PURE__ */unavailable('crypto.timingSafeEqual'),randomUUID=/* @__PURE__ */unavailable('crypto.randomUUID');
export default {createHash,createCipheriv,createDecipheriv,pbkdf2Sync,timingSafeEqual,randomUUID};
