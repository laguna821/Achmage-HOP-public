import {executeControl,type ControlOperation} from './controls';
import {captureCellRange,captureMultiRange,executeMultiRange} from '../multi-range';
import type {RhwpDocumentStateV1} from '@/upstream/document-agent';
import type {WasmBridge} from '@/upstream/core';
import {parseTextFormat,textFormatMods,type TextFormat} from '../text-format';
import {bridgeFor,DocumentMap,type DocNode,type Handle} from './document-map';
export interface TextChange {id:string;text:string;before?:string}
export type PreparedOperation=ControlOperation|{kind:'selection';range:import('../multi-range').MultiRange;text:string}|{kind:'edit';nodes:{node:DocNode;text:string}[]}|{kind:'format';nodes:DocNode[];format:TextFormat};
const identity={} as RhwpDocumentStateV1;
function capture(w:WasmBridge,n:DocNode){
 const a=n.address,length=Array.from(n.text).length;
 if(n.kind==='table')throw Error('표 전체를 글로 덮어쓸 수 없습니다. 셀을 지정하세요.');
 if(n.kind==='cell')return captureCellRange(w,identity,{section:a.section,parent:a.paragraph,control:a.control!,cell:a.cell!},{paragraph:a.cellParagraph!,offset:0},{paragraph:a.cellParagraph!,offset:length});
 return captureMultiRange(w,identity,{sectionIndex:a.section,paragraphIndex:a.paragraph,charOffset:0},{sectionIndex:a.section,paragraphIndex:a.paragraph,charOffset:length});
}
export function readNode(d:Handle,n:DocNode):string {const a=n.address;return n.kind==='cell'?d.getTextInCell(a.section,a.paragraph,a.control!,a.cell!,a.cellParagraph!,0,d.getCellParagraphLength(a.section,a.paragraph,a.control!,a.cell!,a.cellParagraph!)):d.getTextRange(a.section,a.paragraph,0,d.getParagraphLength(a.section,a.paragraph));}
export function prepareText(map:DocumentMap,changes:TextChange[]):PreparedOperation {
 if(!Array.isArray(changes)||!changes.length||changes.length>1000)throw Error('한 묶음에 1~1000개 변경을 지정하세요.');
 const seen=new Set<string>();
 const nodes=changes.map(c=>{
  if(typeof c.id!=='string'||typeof c.text!=='string'||c.text.includes('\u0000'))throw Error('편집 값이 올바르지 않습니다.');
  if(seen.has(c.id))throw Error('같은 대상이 중복되었습니다.');seen.add(c.id);
  const node=map.target(c.id);let text=c.text.replace(/\r\n?/g,'\n');
  if(c.before!==undefined){if(typeof c.before!=='string'||!c.before||node.text.split(c.before).length!==2)throw Error('교체할 원문이 없거나 여러 곳에 있습니다.');text=node.text.replace(c.before,()=>text);}
  return {node:structuredClone(node),text};
 });
 // Later engine addresses first. Earlier paragraphs keep their indices when line counts change.
 nodes.sort((x,y)=>{const a=x.node.address,b=y.node.address;return b.section-a.section||b.paragraph-a.paragraph||(b.control??-1)-(a.control??-1)||(b.cell??-1)-(a.cell??-1)||(b.cellParagraph??-1)-(a.cellParagraph??-1);});
 return {kind:'edit',nodes};
}
export function prepareFormat(map:DocumentMap,ids:string[],format:unknown):PreparedOperation {
 if(!Array.isArray(ids)||!ids.length||ids.length>1000||new Set(ids).size!==ids.length)throw Error('글자 서식 대상을 확인하세요.');
 return {kind:'format',nodes:ids.map(id=>structuredClone(map.target(id))),format:parseTextFormat(format)};
}
export function executePrepared(engine:Handle,op:PreparedOperation):void {
 if(op.kind==='table'||op.kind==='checkbox'){executeControl(engine,op);return;}
 const w=bridgeFor(engine);
 if(op.kind==='selection'){executeMultiRange(w,op.range,op.text);return;}
 if(op.kind==='edit'){
  // Preflight every source before the first mutation. A failed operation is discarded/rolled back by the owner.
  for(const {node} of op.nodes)if(readNode(engine,node)!==node.text)throw Error('편집 대상 내용이 바뀌었습니다.');
  for(const {node,text} of op.nodes){
   if(text===node.text)continue;
   const c=capture(w,node);executeMultiRange(w,c,text);
  }
 }else{
  const mods=textFormatMods(op.format,family=>Array.from({length:7},(_,lang)=>engine.findOrCreateFontIdForLang(lang,family)));
  for(const node of op.nodes){
   if(readNode(engine,node)!==node.text)throw Error('서식 대상이 바뀌었습니다.');
   const a=node.address,n=Array.from(node.text).length;if(!n)continue;
   const result=node.kind==='cell'?engine.applyCharFormatInCellByPath(a.section,a.paragraph,JSON.stringify([{controlIndex:a.control,cellIndex:a.cell,cellParaIndex:a.cellParagraph}]),0,n,mods):node.kind==='paragraph'?engine.applyCharFormat(a.section,a.paragraph,0,n,mods):null;
   if(!result||JSON.parse(result).ok!==true)throw Error('글자 서식 적용을 확인하지 못했습니다.');
   if(readNode(engine,node)!==node.text)throw Error('서식 변경 중 내용이 바뀌었습니다.');
  }
 }
}
