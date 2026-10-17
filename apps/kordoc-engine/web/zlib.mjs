// node:zlib inflateSync/inflateRawSync for the WebView worker, on pako's zlib port (the one JSZip already uses).
// Keeps the Node behaviour the closure relies on: maxOutputLength stops inflating as soon as it is passed (a
// decompression bomb never fills memory), a truncated stream is an error ("unexpected end of file"), and bytes
// after the end of the stream are ignored. Kordoc's deflate imports serve document writing paths that the engine's
// requests never reach; pako's deflate output differs from Node's, so it is not offered in their place.
import inflateLib from 'pako/lib/zlib/inflate.js';
import ZStream from 'pako/lib/zlib/zstream.js';
import { unavailable } from './unavailable.mjs';

const Z_OK=0,Z_STREAM_END=1,Z_NEED_DICT=2,Z_BUF_ERROR=-5,Z_FINISH=4;
const CODES={[-2]:'Z_STREAM_ERROR',[-3]:'Z_DATA_ERROR',[-4]:'Z_MEM_ERROR',[-5]:'Z_BUF_ERROR',[2]:'Z_NEED_DICT'};
const zlibError=(message,errno)=>Object.assign(new Error(message),{errno,code:CODES[errno]??'Z_ERROR'});
function input(data){
 if(typeof data==='string')return Buffer.from(data);
 if(data instanceof Uint8Array)return data;
 if(ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
 if(data instanceof ArrayBuffer)return new Uint8Array(data);
 throw new TypeError('The "buffer" argument must be of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer.');
}
function inflate(data,options,windowBits){
 const source=input(data),limit=options?.maxOutputLength??Number.MAX_SAFE_INTEGER,chunkSize=Math.max(64,options?.chunkSize??16*1024);
 const strm=new ZStream();let status=inflateLib.inflateInit2(strm,windowBits);
 if(status!==Z_OK)throw zlibError(strm.msg||'Init error',status);
 strm.input=source;strm.next_in=0;strm.avail_in=source.length;
 const chunks=[];let total=0;
 try{
  for(;;){
   const out=new Uint8Array(chunkSize);strm.output=out;strm.next_out=0;strm.avail_out=chunkSize;
   status=inflateLib.inflate(strm,Z_FINISH);
   const produced=chunkSize-strm.avail_out;
   if(produced){total+=produced;if(total>limit)throw Object.assign(new RangeError(`Cannot create a Buffer larger than ${limit} bytes`),{code:'ERR_BUFFER_TOO_LARGE'});chunks.push(produced===chunkSize?out:out.subarray(0,produced));}
   if(status===Z_STREAM_END)break;
   if(status===Z_NEED_DICT)throw zlibError('Missing dictionary',Z_NEED_DICT);
   // With Z_FINISH, zlib reports Z_BUF_ERROR both for "output full, call again" and for "input ran out".
   if(status===Z_BUF_ERROR){if(strm.avail_out===0)continue;throw zlibError('unexpected end of file',Z_BUF_ERROR);}
   if(status<0)throw zlibError(strm.msg||'zlib error',status);
  }
 }finally{inflateLib.inflateEnd(strm);}
 return Buffer.concat(chunks,total);
}
export const inflateSync=(data,options)=>inflate(data,options,15);
export const inflateRawSync=(data,options)=>inflate(data,options,-15);
export const deflateRawSync=/* @__PURE__ */unavailable('zlib.deflateRawSync'),deflateSync=/* @__PURE__ */unavailable('zlib.deflateSync');
export const constants={Z_NO_FLUSH:0,Z_PARTIAL_FLUSH:1,Z_SYNC_FLUSH:2,Z_FULL_FLUSH:3,Z_FINISH:4,Z_BLOCK:5,Z_OK:0,Z_STREAM_END:1,Z_NEED_DICT:2,Z_ERRNO:-1,Z_STREAM_ERROR:-2,Z_DATA_ERROR:-3,Z_MEM_ERROR:-4,Z_BUF_ERROR:-5,Z_VERSION_ERROR:-6};
export default {inflateSync,inflateRawSync,deflateRawSync,deflateSync,constants};
