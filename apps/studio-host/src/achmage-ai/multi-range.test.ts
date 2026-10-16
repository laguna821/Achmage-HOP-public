/// <reference types="node" />
import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {HwpDocument } from '../../vendor/rhwp-core/rhwp.js';
import type {WasmBridge} from '@/upstream/core';
import type {RhwpDocumentStateV1} from '@upstream/document-agent/types';
import {captureCellRange,captureMultiRange,executeMultiRange,normalizeMultiReplacement} from './multi-range';
initPinnedEngine();
const json=new Set(['getControls','getControlTextPositions']);
function doc(paragraphs:string[]){
 const native=new HwpDocument(readFileSync(new URL('./fixtures/owned-blank.hwpx',import.meta.url)));
 paragraphs.forEach((text,p)=>{if(p)native.splitParagraph(0,p-1,Array.from(paragraphs[p-1]).length);native.insertText(0,p,0,text);});
 const wasm=new Proxy({},{get(_t,name:string){
  if(name==='borrowDocumentHandle')return ()=>native;if(name==='getFieldInfoAt')return (p:{sectionIndex:number;paragraphIndex:number;charOffset:number})=>JSON.parse(native.getFieldInfoAt(p.sectionIndex,p.paragraphIndex,p.charOffset));
  const fn=(native as unknown as Record<string,Function>)[name];return typeof fn==='function'?(...args:unknown[])=>{const v=fn.apply(native,args);return json.has(name)?JSON.parse(v):v;}:fn;
 }}) as WasmBridge;
 const texts=()=>Array.from({length:native.getParagraphCount(0)},(_,p)=>native.getTextRange(0,p,0,native.getParagraphLength(0,p)));
 return {native,wasm,texts};
}
const identity={} as RhwpDocumentStateV1,at=(paragraphIndex:number,charOffset:number)=>({sectionIndex:0,paragraphIndex,charOffset});
describe('multi-paragraph selection boundaries on actual pinned WASM',()=>{
 it('keeps the next paragraph separate when the selection ends at its start and the reply has no trailing newline',()=>{
  const d=doc(['가나다','라마바','사아자']);
  try{const c=captureMultiRange(d.wasm,identity,at(0,0),at(1,0));expect(c.before).toBe('가나다');executeMultiRange(d.wasm,c,'수정한 문장');expect(d.texts()).toEqual(['수정한 문장','라마바','사아자']);}finally{d.native.free();}
 });
 it('does not split the unselected suffix into its own paragraph when the reply ends with a newline',()=>{
  const d=doc(['가나다','라마바']);
  try{const c=captureMultiRange(d.wasm,identity,at(0,1),at(1,1));executeMultiRange(d.wasm,c,'X\nY\n');expect(d.texts()).toEqual(['가X','Y마바']);}finally{d.native.free();}
 });
 it('keeps the previous paragraph separate when the selection starts at its end',()=>{
  const d=doc(['가나다','라마바','사아자']);
  try{const c=captureMultiRange(d.wasm,identity,at(0,3),at(2,3));expect(c.before).toBe('라마바\n사아자');executeMultiRange(d.wasm,c,'\n하나\n둘');expect(d.texts()).toEqual(['가나다','하나','둘']);}finally{d.native.free();}
 });
});
const PNG=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0));
const runs=(d:HwpDocument,p:number)=>JSON.parse(d.getCharShapeRuns(0,p,0,d.getParagraphLength(0,p))) as {startOffset:number;endOffset:number;charShapeId:number}[];
const shapeAt=(d:HwpDocument,p:number,o:number)=>runs(d,p).find(r=>r.startOffset<=o&&o<r.endOffset)!.charShapeId;
describe('minimal-diff selection editing (T10) on actual pinned WASM',()=>{
 it('replaces only the changed word and keeps colour, underline and bold elsewhere (F6)',()=>{
  const d=doc(['앞 문단','교양교육과정 개편은 학생 선택권을 넓힌다','뒤 문단']);
  try{
   d.native.applyCharFormat(0,1,0,4,JSON.stringify({textColor:'#FF0000',underline:true}));d.native.applyCharFormat(0,1,7,9,JSON.stringify({bold:true}));
   const red=shapeAt(d.native,1,0),bold=shapeAt(d.native,1,7),plain=shapeAt(d.native,1,5),outside=[runs(d.native,0),runs(d.native,2)];
   const c=captureMultiRange(d.wasm,identity,at(1,0),at(1,22));executeMultiRange(d.wasm,c,'교양교육과정 개편은 학생 선택권을 넓혔다');
   expect(d.texts()[1]).toBe('교양교육과정 개편은 학생 선택권을 넓혔다');
   expect([0,1,2,3].map(o=>shapeAt(d.native,1,o))).toEqual([red,red,red,red]);expect([7,8].map(o=>shapeAt(d.native,1,o))).toEqual([bold,bold]);
   expect(shapeAt(d.native,1,21)).toBe(plain);expect([runs(d.native,0),runs(d.native,2)]).toEqual(outside);
  }finally{d.native.free();}
 });
 it('keeps an inline picture in front of the words that follow it when those words change',()=>{
  const d=doc(['그림 뒤의 문장입니다']);
  try{
   d.native.insertPicture(0,0,0,'',PNG,1000,1000,1,1,'png','점');
   const c=captureMultiRange(d.wasm,identity,at(0,0),at(0,11));expect(c.before).toBe('⟦그림1⟧그림 뒤의 문장입니다');
   executeMultiRange(d.wasm,c,'⟦그림1⟧사진 뒤의 문장입니다');expect(d.texts()[0]).toBe('사진 뒤의 문장입니다');expect(JSON.parse(d.native.getControlTextPositions(0,0))).toContain(0);
   const again=captureMultiRange(d.wasm,identity,at(0,0),at(0,11));executeMultiRange(d.wasm,again,'⟦그림1⟧새 사진 뒤의 문장입니다');expect(d.texts()[0]).toBe('새 사진 뒤의 문장입니다');
   expect(captureMultiRange(d.wasm,identity,at(0,0),at(0,13)).before).toBe('⟦그림1⟧새 사진 뒤의 문장입니다');
  }finally{d.native.free();}
 });
 it('adds paragraphs before and after a table inside the selection without moving the table',()=>{
  const d=doc(['앞 문단','','뒤 문단']);
  try{
   d.native.createTable(0,1,0,2,2);d.native.deleteParagraph(0,2);
   const c=captureMultiRange(d.wasm,identity,at(0,0),at(2,4));expect(c.before).toBe('앞 문단\n⟦표1⟧\n뒤 문단');
   executeMultiRange(d.wasm,c,'앞 문단\n표 설명\n⟦표1⟧\n표 뒤 설명\n뒤 문단');
   expect(d.texts()).toEqual(['앞 문단','표 설명','','표 뒤 설명','뒤 문단']);
   expect((JSON.parse(d.native.getControls()) as {ctrlId:string;list:number;para:number}[]).filter(x=>x.ctrlId==='tbl'&&x.list===0).map(x=>x.para)).toEqual([2]);
  }finally{d.native.free();}
 });
 it('maps paragraph shapes the same way wherever the selection ends (F14)',()=>{
  for(const end of [3,2]){
   const d=doc(['ABC','DEF','GHI']);
   try{
    d.native.applyParaFormat(0,1,JSON.stringify({alignment:'center'}));d.native.applyParaFormat(0,2,JSON.stringify({alignment:'right'}));
    const shapes=[0,1,2].map(p=>d.native.getParaPropertiesAt(0,p));
    const c=captureMultiRange(d.wasm,identity,at(0,0),at(2,end));executeMultiRange(d.wasm,c,c.before.replace('ABC\nDEF','ABC DEF'));
    expect(d.texts()).toEqual(['ABC DEF','GHI']);expect([0,1].map(p=>d.native.getParaPropertiesAt(0,p))).toEqual([shapes[0],shapes[2]]);
    const e=captureMultiRange(d.wasm,identity,at(0,0),at(1,end));executeMultiRange(d.wasm,e,'요약 한 줄\n'+e.before.split('\n')[1]);
    expect(d.texts()).toEqual(['요약 한 줄','GHI']);expect([0,1].map(p=>d.native.getParaPropertiesAt(0,p))).toEqual([shapes[0],shapes[2]]);
   }finally{d.native.free();}
  }
 });
 it('rejects a reply that drops or moves an object marker, leaving the document unchanged',()=>{
  const d=doc(['앞 문단','','뒤 문단']);
  try{
   d.native.createTable(0,1,0,2,2);d.native.deleteParagraph(0,2);const before=d.native.exportHwpx();
   const c=captureMultiRange(d.wasm,identity,at(0,0),at(2,4));
   expect(()=>executeMultiRange(d.wasm,c,'앞 문단\n뒤 문단')).toThrow('개체');expect(d.native.exportHwpx()).toEqual(before);
  }finally{d.native.free();}
 });
});
describe('bundle B review regressions',()=>{
 it('keeps empty paragraphs at the selection edges and treats an unchanged reply as unchanged (HIGH 1)',()=>{
  const d=doc(['제목','','본문 내용','','다음']);
  try{
   d.native.applyParaFormat(0,2,JSON.stringify({alignment:'center'}));const formats=[0,1,2,3,4].map(p=>d.native.getParaPropertiesAt(0,p)),before=d.native.exportHwpx();
   const lead=captureMultiRange(d.wasm,identity,at(0,2),at(2,5));expect(lead.before).toBe('본문 내용');
   executeMultiRange(d.wasm,lead,lead.before);expect(d.native.exportHwpx()).toEqual(before);
   const tail=captureMultiRange(d.wasm,identity,at(2,0),at(4,0));expect(tail.before).toBe('본문 내용');
   executeMultiRange(d.wasm,tail,'본문 내용 수정');expect(d.texts()).toEqual(['제목','','본문 내용 수정','','다음']);
   expect([0,1,2,3,4].map(p=>d.native.getParaPropertiesAt(0,p))).toEqual(formats);
  }finally{d.native.free();}
  expect(normalizeMultiReplacement('\n\n본문\n','\n본문')).toBe('\n본문');expect(normalizeMultiReplacement('본문','본문\n')).toBe('본문\n');
 });
 it('keeps each paragraph its own character shape when a long selection is rewritten completely (MED 2)',()=>{
  const words=(prefix:string,n:number)=>Array.from({length:n},(_,i)=>`${prefix}${i}`).join(' ');
  const d=doc(['큰 제목 줄',words('본문가',400),words('본문나',400)]);
  try{
   d.native.applyCharFormat(0,0,0,d.native.getParagraphLength(0,0),JSON.stringify({bold:true,fontSize:1800}));
   const body=JSON.parse(d.native.getCharPropertiesAt(0,1,0)) as {fontSize:number;bold:boolean};
   const c=captureMultiRange(d.wasm,identity,at(0,0),at(2,d.native.getParagraphLength(0,2)));
   executeMultiRange(d.wasm,c,['새 제목',words('새글가',400),words('새글나',400)].join('\n'));
   const props=(p:number)=>JSON.parse(d.native.getCharPropertiesAt(0,p,3)) as {fontSize:number;bold:boolean};
   expect(props(0)).toMatchObject({fontSize:1800,bold:true});
   expect(props(1)).toMatchObject({fontSize:body.fontSize,bold:body.bold});expect(props(2)).toMatchObject({fontSize:body.fontSize,bold:body.bold});
  }finally{d.native.free();}
 });
});
describe('selection editing inside one table cell (T10) on actual pinned WASM',()=>{
 function table(){
  const d=doc(['표 앞 문단','']);const t=JSON.parse(d.native.createTable(0,1,0,3,3)) as {paraIdx:number;controlIdx:number};
  const cells=['구분','예산','비고','인건비','100','교수 인건비와 조교 인건비','운영비','50','회의비'];
  cells.forEach((text,cell)=>d.native.insertTextInCell(0,t.paraIdx,t.controlIdx,cell,0,0,text));
  return {...d,parent:t.paraIdx,control:t.controlIdx};
 }
 const cellText=(d:ReturnType<typeof table>,cell:number,p=0)=>d.native.getTextInCell(0,d.parent,d.control,cell,p,0,d.native.getCellParagraphLength(0,d.parent,d.control,cell,p));
 it('fills an empty cell with multiple paragraphs while preserving neighbouring cells',()=>{
  const d=table();
  try {
   const length=d.native.getCellParagraphLength(0,d.parent,d.control,5,0);
   d.native.deleteTextInCell(0,d.parent,d.control,5,0,0,length);
   const others=[0,1,2,3,4,6,7,8].map(cell=>cellText(d,cell)), dims=d.native.getTableDimensions(0,d.parent,d.control);
   const c=captureCellRange(d.wasm,identity,{section:0,parent:d.parent,control:d.control,cell:5},{paragraph:0,offset:0},{paragraph:0,offset:0});
   executeMultiRange(d.wasm,c,'미디어콘텐츠 바이브코딩\n협력기업 연계 16주 PBL');
   expect([cellText(d,5,0),cellText(d,5,1)]).toEqual(['미디어콘텐츠 바이브코딩','협력기업 연계 16주 PBL']);
   expect([0,1,2,3,4,6,7,8].map(cell=>cellText(d,cell))).toEqual(others);
   expect(d.native.getTableDimensions(0,d.parent,d.control)).toBe(dims);
  } finally { d.native.free(); }
 });
 it('edits only the selected cell, keeps the other cells, the structure and the cell text formatting',()=>{
  const d=table();
  try{
   const path=JSON.stringify([{controlIndex:d.control,cellIndex:5,cellParaIndex:0}]);
   d.native.applyCharFormatInCell(0,d.parent,d.control,5,0,0,2,JSON.stringify({bold:true}));
   const bold=(JSON.parse(d.native.getCharShapeRunsInCellByPath(0,d.parent,path,0,2)) as {charShapeId:number}[])[0].charShapeId;
   const others=[0,1,2,3,4,6,7,8].map(cell=>cellText(d,cell)),controls=d.native.getControls(),dims=d.native.getTableDimensions(0,d.parent,d.control);
   const c=captureCellRange(d.wasm,identity,{section:0,parent:d.parent,control:d.control,cell:5},{paragraph:0,offset:0},{paragraph:0,offset:14});
   expect(c.before).toBe('교수 인건비와 조교 인건비');
   const end=executeMultiRange(d.wasm,c,'교수 인건비와 연구원 인건비\n(월 단위)');
   expect([cellText(d,5,0),cellText(d,5,1)]).toEqual(['교수 인건비와 연구원 인건비','(월 단위)']);
   expect(end).toMatchObject({parentParaIndex:d.parent,controlIndex:d.control,cellIndex:5,cellParaIndex:1});
   expect((JSON.parse(d.native.getCharShapeRunsInCellByPath(0,d.parent,path,0,2)) as {charShapeId:number}[])[0].charShapeId).toBe(bold);
   expect([0,1,2,3,4,6,7,8].map(cell=>cellText(d,cell))).toEqual(others);
   expect(d.native.getControls()).toBe(controls);expect(d.native.getTableDimensions(0,d.parent,d.control)).toBe(dims);expect(d.texts()[0]).toBe('표 앞 문단');
  }finally{d.native.free();}
 });
 it('keeps a merged cell merged and edits its text',()=>{
  const d=table();
  try{
   d.native.mergeTableCells(0,d.parent,d.control,1,1,2,1);
   const infos=()=>Array.from({length:JSON.parse(d.native.getTableDimensions(0,d.parent,d.control)).cellCount},(_,i)=>d.native.getCellInfo(0,d.parent,d.control,i));
   const before=infos(),merged=before.findIndex(x=>JSON.parse(x).rowSpan===2);expect(merged).toBeGreaterThanOrEqual(0);
   const text=cellText(d,merged),c=captureCellRange(d.wasm,identity,{section:0,parent:d.parent,control:d.control,cell:merged},{paragraph:0,offset:0},{paragraph:0,offset:Array.from(text).length});
   executeMultiRange(d.wasm,c,text+' 합계');expect(cellText(d,merged)).toBe(text+' 합계');expect(infos()).toEqual(before);
  }finally{d.native.free();}
 });
});
import { coveredParagraphs } from './document';
import { initPinnedEngine } from './test-support/pinned-wasm';
describe('paragraphs a selection covers', () => {
  const len = (p: number) => [10, 20, 30][p];
  const at = (paragraphIndex: number, charOffset: number) => ({ sectionIndex: 0, paragraphIndex, charOffset });
  it('drops a paragraph touched only by its break and reports partial ends', () => {
    expect(coveredParagraphs(at(0, 0), at(2, 0), len)).toEqual({ first: 0, last: 1, partial: false });
    expect(coveredParagraphs(at(0, 10), at(2, 5), len)).toEqual({ first: 1, last: 2, partial: true });
    expect(coveredParagraphs(at(0, 3), at(1, 20), len)).toEqual({ first: 0, last: 1, partial: true });
    expect(coveredParagraphs(at(1, 0), at(1, 20), len)).toEqual({ first: 1, last: 1, partial: false });
  });
});
