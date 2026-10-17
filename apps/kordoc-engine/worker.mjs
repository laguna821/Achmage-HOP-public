import { LIMITS } from './engine.mjs';
import { respond,failure,inputLimit,line } from './respond.mjs';

// Vendor warnings must never corrupt the NDJSON protocol or log document content.
console.log=()=>{};console.warn=()=>{};console.error=()=>{};
function emit(data){process.stdout.write(data+'\n');}
async function processFrame(frame){let raw;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(frame);}catch(e){emit(failure(e));return;}emit(await respond(raw));}
let pending=Buffer.alloc(0),overflow=false,once=process.argv.includes('--once'),handled=false;
outer:for await(const chunk of process.stdin){let start=0;for(let i=0;i<chunk.length;i++)if(chunk[i]===10){const piece=chunk.subarray(start,i);if(!overflow&&pending.length+piece.length<=LIMITS.inputBytes){await processFrame(Buffer.concat([pending,piece]));}else emit(inputLimit());handled=true;pending=Buffer.alloc(0);overflow=false;start=i+1;if(once)break outer;}const tail=chunk.subarray(start);if(!overflow){if(pending.length+tail.length>LIMITS.inputBytes){pending=Buffer.alloc(0);overflow=true;}else pending=Buffer.concat([pending,tail]);}}
if(pending.length||overflow)emit(line({id:null,ok:false,error:{code:'incomplete_frame',message:'요청은 줄바꿈으로 끝나야 합니다.'}}));
