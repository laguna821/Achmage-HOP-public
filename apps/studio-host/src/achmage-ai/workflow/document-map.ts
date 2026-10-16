import type { WasmBridge } from '@/upstream/core';
export type Handle = NonNullable<ReturnType<WasmBridge['borrowDocumentHandle']>>;
export interface Address { section:number; paragraph:number; control?:number; cell?:number; cellParagraph?:number }
export interface DocNode { id:string; kind:'paragraph'|'cell'|'table'; address:Address; text:string; parent?:string; row?:number; col?:number; rows?:number; cols?:number; rowSpan?:number; colSpan?:number }
export interface ReadRequest { ids?:string[]; query?:string; offset?:number; start?:number }
export const parse = <T>(v:string):T => JSON.parse(v) as T;
const integer=(n:number,max=1_000_000)=>{if(!Number.isSafeInteger(n)||n<0||n>max)throw Error('문서 주소를 확인하지 못했습니다.');return n;};
/** Addresses are engine evidence, never supplied by a model. A new map has a new ID namespace. */
export class DocumentMap {
 readonly nodes:DocNode[]=[];
 readonly warnings:string[]=[];
 private observed=new Set<string>();
 private coverage=new Map<string,[number,number][]>();
 constructor(readonly engine:Handle, readonly revision:string) {
  const controls=parse<{ctrlId:string;list:number;para:number;controlIndex:number}[]>(engine.getControls());
  if(controls.some(c=>c.list!==0))this.warnings.push('셀 안 개체·중첩 개체는 읽기/편집 지원 여부를 대상별로 확인합니다.');
  let global=0;
  for(let s=0;s<integer(engine.getSectionCount(),4096);s++)for(let p=0;p<integer(engine.getParagraphCount(s));p++,global++){
   const n=integer(engine.getParagraphLength(s,p)),local=controls.filter(c=>c.list===0&&c.para===global);
   this.add({kind:'paragraph',address:{section:s,paragraph:p},text:engine.getTextRange(s,p,0,n)});
   for(const c of local.filter(c=>c.ctrlId==='tbl')){
    const d=parse<{rowCount:number;colCount:number;cellCount:number}>(engine.getTableDimensions(s,p,c.controlIndex));
    const table=this.add({kind:'table',address:{section:s,paragraph:p,control:c.controlIndex},text:'',rows:d.rowCount,cols:d.colCount});
    for(let cell=0;cell<integer(d.cellCount,200_000);cell++){
     const info=parse<{row:number;col:number;rowSpan:number;colSpan:number}>(engine.getCellInfo(s,p,c.controlIndex,cell));
     for(let cp=0;cp<integer(engine.getCellParagraphCount(s,p,c.controlIndex,cell),20_000);cp++){
      const args=[s,p,c.controlIndex,cell,cp] as const,len=integer(engine.getCellParagraphLength(...args));
      this.add({kind:'cell',address:{section:s,paragraph:p,control:c.controlIndex,cell,cellParagraph:cp},parent:table.id,...info,text:engine.getTextInCell(...args,0,len)});
     }
    }
   }
  }
 }
 private add(n:Omit<DocNode,'id'>):DocNode {const node={...n,id:`${this.revision}:${this.nodes.length}`};this.nodes.push(node);return node;}
 get(id:string):DocNode {const n=this.nodes.find(n=>n.id===id);if(!n)throw Error('오래되거나 알 수 없는 대상입니다. 문서를 다시 읽으세요.');return n;}
 target(id:string):DocNode {const n=this.get(id);if(!this.observed.has(id))throw Error('내용을 아직 읽지 않은 대상입니다. read로 먼저 확인하세요.');return n;}
 read(req:ReadRequest={}) {
  const offset=integer(req.offset??0),start=integer(req.start??0);let chosen=this.nodes;
  if(req.ids){const ids=new Set(req.ids);for(const id of ids)this.get(id);chosen=chosen.filter(n=>ids.has(n.id)||n.parent&&ids.has(n.parent));}
  if(req.query){const q=req.query.normalize('NFKC').toLocaleLowerCase();const hits=new Set<number>();chosen.forEach((n,i)=>{if(n.text.normalize('NFKC').toLocaleLowerCase().includes(q)){for(let j=Math.max(0,i-2);j<=Math.min(chosen.length-1,i+5);j++)hits.add(j);}});chosen=chosen.filter((_,i)=>hits.has(i));}
  let budget=20_000;const nodes=[];
  for(const n of chosen.slice(offset,offset+80)){
   const chars=Array.from(n.text),text=chars.slice(start,start+Math.min(3000,budget)).join('');
   if(text.length>budget&&nodes.length)break;
   const intervals=[...(this.coverage.get(n.id)??[]),[Math.min(start,chars.length),Math.min(chars.length,start+Array.from(text).length)] as [number,number]].sort((a,b)=>a[0]-b[0]);
   let end=0;for(const [a,b] of intervals){if(a>end)break;end=Math.max(end,b);}this.coverage.set(n.id,intervals);
   const complete=end>=chars.length;if(complete)this.observed.add(n.id);
   nodes.push({...n,address:undefined,text,chars:chars.length,complete,...(!complete?{nextStart:start+Array.from(text).length}:{})});
   budget-=text.length+120;if(budget<=0)break;
  }
  return {revision:this.revision,total:chosen.length,offset,nodes,nextOffset:offset+nodes.length<chosen.length?offset+nodes.length:null,warnings:this.warnings};
 }
 fingerprint():string {return JSON.stringify(this.nodes.map(({id,parent,...n})=>({...n,parent:parent?.split(':').at(-1)})));}
}
/** Native engine and browser bridge expose the same methods, with a few JSON wrappers. */
export function bridgeFor(engine:Handle):WasmBridge {
 const json=new Set(['getControls','getControlTextPositions','getTableDimensions','getCellInfo','getCharPropertiesAt','getParaPropertiesAt','getTableProperties','getCellOwnProperties','getPageDef','getFormObjectAt']);
 return new Proxy({}, {get(_target,name:string){
  if(name==='borrowDocumentHandle')return()=>engine;
  if(name==='pageCount')return engine.pageCount();
  if(name==='getFieldInfoAt')return(p:any)=>parse(p.parentParaIndex===undefined?engine.getFieldInfoAt(p.sectionIndex,p.paragraphIndex,p.charOffset):engine.getFieldInfoAtInCell(p.sectionIndex,p.parentParaIndex,p.controlIndex,p.cellIndex,p.cellParaIndex,p.charOffset,false));
  const v=(engine as any)[name];return typeof v==='function'?(...args:unknown[])=>{const r=v.apply(engine,args);return json.has(name)?JSON.parse(r):r;}:v;
 }}) as WasmBridge;
}
