// One request line in, one response line out: the protocol the Node worker (worker.mjs, NDJSON over stdin and
// stdout) and the WebView worker (web-worker.mjs, postMessage) share.
import { handleRequest,LIMITS,EngineRule } from './engine.mjs';

export function duplicateKeys(source){let i=0;const ws=()=>{while(/\s/.test(source[i]??'')&&i<source.length)i++;};const str=()=>{const start=i++;while(i<source.length){const c=source[i++];if(c==='\\')i++;else if(c==='"')return JSON.parse(source.slice(start,i));}throw Error('JSON 문자열 오류');};const value=depth=>{if(depth>40)throw Error('JSON 중첩 제한');ws();if(source[i]==='"'){str();return;}if(source[i]==='{'){i++;ws();const keys=new Set();if(source[i]==='}'){i++;return;}for(;;){ws();const k=str();if(keys.has(k))throw Error('중복 JSON 속성');keys.add(k);ws();i++;value(depth+1);ws();if(source[i++]==='}')return;}}if(source[i]==='['){i++;ws();if(source[i]===']'){i++;return;}for(;;){value(depth+1);ws();if(source[i++]===']')return;}}while(i<source.length&&!/[\s,}\]]/.test(source[i]))i++;};value(0);}
const utf8=new TextEncoder();
export function line(v){let data=JSON.stringify(v);if(utf8.encode(data).length>LIMITS.responseBytes)data=JSON.stringify({id:v.id,ok:false,error:{code:'response_limit',message:'응답 크기 제한을 넘었습니다.'}});return data;}
export function failure(e,id=null){return line({id,ok:false,error:{code:e instanceof EngineRule?'engine_rule':'invalid_or_unsupported',message:String(e?.message??'요청 실패').slice(0,1200)}});}
export const inputLimit=()=>line({id:null,ok:false,error:{code:'input_limit',message:'요청 크기 제한을 넘었습니다.'}});
export async function respond(raw){let id=null;try{const request=JSON.parse(raw);duplicateKeys(raw);if(typeof request.id==='string'&&request.id.length<=100)id=request.id;const result=await handleRequest(request);return line({id,ok:true,result});}catch(e){return failure(e,id);}}
