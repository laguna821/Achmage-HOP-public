/// <reference types="node" />
import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {HwpDocument } from '../../vendor/rhwp-core/rhwp.js';
import {EventBus} from '@upstream/core/event-bus';
import {SnapshotCommand} from '@upstream/engine/command';
import {CommandHistory} from '@upstream/engine/history';
import type {WasmBridge} from '@/upstream/core';
import type {InputHandler} from '@/upstream/editor';
import type {CanvasView} from '@/upstream/view';
import {AiDocument} from './document';
import {InPlaceReplacementUnsupported} from './whole-document-replace';
import {captureWholeDocumentContext} from './whole-document-context';
import { initPinnedEngine } from './test-support/pinned-wasm';
initPinnedEngine();
const generated=readFileSync(new URL('./fixtures/kordoc-report-cover.hwpx',import.meta.url));
const json=new Set(['getControls','getControlTextPositions','getCharPropertiesAt','getParaPropertiesAt','getTableDimensions','getCellInfo']);
const text=(d:HwpDocument,p:number)=>d.getTextRange(0,p,0,d.getParagraphLength(0,p));
function fixture(seed:(d:HwpDocument)=>void){
 const native=new HwpDocument(readFileSync(new URL('./fixtures/owned-blank.hwpx',import.meta.url)));seed(native);
 const history=new CommandHistory(),bus=new EventBus();let cursor={sectionIndex:0,paragraphIndex:0,charOffset:0},fail=false;
 const wasm=new Proxy({},{get(_t,name:string){
  if(name==='pageCount')return native.pageCount();if(name==='documentGeneration')return 1;if(name==='getSourceFormat')return ()=>'hwpx';
  if(name==='borrowDocumentHandle')return ()=>native;if(name==='getFieldInfoAt')return (p:Parameters<WasmBridge['getFieldInfoAt']>[0])=>JSON.parse(p.parentParaIndex===undefined?native.getFieldInfoAt(p.sectionIndex,p.paragraphIndex,p.charOffset):native.getFieldInfoAtInCell(p.sectionIndex,p.parentParaIndex,p.controlIndex!,p.cellIndex!,p.cellParaIndex!,p.charOffset,false));
  if(['beginDeferredPagination','flushDeferredPagination','cancelDeferredPagination'].includes(name))return undefined;
  const fn=(native as unknown as Record<string,Function>)[name];return typeof fn==='function'?(...args:unknown[])=>{const v=fn.apply(native,args);return json.has(name)?JSON.parse(v):v;}:fn;
 }}) as WasmBridge;
 const input={getCursorPosition:()=>cursor,getSelection:()=>null,async executeDocumentAgentOperation(d:{operationType:string;operation:(w:WasmBridge)=>typeof cursor},render:()=>Promise<void>){
  const command=new SnapshotCommand(d.operationType,cursor,cursor,d.operation);cursor=history.execute(command,wasm);
  try{await render();}catch(e){const restored=history.rollbackUncommittedSnapshot(command.type,wasm);if(restored)cursor=restored;throw e;}bus.emit('document-mutated');
 }} as unknown as InputHandler;
 const view={refreshDocumentAgentMutation:async()=>{if(fail)throw new Error('injected render failure');}} as unknown as CanvasView;
 const doc=new AiDocument(wasm,input,bus,view,()=>true);
 return {native,wasm,history,doc,fail:()=>{fail=true;},undo:()=>history.undo(wasm),redo:()=>history.redo(wasm),close:()=>{doc.dispose();history.clear(wasm);native.free();}};
}
describe('page-number restart (review F8)',()=>{
 it('keeps the generated restart value instead of forcing 1',async()=>{
  const source=new HwpDocument(generated);let bytes:Uint8Array;
  try{const restart=(JSON.parse(source.getControls()) as {ctrlId:string;list:number;para:number;controlIndex:number}[]).find(c=>c.ctrlId==='nwno'&&c.list===0)!;
   source.deleteControlAt(0,restart.para,restart.controlIndex);source.insertNewNumber(0,restart.para+2,0,3);bytes=source.exportHwpx();}finally{source.free();}
  const f=fixture(()=>{});
  try{await f.doc.applyWholeDocument(f.doc.identity(),new Uint8Array(bytes),{hideFirstPage:true});
   const glyphs=(page:number)=>[...f.native.renderPageSvg(page).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m=>m[1]).join('');
   expect(JSON.parse(f.native.getPageInfo(1)).pageNumber).toBe(3);expect(glyphs(1)).toMatch(/-3-$/);}finally{f.close();}
 });
});
function expectGenerated(d:HwpDocument){
 const source=new HwpDocument(generated);
 try{
  // The generated first paragraph is a pure section holder; its cover table moves into the open document's anchor.
  expect(d.getParagraphCount(0)).toBe(source.getParagraphCount(0));
  for(let p=0;p<source.getParagraphCount(0);p++)expect(text(d,p)).toBe(text(source,p));
  const ids=JSON.parse(d.getControls()).filter((c:{list:number})=>c.list===0).map((c:{ctrlId:string;para:number})=>c.ctrlId+'@'+c.para).sort();
  expect(ids).toEqual(['cold@0','foot@0','nwno@17','pghd@0','secd@0','tbl@0','tbl@17','tbl@18','tbl@5'].sort());
  expect(JSON.parse(d.getPageDef(0))).toEqual(JSON.parse(source.getPageDef(0)));
  // Rendered page numbers, not the footer's control-character spelling (which differs after reopen).
  const glyphs=(page:number)=>[...d.renderPageSvg(page).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m=>m[1]).join('');
  expect(glyphs(0)).not.toMatch(/-\d+-$/);expect(glyphs(1)).toMatch(/-1-$/);
  expect(JSON.parse(d.getParaPropertiesAt(0,0)).alignment).toBe(JSON.parse(source.getParaPropertiesAt(0,0)).alignment);
  expect(d.pageCount()).toBe(source.pageCount());
 }finally{source.free();}
}
describe('whole open-document replacement on actual pinned WASM',()=>{
 it('replaces a body in place with cover/page numbers and restores exact bytes with one Undo, then Redo',async()=>{
  const f=fixture(d=>{d.insertText(0,0,0,'기존 제목');d.splitParagraph(0,0,5);d.insertText(0,1,0,'기존 본문 문단 😀');const t=JSON.parse(d.createTable(0,1,0,2,2));d.insertTextInCell(0,1,t.controlIdx,0,0,0,'셀');});
  try{
   const before=f.native.exportHwpx(),identity=f.doc.identity();
   const result=await f.doc.applyWholeDocument(identity,new Uint8Array(generated),{hideFirstPage:true});
   expect(result.paragraphs).toBe(20);expectGenerated(f.native);
   const saved=f.native.exportHwpx(),reopened=new HwpDocument(saved);try{expectGenerated(reopened);}finally{reopened.free();}
   f.undo();expect(f.native.exportHwpx()).toEqual(before);
   f.redo();expectGenerated(f.native);
  }finally{f.close();}
 });
 it('fills a blank document and reports it as blank before the replacement',async()=>{
  const f=fixture(()=>{});
  try{expect(f.doc.isBlank()).toBe(true);await f.doc.applyWholeDocument(f.doc.identity(),new Uint8Array(generated),{hideFirstPage:true});expect(f.doc.isBlank()).toBe(false);expectGenerated(f.native);}finally{f.close();}
 });
 it('refuses a stale identity and leaves the document and history untouched',async()=>{
  const f=fixture(d=>{d.insertText(0,0,0,'원문');});
  try{const identity=f.doc.identity();f.native.insertText(0,0,0,'변경 ');const before=f.native.exportHwpx();
   await expect(f.doc.applyWholeDocument(identity,new Uint8Array(generated),{hideFirstPage:true})).rejects.toThrow('바뀌어');
   expect(f.native.exportHwpx()).toEqual(before);expect(f.undo()).toBeNull();}finally{f.close();}
 });
 it('rolls back a render failure after mutation to the exact original bytes',async()=>{
  const f=fixture(d=>{d.insertText(0,0,0,'보존할 원문');});
  try{const before=f.native.exportHwpx();f.fail();
   await expect(f.doc.applyWholeDocument(f.doc.identity(),new Uint8Array(generated),{hideFirstPage:true})).rejects.toThrow('render');
   expect(f.native.exportHwpx()).toEqual(before);}finally{f.close();}
 });
 it('signals an unsupported in-place case before any mutation for a multi-section document',async()=>{
  const f=fixture(d=>{d.insertText(0,0,0,'원문');});
  try{const before=f.native.exportHwpx(),wasm=new Proxy(f.wasm,{get(t,k){return k==='getSectionCount'?()=>2:Reflect.get(t,k);}}) as WasmBridge;
   const native=f.native,proxyHandle=new Proxy(native,{get(t,k){return k==='getSectionCount'?()=>2:Reflect.get(t,k as keyof HwpDocument);}});
   const doc2=new Proxy(f.wasm,{get(t,k){return k==='borrowDocumentHandle'?()=>proxyHandle:Reflect.get(t,k);}}) as WasmBridge;
   const {prepareWholeDocumentReplacement}=await import('./whole-document-replace');
   expect(()=>prepareWholeDocumentReplacement(doc2,new Uint8Array(generated),{hideFirstPage:false})).toThrow(InPlaceReplacementUnsupported);
   expect(wasm.getSectionCount()).toBe(2);expect(f.native.exportHwpx()).toEqual(before);}finally{f.close();}
 });
 it('applies the generated single-column layout instead of keeping the open document columns',async()=>{
  const f=fixture(d=>{d.insertText(0,0,0,'원문');d.setColumnDef(0,2,0,1,1134);});
  try{expect(JSON.parse(f.native.getColumnDef(0)).columnCount).toBe(2);
   await f.doc.applyWholeDocument(f.doc.identity(),new Uint8Array(generated),{hideFirstPage:true});
   expect(JSON.parse(f.native.getColumnDef(0)).columnCount).toBe(1);f.undo();expect(JSON.parse(f.native.getColumnDef(0)).columnCount).toBe(2);}finally{f.close();}
 });
 it('discloses layout controls removed from paragraphs after the first',async()=>{
  const f=fixture(()=>{});
  try{await f.doc.applyWholeDocument(f.doc.identity(),new Uint8Array(generated),{hideFirstPage:true});
   // The open document now carries a footer and a page-number restart in paragraph 17; replacing it again must say so.
   const again=await f.doc.applyWholeDocument(f.doc.identity(),new Uint8Array(generated),{hideFirstPage:true});
   expect(again.removedLayout).toEqual(expect.arrayContaining(['foot','pghd','nwno']));}finally{f.close();}
 });
 it('reads a just-replaced document again for the next restyle request (generate, then "바뀐 양식대로 전부 적용")',async()=>{
  const f=fixture(()=>{});
  try{await f.doc.applyWholeDocument(f.doc.identity(),new Uint8Array(generated),{hideFirstPage:true});
   const got=captureWholeDocumentContext(f.wasm);expect(got.tables).toBe(4);expect(JSON.parse(got.source).sections[0].paragraphs).toHaveLength(20);}finally{f.close();}
 });
 it('does not hide the first page number when the template has no cover',async()=>{
  const f=fixture(()=>{});
  try{await f.doc.applyWholeDocument(f.doc.identity(),new Uint8Array(generated),{hideFirstPage:false});
   const ids=JSON.parse(f.native.getControls()).map((c:{ctrlId:string})=>c.ctrlId);expect(ids).not.toContain('pghd');expect(ids).toContain('foot');}finally{f.close();}
 });
});
