/// <reference types="node" />
import {describe,it,expect,vi,afterEach} from 'vitest';
import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';import {createHash} from 'node:crypto';
import {createKordocWebEngine,kordocRequestLine,parseKordocResponse,KordocEngineError,type KordocWorkerLike} from './kordoc-web-engine';
import {templateLayout} from './document-templates';
import {roleTemplateFixture} from './document-template-fixture';
/** The real Node worker's response line, the reference the WebView worker is built to match. */
const nodeLine=(input:unknown)=>{const child=spawnSync(process.execPath,['worker.mjs','--once'],{cwd:resolve(process.cwd(),'../kordoc-engine'),input:JSON.stringify(input)+'\n',encoding:'utf8',maxBuffer:32*1024*1024});expect(child.status).toBe(0);return child.stdout.replace(/\n$/,'');};
const code=(fn:()=>unknown)=>{try{fn();}catch(error){return error instanceof KordocEngineError?error.code:String(error);}return 'ok';};
const asyncCode=async(p:Promise<unknown>)=>{try{await p;}catch(error){return error instanceof KordocEngineError?error.code:String(error);}return 'ok';};
afterEach(()=>{vi.useRealTimers();});

describe('requests the window may send (as kordoc_process.rs validate_request)',()=>{
 it('allows only the fixed operations with exactly their fields',()=>{
  expect(code(()=>kordocRequestLine({id:'한글',op:'capabilities'}))).toBe('ok');
  expect(code(()=>kordocRequestLine({id:'x',op:'exec',command:'x'}))).toBe('unsupported_operation');
  expect(code(()=>kordocRequestLine({id:'x',op:'capabilities',path:'x'}))).toBe('invalid_request');
  expect(code(()=>kordocRequestLine({id:'x',op:'generate',template:{},markdown:''}))).toBe('input_limit');
  expect(code(()=>kordocRequestLine({id:'x',op:'generate',template:{},markdown:' \n　'}))).toBe('input_limit');
  expect(code(()=>kordocRequestLine({id:'x',op:'generate',template:[],markdown:'본문'}))).toBe('invalid_request');
  expect(code(()=>kordocRequestLine({id:'x',op:'render',hwpxBase64:'',argv:[]}))).toBe('input_limit');
  expect(code(()=>kordocRequestLine({id:'x',op:'render',hwpxBase64:'UEsDBA==',argv:[]}))).toBe('invalid_request');
  for(const id of ['','a\u0007b','가'.repeat(34),7])expect(code(()=>kordocRequestLine({id,op:'capabilities'}))).toBe('invalid_request');
  expect(code(()=>kordocRequestLine({id:'가'.repeat(33),op:'capabilities'}))).toBe('ok');
  expect(code(()=>kordocRequestLine(['x']))).toBe('invalid_request');
 });
 it('keeps a long document whole and stops at the 16 MiB request limit',()=>{
  const markdown='한글 원문\n'.repeat(50_000)+'END',input={id:'long',op:'generate',template:{},markdown};
  expect(JSON.parse(kordocRequestLine(input))).toEqual(input);
  expect(code(()=>kordocRequestLine({...input,markdown:'가'.repeat(6*1024*1024)}))).toBe('input_limit');
 });
});

describe('responses the window accepts (as kordoc_process.rs parse_response)',()=>{
 const q={id:'x',op:'capabilities'};
 it('binds the response to the request and keeps only the engine rule sentences',async()=>{
  const secret=await parseKordocResponse('{"id":"x","ok":false,"error":{"message":"PRIVATE_DOCUMENT_SECRET"}}',q);
  expect(JSON.stringify(secret)).not.toContain('SECRET');
  expect(secret).toEqual({id:'x',ok:false,error:{code:'document_engine_rejected',message:'문서 엔진이 요청을 처리하지 못했습니다. 입력 형식과 크기를 확인하세요.'}});
  const rule=await parseKordocResponse('{"id":"x","ok":false,"error":{"code":"engine_rule","message":"표지를 만들려면 문서 맨 앞에 제목이 필요합니다."}}',q) as {error:{message:string}};
  expect(rule.error.message).toBe('표지를 만들려면 문서 맨 앞에 제목이 필요합니다.');
  const quoted=await parseKordocResponse('{"id":"x","ok":false,"error":{"code":"engine_rule","message":"docs/PRIVATE_PATH.hwpx"}}',q);
  expect(JSON.stringify(quoted)).not.toContain('PRIVATE_PATH');
  expect(await parseKordocResponse('{"id":"x","ok":false,"error":{"code":"input_limit","message":"x"}}',q)).toMatchObject({error:{code:'input_limit'}});
  expect(await asyncCode(parseKordocResponse('{}\n{}',q))).toBe('invalid_response');
  expect(await asyncCode(parseKordocResponse('{"id":"y"}',q))).toBe('response_mismatch');
  expect(await asyncCode(parseKordocResponse('{"id":"x","ok":true,"result":{"engine":{"name":"kordoc","version":"0.0.1"}}}',q))).toBe('invalid_response');
 });
 it('accepts the real worker output and rejects a changed document or a missing preview',async()=>{
  const template=roleTemplateFixture();template.layout=templateLayout(template);
  const input={id:'gen',op:'generate',template,markdown:template.layout!.sampleMarkdown},line=nodeLine(input);
  expect(await parseKordocResponse(line,input)).toEqual(JSON.parse(line));
  const v=JSON.parse(line);
  const changed={...v,result:{...v.result,sha256:createHash('sha256').update('other').digest('hex')}};
  expect(await asyncCode(parseKordocResponse(JSON.stringify(changed),input))).toBe('document_hash_mismatch');
  const plain=Buffer.from('plain').toString('base64');
  expect(await asyncCode(parseKordocResponse(JSON.stringify({...v,result:{...v.result,hwpxBase64:plain,sha256:createHash('sha256').update('plain').digest('hex')}}),input))).toBe('invalid_document');
  // Base64 Rust's decoder would refuse (unused bits set) is refused here too.
  const loose=Buffer.from('UEsDBB==','base64');
  expect(await asyncCode(parseKordocResponse(JSON.stringify({...v,result:{...v.result,hwpxBase64:'UEsDBB==',sha256:createHash('sha256').update(loose).digest('hex')}}),input))).toBe('invalid_document');
  expect(await asyncCode(parseKordocResponse(JSON.stringify({...v,result:{...v.result,hwpxBase64:'UEsDBA'}}),input))).toBe('invalid_document');
  expect(await asyncCode(parseKordocResponse(JSON.stringify({...v,result:{...v.result,pages:[]}}),input))).toBe('invalid_document');
  expect(await asyncCode(parseKordocResponse(JSON.stringify({...v,result:{...v.result,pages:[{svg:'<svg/>',width:0,height:1}]}}),input))).toBe('invalid_response');
  const capabilities={id:'cap',op:'capabilities'},capLine=nodeLine(capabilities);
  expect(await parseKordocResponse(capLine,capabilities)).toEqual(JSON.parse(capLine));
 });
});

/** A worker standing in for engine-worker.js: answers with the real Node worker's line, or as a test scripts it. */
function fakeWorker(behaviour:{ready?:boolean;answer?:(line:string)=>string|undefined;failOnStart?:boolean}={}){
 const made:Array<KordocWorkerLike&{posted:unknown[];terminated:boolean}>=[];
 const createWorker=()=>{
  const w:KordocWorkerLike&{posted:unknown[];terminated:boolean}={posted:[],terminated:false,onmessage:null,onerror:null,
   postMessage(message){w.posted.push(message);const {seq,line}=message as {seq:number;line:string};const reply=(behaviour.answer??(l=>nodeLine(JSON.parse(l))))(line);if(reply!==undefined)queueMicrotask(()=>w.onmessage?.({data:{seq,line:reply}} as MessageEvent));},
   terminate(){w.terminated=true;}};
  made.push(w);
  queueMicrotask(()=>{if(behaviour.failOnStart)w.onerror?.(new Event('error'));else if(behaviour.ready!==false)w.onmessage?.({data:{ready:true}} as MessageEvent);});
  return w;
 };
 return {made,createWorker};
}

describe('the window worker',()=>{
 it('starts once, answers in order and stops after it has been idle',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const f=fakeWorker(),engine=createKordocWebEngine({createWorker:f.createWorker,idleMs:1000});
  const a=await engine.request({id:'a',op:'capabilities'}) as {id:string;ok:boolean},b=await engine.request({id:'b',op:'capabilities'}) as {id:string};
  expect([a.id,a.ok,b.id]).toEqual(['a',true,'b']);expect(f.made).toHaveLength(1);expect(f.made[0].posted).toHaveLength(2);
  vi.advanceTimersByTime(1001);expect(f.made[0].terminated).toBe(true);
  await engine.request({id:'c',op:'capabilities'});expect(f.made).toHaveLength(2);
 });
 it('reports a worker that cannot start, and the next request tries a new one',async()=>{
  const broken=fakeWorker({failOnStart:true}),engine=createKordocWebEngine({createWorker:broken.createWorker});
  expect(await asyncCode(engine.request({id:'a',op:'capabilities'}))).toBe('worker_unavailable');
  expect(await asyncCode(engine.request({id:'b',op:'capabilities'}))).toBe('worker_unavailable');expect(broken.made).toHaveLength(2);
  const missing=createKordocWebEngine({createWorker:()=>{throw Error('no Worker');}});
  expect(await asyncCode(missing.request({id:'a',op:'capabilities'}))).toBe('worker_unavailable');
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const silent=fakeWorker({ready:false}),waiting=createKordocWebEngine({createWorker:silent.createWorker,startMs:500}),pending=asyncCode(waiting.request({id:'a',op:'capabilities'}));
  await vi.advanceTimersByTimeAsync(501);expect(await pending).toBe('worker_unavailable');expect(silent.made[0].terminated).toBe(true);
 });
 it('stops a stuck worker at the time limit and checks requests before sending them',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const stuck=fakeWorker({answer:()=>undefined}),engine=createKordocWebEngine({createWorker:stuck.createWorker,timeoutMs:2000});
  const pending=asyncCode(engine.request({id:'a',op:'capabilities'}));await vi.advanceTimersByTimeAsync(2001);
  expect(await pending).toBe('worker_timeout');expect(stuck.made[0].terminated).toBe(true);
  expect(await asyncCode(engine.request({id:'x',op:'exec'}))).toBe('unsupported_operation');expect(stuck.made).toHaveLength(1);
 });
 it('starts the worker from a blob of the same script when the script URL is refused, and keeps that way',async()=>{
  const made:Array<{url:string}>=[];
  // Messages arrive as tasks (setImmediate), the way a real worker's do, after the page has attached its handlers.
  class FakeWorker{onmessage:((e:MessageEvent)=>void)|null=null;onerror:((e:Event)=>void)|null=null;url:string;
   constructor(url:unknown){this.url=String(url);made.push(this);setImmediate(()=>{if(this.url.startsWith('blob:'))this.onmessage?.({data:{ready:true}} as MessageEvent);else this.onerror?.(new Event('error'));});}
   postMessage(message:unknown){const {seq,line}=message as {seq:number;line:string};const reply=nodeLine(JSON.parse(line));setImmediate(()=>this.onmessage?.({data:{seq,line:reply}} as MessageEvent));}
   terminate(){}}
  const fetchMock=vi.fn(async()=>new Response('self.onmessage=null;'));const revoke=vi.spyOn(URL,'revokeObjectURL');
  vi.stubGlobal('Worker',FakeWorker);vi.stubGlobal('document',{baseURI:'tauri://localhost/'});vi.stubGlobal('fetch',fetchMock);
  try{
   vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
   const engine=createKordocWebEngine({idleMs:1000});
   expect(await engine.request({id:'a',op:'capabilities'})).toMatchObject({id:'a',ok:true});
   expect(made.map(w=>w.url.startsWith('blob:'))).toEqual([false,true]);expect(made[0].url).toBe('tauri://localhost/kordoc/engine-worker.js');
   expect(fetchMock).toHaveBeenCalledTimes(1);expect(revoke).toHaveBeenCalledWith(made[1].url);
   vi.advanceTimersByTime(1001);await engine.request({id:'b',op:'capabilities'});
   expect(made.map(w=>w.url.startsWith('blob:'))).toEqual([false,true,true]);expect(fetchMock).toHaveBeenCalledTimes(2);
  }finally{vi.unstubAllGlobals();}
 });
 it('fails a request in flight when the worker crashes, and ignores answers to other requests',async()=>{
  let crash:(()=>void)|undefined;
  const f=fakeWorker({answer:line=>{const id=JSON.parse(line).id;if(id==='other')return JSON.stringify({id:'stray',ok:true});crash=()=>f.made[0].onerror?.(new Event('error'));return undefined;}}),engine=createKordocWebEngine({createWorker:f.createWorker});
  const pending=asyncCode(engine.request({id:'a',op:'capabilities'}));await vi.waitFor(()=>expect(crash).toBeDefined());crash!();
  expect(await pending).toBe('worker_io');
  f.made[0].onmessage?.({data:{seq:99,line:'{}'}} as MessageEvent);
 });
});
