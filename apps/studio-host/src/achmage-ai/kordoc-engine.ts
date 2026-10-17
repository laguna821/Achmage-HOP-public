import { invoke } from '@tauri-apps/api/core';
import { showToast } from '@/ui/toast';
import { parseDocumentTemplate, templateLayout, type DocumentTemplate } from './document-templates';
import { createKordocWebEngine, KordocEngineError, type KordocWebEngine } from './kordoc-web-engine';

export interface KordocPage {svg:string;width:number;height:number}
export interface KordocDocument {engine:{name:'kordoc';version:'4.21.31';sourceCommit:string};hwpxBase64:string;sha256:string;pages:KordocPage[];/** Whole document; `pages` previews at most the first 100. */pageCount?:number;warnings:string[];validation:{ok:boolean;issues:unknown[];entryCount:number};fontFamilies:string[];fontFamiliesScope:'all-language-font-references-of-used-run-charPr'}
export interface KordocAgency {name:string;reportAvailable:boolean;pressAvailable:boolean;reportUsesCommonFallback:boolean;style:{report:Record<string,unknown>|null;press:Record<string,unknown>|null;band:Record<string,unknown>|null};fontFamilies:string[];fontFamiliesByPreset:Record<string,string[]>;fontFamiliesScope:'agency-declared-including-common-fallback-not-all-preset-fonts'}
export interface KordocCapabilities {engine:{name:string;version:string;sourceCommit:string};presets:string[];coverPresets:string[];tocPresets:string[];coverTocPresets:string[];agencyPresets:string[];agencies:KordocAgency[];agencyRoleOverrides:string[];tocPageNumbers:boolean;ocr:boolean;network:boolean}
export type KordocTransport=(input:Record<string,unknown>)=>Promise<unknown>;
let queueTail:Promise<void>=Promise.resolve(),queued=0,web:KordocWebEngine|undefined,nodeFallback=false;
/** The engine runs in this window's worker. Only if that worker cannot start at all does this test build fall back
 * to the Node runtime still installed with the app, and it says so once. */
async function engineRequest(input:Record<string,unknown>):Promise<unknown>{
 if(!nodeFallback){
  try{web??=createKordocWebEngine();return await web.request(input);}
  catch(error){if(!(error instanceof KordocEngineError)||error.code!=='worker_unavailable')throw error;}
  nodeFallback=true;
  try{showToast({message:'앱에 들어 있는 문서 엔진을 시작하지 못해 예비 엔진(Node)으로 처리합니다.',durationMs:0,confirmLabel:'확인'});}catch{/* no document UI in this window */}
 }
 return invoke('achmage_kordoc',{input});
}
/** One window has one ordered lane; other-window native busy errors remain explicit. No retries. */
export const queuedKordocRequest:KordocTransport=input=>{
 if(queued>=4)return Promise.reject(Error('문서 엔진 요청이 대기 중입니다. 잠시 후 다시 시도하세요.'));
 let frozen:Record<string,unknown>;try{if(new TextEncoder().encode(JSON.stringify(input)).length>16*1024*1024)throw Error('문서 요청 크기 제한을 넘었습니다.');frozen=structuredClone(input);}catch(error){return Promise.reject(error);}
 queued++;const result=queueTail.then(()=>engineRequest(frozen)).catch(error=>{throw error instanceof Error?error:Error(typeof error==='string'?error:'문서 엔진 연결을 확인하지 못했습니다.');});
 queueTail=result.then(()=>undefined,()=>undefined).finally(()=>{queued--;});return result;
};
const MAX=32*1024*1024;
function record(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('문서 엔진 응답이 올바르지 않습니다.');return v as Record<string,unknown>;}
function fontList(v:unknown):v is string[]{return Array.isArray(v)&&v.length>0&&v.length<=512&&v.every(x=>typeof x==='string'&&x.length>0&&x.length<=320)&&new Set(v).size===v.length;}
export async function getKordocCapabilities(transport:KordocTransport=queuedKordocRequest):Promise<KordocCapabilities>{
 const id=crypto.randomUUID(),reply=record(await transport({id,op:'capabilities'}));if(reply.id!==id||reply.ok!==true)throw Error('문서 엔진 기능 목록을 확인하지 못했습니다.');const r=record(reply.result),e=record(r.engine);
 if(e.name!=='kordoc'||e.version!=='4.21.31'||typeof e.sourceCommit!=='string'||!Array.isArray(r.agencies)||r.agencies.length>100)throw Error('고정 문서 엔진의 기능 목록이 아닙니다.');
 for(const key of ['presets','coverPresets','tocPresets','coverTocPresets','agencyPresets','agencyRoleOverrides']){const values=r[key];if(!Array.isArray(values)||values.length>30||values.some(x=>typeof x!=='string'||x.length>80)||new Set(values).size!==values.length)throw Error('문서 종류 목록이 올바르지 않습니다.');}
 const names=new Set<string>();for(const value of r.agencies){const a=record(value),style=record(a.style);if(typeof a.name!=='string'||!a.name||a.name.length>100||names.has(a.name)||typeof a.reportAvailable!=='boolean'||typeof a.pressAvailable!=='boolean'||a.reportUsesCommonFallback!==!a.reportAvailable||!fontList(a.fontFamilies)||a.fontFamiliesScope!=='agency-declared-including-common-fallback-not-all-preset-fonts')throw Error('기관 서식 목록이 올바르지 않습니다.');const byPreset=record(a.fontFamiliesByPreset);for(const preset of r.agencyPresets as string[])if(!fontList(byPreset[preset]))throw Error('기관 종류별 글꼴 목록이 올바르지 않습니다.');for(const key of ['report','press','band'])if(style[key]!==null)record(style[key]);if(a.reportAvailable!==(style.report!==null)||a.pressAvailable!==(style.press!==null))throw Error('기관 서식 출처가 일치하지 않습니다.');names.add(a.name);}
 if(r.tocPageNumbers!==false||r.ocr!==false||r.network!==false)throw Error('지원 범위가 고정 계약과 다릅니다.');return r as unknown as KordocCapabilities;
}
/** SVG is for an <img> source only; never insert it with innerHTML. */
export function kordocPageDataUrl(page:KordocPage):string{return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(page.svg);}
export function kordocDocumentBytes(result:KordocDocument):Uint8Array{const raw=atob(result.hwpxBase64);return Uint8Array.from(raw,c=>c.charCodeAt(0));}
async function validateResult(value:unknown):Promise<KordocDocument>{
 const r=record(value),e=record(r.engine),validation=record(r.validation);
 if(!fontList(r.fontFamilies)||r.fontFamiliesScope!=='all-language-font-references-of-used-run-charPr')throw Error('결과 문서의 사용 글꼴을 확인하지 못했습니다.');
 if(e.name!=='kordoc'||e.version!=='4.21.31'||typeof e.sourceCommit!=='string'||typeof r.hwpxBase64!=='string'||r.hwpxBase64.length>12*1024*1024||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.hwpxBase64)||typeof r.sha256!=='string'||!/^[a-f0-9]{64}$/.test(r.sha256)||validation.ok!==true||!Array.isArray(validation.issues)||!Number.isInteger(validation.entryCount)||!Array.isArray(r.pages)||r.pages.length<1||r.pages.length>100||r.pageCount!==undefined&&(!Number.isInteger(r.pageCount)||(r.pageCount as number)<r.pages.length)||!Array.isArray(r.warnings)||r.warnings.some(x=>typeof x!=='string'))throw Error('고정 문서 엔진의 검증된 결과가 아닙니다.');
 let size=r.hwpxBase64.length;for(const p of r.pages){const page=record(p);if(typeof page.svg!=='string'||!page.svg.includes('<svg')||typeof page.width!=='number'||!Number.isFinite(page.width)||page.width<=0||typeof page.height!=='number'||!Number.isFinite(page.height)||page.height<=0||/<(?:script|foreignObject)\b|\bon\w+\s*=/i.test(page.svg))throw Error('미리보기 쪽이 올바르지 않습니다.');size+=page.svg.length;}
 if(size>MAX)throw Error('문서 미리보기 크기 제한을 넘었습니다.');const result=r as unknown as KordocDocument,bytes=kordocDocumentBytes(result);
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes).buffer))).map(b=>b.toString(16).padStart(2,'0')).join('');if(digest!==result.sha256)throw Error('미리보기와 HWPX 바이트의 해시가 다릅니다.');return result;
}
export async function generateKordocDocument(input:{template:DocumentTemplate;markdown:string},transport:KordocTransport=queuedKordocRequest):Promise<KordocDocument>{
 const template=parseDocumentTemplate(input.template);template.layout=templateLayout(template);
 if(typeof input.markdown!=='string'||!input.markdown.trim())throw Error('본문을 입력하세요.');
 const id=crypto.randomUUID(),reply=record(await transport({id,op:'generate',template,markdown:input.markdown}));if(reply.id!==id||typeof reply.ok!=='boolean')throw Error('문서 엔진의 응답 ID가 다릅니다.');
 if(!reply.ok){const error=record(reply.error);throw Error(typeof error.message==='string'?error.message:'문서 생성에 실패했습니다.');}
 return validateResult(reply.result);
}
