// The Kordoc engine in a Web Worker of this window: kordoc/engine-worker.js, which prepare-kordoc-runtime.mjs builds
// from the same audited closure as the Node worker and checks against it line for line. Requests and responses get
// the checks, and errors the wording, that the desktop side gave the Node worker (kordoc_process.rs, kordoc.rs).
const INPUT_LIMIT=16*1024*1024,OUTPUT_LIMIT=32*1024*1024,FILE_LIMIT=32*1024*1024,ENGINE_VERSION='4.21.31';
/** A long document with its page previews takes longer than a short one; this only stops a stuck worker. */
const TIMEOUT_MS=300_000,START_MS=15_000,IDLE_MS=120_000;
export const KORDOC_WORKER_URL='kordoc/engine-worker.js';
const MESSAGES:Record<string,string>={
 worker_unavailable:'앱에 들어 있는 문서 엔진을 시작하지 못했습니다. 앱 설치 구성을 확인하세요.',
 cancelled:'문서창이 닫혀 생성 작업을 취소했습니다.',
 worker_timeout:'문서 생성이 5분 안에 끝나지 않아 멈췄습니다. 다시 시도하거나 문서를 나눠 만드세요.',
 input_limit:'문서 요청 또는 결과가 처리 크기 제한을 넘었습니다.',response_limit:'문서 요청 또는 결과가 처리 크기 제한을 넘었습니다.',
 invalid_document:'생성 문서의 형식 또는 무결성을 확인하지 못했습니다.',document_hash_mismatch:'생성 문서의 형식 또는 무결성을 확인하지 못했습니다.',
 invalid_request:'문서 생성 요청 형식이 올바르지 않습니다.',unsupported_operation:'문서 생성 요청 형식이 올바르지 않습니다.',
};
const FALLBACK_MESSAGE='문서 생성 엔진의 응답을 확인하지 못했습니다. 요청을 다시 확인하세요.';
export class KordocEngineError extends Error{constructor(readonly code:string){super(MESSAGES[code]??FALLBACK_MESSAGE);this.name='KordocEngineError';}}
const fail=(code:string):never=>{throw new KordocEngineError(code);};
const utf8=new TextEncoder(),byteLength=(s:string)=>utf8.encode(s).length;
const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const BASE64_ALPHABET=/^[A-Za-z0-9+/]*={0,2}$/,SIX_BITS='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Strict, canonical base64 as Rust's STANDARD engine reads it (padding required, unused bits zero), without running
 * a repeating regular expression over a string of up to 43 MB. */
function canonicalBase64(data:string):boolean{
 if(data.length%4!==0||!BASE64_ALPHABET.test(data))return false;
 const pad=data.endsWith('==')?2:data.endsWith('=')?1:0;if(!pad)return true;
 const last=SIX_BITS.indexOf(data[data.length-pad-1]!);return pad===2?(last&15)===0:(last&3)===0;
}

/** The request as the line the worker reads, after the checks kordoc_process.rs `validate_request` makes. */
export function kordocRequestLine(input:unknown):string{
 if(!isObject(input))fail('invalid_request');const o=input as Record<string,unknown>,id=o.id;
 if(typeof id!=='string'||!id||byteLength(id)>100||/\p{Cc}/u.test(id))fail('invalid_request');
 let fields:string[];
 if(o.op==='capabilities')fields=['id','op'];
 else if(o.op==='generate'){if(!isObject(o.template)||typeof o.markdown!=='string')fail('invalid_request');if(/^\p{White_Space}*$/u.test(o.markdown as string))fail('input_limit');fields=['id','op','template','markdown'];}
 else if(o.op==='render'||o.op==='validate'){if(typeof o.hwpxBase64!=='string')fail('invalid_request');const data=o.hwpxBase64 as string;if(!data||byteLength(data)>12*1024*1024)fail('input_limit');fields=['id','op','hwpxBase64'];}
 else return fail('unsupported_operation');
 const keys=Object.keys(o);if(keys.length!==fields.length||fields.some(key=>!keys.includes(key)))fail('invalid_request');
 const line=JSON.stringify(o);if(byteLength(line)>INPUT_LIMIT)fail('input_limit');return line;
}
async function verifyDocument(data:unknown,expected:unknown):Promise<void>{
 if(typeof data!=='string'||typeof expected!=='string'||data.length>Math.ceil(FILE_LIMIT/3)*4||!/^[0-9a-f]{64}$/.test(expected)||!canonicalBase64(data))fail('invalid_document');
 let raw:string;try{raw=atob(data as string);}catch{return fail('invalid_document');}
 const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
 if(bytes.length>FILE_LIMIT||bytes[0]!==0x50||bytes[1]!==0x4b||bytes[2]!==3||bytes[3]!==4)fail('invalid_document');
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 if(digest!==expected)fail('document_hash_mismatch');
}
/** The worker's response line as the window may use it (kordoc_process.rs `parse_response`): bound to the request,
 * from the pinned engine, a generated document verified, and a refusal reduced to the engine's own rule sentence or a
 * fixed message (other exception text may carry document content or paths). */
export async function parseKordocResponse(line:string,input:Record<string,unknown>):Promise<unknown>{
 if(byteLength(line)+1>OUTPUT_LIMIT)fail('invalid_response');
 let v:unknown;try{v=JSON.parse(line);}catch{return fail('invalid_response');}
 const r=isObject(v)?v:{};
 if(r.id!==input.id)fail('response_mismatch');
 if(r.ok===false){
  const error=isObject(r.error)?r.error:{},reason=error.message;
  if(error.code==='engine_rule'&&typeof reason==='string'&&Array.from(reason).length<=200&&!/[/\\<\n]/.test(reason))return {id:input.id,ok:false,error:{code:'engine_rule',message:reason}};
  const code=error.code==='input_limit'||error.code==='response_limit'?error.code:'document_engine_rejected';
  return {id:input.id,ok:false,error:{code,message:'문서 엔진이 요청을 처리하지 못했습니다. 입력 형식과 크기를 확인하세요.'}};
 }
 const result=isObject(r.result)?r.result:{},engine=isObject(result.engine)?result.engine:{};
 if(r.ok!==true||engine.name!=='kordoc'||engine.version!==ENGINE_VERSION)fail('invalid_response');
 if(input.op==='generate'||input.op==='render'){
  await verifyDocument(result.hwpxBase64,result.sha256);
  const pages=result.pages,validation=isObject(result.validation)?result.validation:{};
  if(!Array.isArray(pages))fail('invalid_response');
  if(!(pages as unknown[]).length||(pages as unknown[]).length>100||validation.ok!==true)fail('invalid_document');
  if((pages as unknown[]).some(p=>!isObject(p)||typeof p.svg!=='string'||!(typeof p.width==='number'&&p.width>0)||!(typeof p.height==='number'&&p.height>0)))fail('invalid_response');
 }
 return v;
}

export interface KordocWorkerLike{postMessage(message:unknown):void;terminate():void;onmessage:((event:MessageEvent)=>void)|null;onerror:((event:Event)=>void)|null}
export interface KordocWebEngine{request(input:Record<string,unknown>):Promise<unknown>;dispose():void}
interface Launched{worker:KordocWorkerLike;loaded?:()=>void}
const scriptUrl=()=>new URL(KORDOC_WORKER_URL,document.baseURI);
/** A WebView may refuse a worker script served from the app's own custom scheme (tauri:// on macOS and Linux). The same
 * script as a blob: URL runs as a worker of the page's origin, which the app's CSP allows (worker-src 'self' blob:). */
async function blobWorker():Promise<Launched>{
 const response=await fetch(scriptUrl());if(!response.ok)throw Error('worker script');
 const url=URL.createObjectURL(new Blob([await response.text()],{type:'text/javascript'}));
 try{return {worker:new Worker(url) as unknown as KordocWorkerLike,loaded:()=>URL.revokeObjectURL(url)};}catch(error){URL.revokeObjectURL(url);throw error;}
}
/** One worker, started on the first request and stopped after two idle minutes (a stopped worker frees the engine's
 * memory; starting again takes a fraction of a second). A stuck request stops the worker. A worker that cannot start
 * from the script URL is started once more from a blob of the same script, and that way is kept. */
export function createKordocWebEngine({createWorker,timeoutMs=TIMEOUT_MS,startMs=START_MS,idleMs=IDLE_MS}:{createWorker?:()=>KordocWorkerLike;timeoutMs?:number;startMs?:number;idleMs?:number}={}):KordocWebEngine{
 let worker:KordocWorkerLike|undefined,ready:Promise<void>|undefined,seq=0,idle:ReturnType<typeof setTimeout>|undefined;
 // Created synchronously where possible, so the worker's first message always finds its handlers.
 const ways:Array<()=>Launched|Promise<Launched>>=createWorker?[()=>({worker:createWorker()})]:[()=>({worker:new Worker(scriptUrl()) as unknown as KordocWorkerLike}),blobWorker];
 let way=0;
 const waiting=new Map<number,{resolve:(line:string)=>void;reject:(error:Error)=>void}>();
 function stop(error:Error){clearTimeout(idle);idle=undefined;worker?.terminate();worker=undefined;ready=undefined;const entries=[...waiting.values()];waiting.clear();for(const entry of entries)entry.reject(error);}
 async function launch(make:()=>Launched|Promise<Launched>):Promise<void>{
  let launched:Launched;try{const made=make();launched=made instanceof Promise?await made:made;}catch{throw new KordocEngineError('worker_unavailable');}
  const w=launched.worker;worker=w;
  return new Promise<void>((resolve,reject)=>{
   let started=false;
   // No request waits on a worker that has not started, so only this worker goes; `ready` is left to start().
   const timer=setTimeout(()=>{launched.loaded?.();if(worker===w){w.terminate();worker=undefined;}reject(new KordocEngineError('worker_unavailable'));},startMs);
   w.onmessage=event=>{if(worker!==w)return;const data=event.data as {ready?:unknown;seq?:unknown;line?:unknown};if(data?.ready===true){started=true;clearTimeout(timer);launched.loaded?.();resolve();return;}const entry=waiting.get(data?.seq as number);if(entry&&typeof data.line==='string'){waiting.delete(data.seq as number);entry.resolve(data.line);}};
   w.onerror=event=>{if(worker!==w)return;event.preventDefault?.();clearTimeout(timer);if(started){stop(new KordocEngineError('worker_io'));return;}launched.loaded?.();w.terminate();worker=undefined;reject(new KordocEngineError('worker_unavailable'));};
  });
 }
 function start():Promise<void>{
  if(ready)return ready;
  const starting=(async()=>{for(;;){try{await launch(ways[way]!);return;}catch(error){if(way+1<ways.length&&error instanceof KordocEngineError&&error.code==='worker_unavailable'){way++;continue;}throw error;}}})();
  ready=starting;starting.catch(()=>{if(ready===starting)ready=undefined;});return starting;
 }
 async function request(input:Record<string,unknown>):Promise<unknown>{
  const line=kordocRequestLine(input);
  await start();
  clearTimeout(idle);idle=undefined;
  const current=worker!,s=++seq;
  const reply=await new Promise<string>((resolve,reject)=>{
   const timer=setTimeout(()=>{waiting.delete(s);stop(new KordocEngineError('worker_timeout'));reject(new KordocEngineError('worker_timeout'));},timeoutMs);
   waiting.set(s,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
   current.postMessage({seq:s,line});
  });
  if(!waiting.size&&worker===current)idle=setTimeout(()=>{if(!waiting.size)stop(new KordocEngineError('cancelled'));},idleMs);
  return parseKordocResponse(reply,input);
 }
 return {request,dispose:()=>stop(new KordocEngineError('cancelled'))};
}
