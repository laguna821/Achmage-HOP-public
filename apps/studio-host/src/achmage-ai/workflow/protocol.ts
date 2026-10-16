import type {TextChange} from './edits';
import type {ReadRequest} from './document-map';
export type ToolCall=
 |({tool:'read'}&ReadRequest)
 |{tool:'fonts';query?:string;offset?:number}
 |{tool:'source';offset?:number;messageId?:string}
 |{tool:'edit';changes:TextChange[]}
 |{tool:'format';ids:string[];format:unknown}
 |{tool:'answer'|'finish';text:string}
 |{tool:'action';action:string;instruction:string;templateId?:string}
 |{tool:'selection';text:string}
 |{tool:'selection_format';format:unknown}
 |{tool:'checkbox';checked:boolean;tableId?:string;ids?:string[]}
 |{tool:'table';id:string;operation:string;index?:number;count?:number;startRow?:number;startCol?:number;endRow?:number;endCol?:number};
const keys:Record<ToolCall['tool'],string[]>={read:['ids','query','offset','start'],fonts:['query','offset'],source:['offset','messageId'],edit:['changes'],format:['ids','format'],answer:['text'],finish:['text'],action:['action','instruction','templateId'],selection:['text'],selection_format:['format'],checkbox:['checked','tableId','ids'],table:['id','operation','index','count','startRow','startCol','endRow','endCol']};
export function decodeTool(text:string):ToolCall {
 const cleaned=text.trim().replace(/^```(?:json)?\s*/u,'').replace(/\s*```$/u,'');let v:any;
 try{v=JSON.parse(cleaned);}catch{throw Error('JSON 객체 하나로 응답하세요. 설명은 answer.text에 넣으세요.');}
 if(!v||typeof v!=='object'||Array.isArray(v)||!Object.hasOwn(keys,v.tool))throw Error('지원하는 tool을 지정하세요.');
 if(Object.keys(v).some(k=>k!=='tool'&&!keys[v.tool as ToolCall['tool']].includes(k)))throw Error(`알 수 없는 작업 인자가 있습니다. ${v.tool}의 최상위 허용 키: tool,${keys[v.tool as ToolCall['tool']].join(',')}. 수신 키: ${Object.keys(v).join(',')}. args/input/parameters로 감싸지 마세요.`);
 for(const k of ['offset','start','index','count','startRow','startCol','endRow','endCol'])if(v[k]!==undefined&&(!Number.isSafeInteger(v[k])||v[k]<0))throw Error('위치와 개수는 0 이상의 정수여야 합니다.');
 for(const k of ['text','query','id','instruction','action','operation','templateId','tableId','messageId'])if(v[k]!==undefined&&typeof v[k]!=='string')throw Error('문자열 인자를 확인하세요.');
 if(['answer','finish','selection'].includes(v.tool)&&typeof v.text!=='string')throw Error('text가 필요합니다.');
 if(v.ids!==undefined&&(!Array.isArray(v.ids)||v.ids.length>1000||v.ids.some((x:any)=>typeof x!=='string')))throw Error('대상 ID 목록을 확인하세요.');
 if(v.tool==='edit'&&(!Array.isArray(v.changes)||v.changes.some((c:any)=>!c||typeof c!=='object'||Object.keys(c).some(k=>!['id','text','before'].includes(k)))))throw Error('changes 형식을 확인하세요.');
 if(v.tool==='format'&&!Array.isArray(v.ids))throw Error('ids가 필요합니다.');
 if(v.tool==='action'&&(typeof v.action!=='string'||typeof v.instruction!=='string'))throw Error('action과 instruction이 필요합니다.');
 if(v.tool==='checkbox'&&typeof v.checked!=='boolean')throw Error('checked는 참/거짓이어야 합니다.');
 if(v.tool==='table'&&(typeof v.id!=='string'||typeof v.operation!=='string'))throw Error('표 ID와 operation이 필요합니다.');
 return v as ToolCall;
}
