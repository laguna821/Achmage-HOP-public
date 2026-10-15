/// <reference types="node" />
import {describe,it,expect} from 'vitest';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {HwpDocument } from '../../vendor/rhwp-core/rhwp.js';
import {EventBus} from '@upstream/core/event-bus';
import {SnapshotCommand} from '@upstream/engine/command';
import {CommandHistory} from '@upstream/engine/history';
import type {WasmBridge} from '@/upstream/core';
import type {InputHandler} from '@/upstream/editor';
import type {CanvasView} from '@/upstream/view';
import {AiDocument} from './document';
import {parseStructuredPlan,parseAnnotatedDraft,paragraphEvidence} from './structured-edit';
import { initPinnedEngine } from './test-support/pinned-wasm';
initPinnedEngine();
const plan=parseStructuredPlan(JSON.parse(readFileSync(new URL('./fixtures/user-six-paragraphs.json',import.meta.url),'utf8')));
function fixture(){
 const native=new HwpDocument(readFileSync(new URL('./fixtures/owned-blank.hwpx',import.meta.url))),history=new CommandHistory(),bus=new EventBus();
 let cursor={sectionIndex:0,paragraphIndex:0,charOffset:0},generation=1,fail=false,failStyle=false,styleCalls=0,failCell=false,cellCalls=0;
 const json=new Set(['getControls','getControlTextPositions','getCharPropertiesAt','getParaPropertiesAt','createTable','getTableDimensions','getCellParaPropertiesAt','getCellCharPropertiesAt','getTableProperties','getCellOwnProperties','getPictureProperties']);
 const wasm=new Proxy({}, {get(_t,name:string){
  if(name==='pageCount')return native.pageCount();if(name==='documentGeneration')return generation;
  if(name==='getSourceFormat')return ()=>'hwpx';if(name==='borrowDocumentHandle')return ()=>native;
  if(name==='getFieldInfoAt')return (p:typeof cursor)=>JSON.parse(native.getFieldInfoAt(p.sectionIndex,p.paragraphIndex,p.charOffset));
  if(name==='applyCharFormat'&&failStyle)return (...args:Parameters<HwpDocument['applyCharFormat']>)=>{if(++styleCalls===2)throw new Error('injected style failure');return native.applyCharFormat(...args);};
  if(name==='applyCharFormatInCell'&&failCell)return (...args:Parameters<HwpDocument['applyCharFormatInCell']>)=>{if(++cellCalls===2)throw new Error('injected cell failure');return native.applyCharFormatInCell(...args);};
  if(['beginDeferredPagination','flushDeferredPagination','cancelDeferredPagination'].includes(name))return undefined;
  const fn=(native as unknown as Record<string,Function>)[name];return typeof fn==='function'?(...args:unknown[])=>{const v=fn.apply(native,args);return json.has(name)?JSON.parse(v):v;}:fn;
 }}) as WasmBridge;
 const input={getCursorPosition:()=>cursor,getSelection:()=>null,async executeDocumentAgentOperation(d:{operationType:string;operation:(w:WasmBridge)=>typeof cursor},render:()=>Promise<void>){
  const command=new SnapshotCommand(d.operationType,cursor,cursor,d.operation);cursor=history.execute(command,wasm);
  try{await render();}catch(e){const restored=history.rollbackUncommittedSnapshot(command.type,wasm);if(restored)cursor=restored;throw e;}bus.emit('document-mutated');
 }} as unknown as InputHandler;
 const view={refreshDocumentAgentMutation:async()=>{if(fail)throw new Error('injected render failure');}} as unknown as CanvasView;
 const adapter=new AiDocument(wasm,input,bus,view,()=>true);
 return {native,wasm,history,bus,adapter,setCursor:(p:typeof cursor)=>{cursor=p;},fail:()=>{fail=true;},failStyle:()=>{failStyle=true;},failCell:()=>{failCell=true;},undo:()=>{const restored=history.undo(wasm);if(restored)cursor=restored;bus.emit('document-mutated');},reopen:()=>{generation++;},close:()=>{adapter.dispose();history.clear(wasm);native.free();}};
}
function check(doc:HwpDocument){
 expect(doc.getParagraphCount(0)).toBe(6);
 for(let p=0;p<6;p++){const run=plan.paragraphs[p].runs[0];expect(doc.getTextRange(0,p,0,doc.getParagraphLength(0,p))).toBe(run.text);
  for(let i=0;i<Array.from(run.text).length;i++){const props=JSON.parse(doc.getCharPropertiesAt(0,p,i));expect(props.fontSize).toBe(run.fontSizePt*100);expect(props.bold).toBe(run.bold);expect(props.spacings).toEqual(Array(7).fill(run.spacingPercent));expect(props.fontFamilies).toEqual(Array(7).fill(run.fontFamily));}
 }
}
describe('Structured typed edits on actual pinned WASM',()=>{
 const v2=()=>({schemaVersion:2,operation:'replace_paragraphs',styles:{body:{fontFamily:'함초롬바탕',fontSizePt:11,bold:false,spacingPercent:-2},head:{fontFamily:'신명조',fontSizePt:15,bold:true,spacingPercent:5}},blocks:[{type:'paragraph',runs:[{text:'표와 실제 줄간격',style:'head'}],paragraphFormat:{alignment:'center',lineSpacingPercent:200}},{type:'table',rows:[[ {runs:[{text:'이름',style:'head'}],paragraphFormat:{alignment:'center',lineSpacingPercent:150}},{runs:[{text:'내용',style:'head'}],paragraphFormat:{alignment:'right',lineSpacingPercent:160}} ],[ {runs:[{text:'한글😀',style:'body'}],paragraphFormat:{alignment:'left',lineSpacingPercent:180}},{runs:[{text:'실제 셀',style:'body'}],paragraphFormat:{alignment:'justify',lineSpacingPercent:190}} ]]},{type:'paragraph',runs:[{text:'뒤 본문',style:'body'}],paragraphFormat:{alignment:'justify',lineSpacingPercent:220}}]});
 function checkV2(doc:HwpDocument){
  expect(doc.getParagraphCount(0)).toBe(3);expect(JSON.parse(doc.getParaPropertiesAt(0,0))).toMatchObject({alignment:'center',lineSpacing:200,lineSpacingType:'Percent'});
  const controls=JSON.parse(doc.getControls()),table=controls.find((c:{ctrlId:string})=>c.ctrlId==='tbl');expect(table).toBeDefined();
  const dims=JSON.parse(doc.getTableDimensions(0,1,0));expect(dims).toMatchObject({rowCount:2,colCount:2});
  expect(doc.getTextInCell(0,1,0,2,0,0,4)).toBe('한글😀');expect(JSON.parse(doc.getCellParaPropertiesAt(0,1,0,2,0))).toMatchObject({alignment:'left',lineSpacing:180,lineSpacingType:'Percent'});
  expect(JSON.parse(doc.getCellCharPropertiesAt(0,1,0,2,0,2))).toMatchObject({fontSize:1100,bold:false,spacings:Array(7).fill(-2),fontFamilies:Array(7).fill('함초롬바탕')});
  expect(JSON.parse(doc.getParaPropertiesAt(0,2))).toMatchObject({alignment:'justify',lineSpacing:220,lineSpacingType:'Percent'});
 }
 it('creates an actual 2x2 table with cell and body formats, save/reopen and single Undo/Redo',async()=>{
  const f=fixture();try{const before=f.native.exportHwpx();await f.adapter.applyStructured(f.adapter.captureStructured(),v2());checkV2(f.native);const saved=f.native.exportHwpx(),opened=new HwpDocument(saved);try{checkV2(opened);}finally{opened.free();}f.undo();expect(f.native.exportHwpx()).toEqual(before);expect(f.history.canUndo()).toBe(false);f.history.redo(f.wasm);checkV2(f.native);
   if(process.env.ACHMAGE_STRUCTURED_EVIDENCE)writeFileSync(process.env.ACHMAGE_STRUCTURED_EVIDENCE+'/v2-table.hwpx',saved);
  }finally{f.close();}
 });
 it('rejects invalid v2 geometry, style references, spacing, and forged normalized paragraphs before mutation',async()=>{
  const f=fixture();try{const before=f.native.exportHwpx(),c=f.adapter.captureStructured();const invalid:unknown[]=[];
   const unequal=v2();(unequal.blocks[1].rows as unknown[][])[1].pop();invalid.push(unequal);
   const badstyle=v2();badstyle.blocks[0].runs![0].style='missing';invalid.push(badstyle);
   const badspacing=v2();badspacing.blocks[0].paragraphFormat!.lineSpacingPercent=0;invalid.push(badspacing);
   const normalized=parseStructuredPlan(v2());normalized.paragraphs[0].runs[0].text='forged';invalid.push(normalized);
   for(const p of invalid)await expect(f.adapter.applyStructured(c,p)).rejects.toThrow();expect(f.native.exportHwpx()).toEqual(before);expect(f.history.canUndo()).toBe(false);
  }finally{f.close();}
 });
 it('rolls back table creation and new styles when the shared render step fails',async()=>{
  const f=fixture();try{const before=f.native.exportHwpx();f.fail();await expect(f.adapter.applyStructured(f.adapter.captureStructured(),v2())).rejects.toThrow('injected render');expect(f.native.exportHwpx()).toEqual(before);expect(f.history.canUndo()).toBe(false);}finally{f.close();}
 });
 it('preserves initial section/column controls when two actual tables are the only blocks',async()=>{
  const f=fixture();try{const source=v2(),table=source.blocks[1],before=f.native.exportHwpx(),controls=JSON.parse(f.native.getControls());source.blocks=[table,structuredClone(table)];await f.adapter.applyStructured(f.adapter.captureStructured(),source);
   expect(f.native.getParagraphCount(0)).toBe(2);const after=JSON.parse(f.native.getControls());expect(after.filter((c:{ctrlId:string})=>c.ctrlId!=='tbl')).toEqual(controls);expect(after.filter((c:{ctrlId:string})=>c.ctrlId==='tbl')).toHaveLength(2);
   const opened=new HwpDocument(f.native.exportHwpx());try{expect(opened.getParagraphCount(0)).toBe(2);expect(opened.getTextInCell(0,0,2,0,0,0,2)).toBe('이름');expect(opened.getTextInCell(0,1,0,3,0,0,4)).toBe('실제 셀');}finally{opened.free();}f.undo();expect(f.native.exportHwpx()).toEqual(before);
  }finally{f.close();}
 });
 it('keeps preexisting paragraphs and their opaque styles unchanged around a table replacement',async()=>{
  const f=fixture();try{f.native.insertText(0,0,0,'앞');f.native.splitParagraph(0,0,1);f.native.insertText(0,1,0,'교체');f.native.splitParagraph(0,1,2);f.native.insertText(0,2,0,'뒤');f.native.applyCharFormat(0,2,0,1,JSON.stringify({italic:true,fontSize:2700}));const first=paragraphEvidence(f.wasm,0,0),last=paragraphEvidence(f.wasm,0,2),before=f.native.exportHwpx();const source=v2();source.blocks=[source.blocks[1]];
   await f.adapter.applyStructured(f.adapter.captureStructured({section:0,startParagraph:1,paragraphCount:1}),source);expect(paragraphEvidence(f.wasm,0,0)).toEqual(first);expect(paragraphEvidence(f.wasm,0,2)).toEqual(last);expect(f.native.getParagraphCount(0)).toBe(3);f.undo();expect(f.native.exportHwpx()).toEqual(before);
  }finally{f.close();}
 });
 it('restores the exact package and existing redo after a failure inside the second real table cell',async()=>{
  const f=fixture();try{const before=f.native.exportHwpx();await f.adapter.applyStructured(f.adapter.captureStructured(),plan);f.undo();expect(f.history.canRedo()).toBe(true);f.failCell();await expect(f.adapter.applyStructured(f.adapter.captureStructured(),v2())).rejects.toThrow('injected cell failure');expect(f.native.exportHwpx()).toEqual(before);expect(f.history.canUndo()).toBe(false);expect(f.history.canRedo()).toBe(true);f.history.redo(f.wasm);check(f.native);}finally{f.close();}
 });
 it('validates unused styles and limits total cells without accepting nested or empty cell substitutes',()=>{
  const unused=v2() as ReturnType<typeof v2> & {styles:Record<string,unknown>};unused.styles.bad={fontFamily:'bad;css',fontSizePt:11,bold:false,spacingPercent:0};expect(()=>parseStructuredPlan(unused)).toThrow();
  const over=v2();over.blocks=[{type:'table',rows:Array.from({length:11},()=>Array.from({length:10},()=>structuredClone(v2().blocks[1].rows![0][0])))}];expect(()=>parseStructuredPlan(over)).toThrow('100셀');
  const empty=v2();empty.blocks[1].rows![0][0].runs=[];expect(()=>parseStructuredPlan(empty)).toThrow();
 });
 it('inserts new styled blocks after the caret while retaining an existing real table, save/reopen and one Undo/Redo',async()=>{
  const f=fixture();try{await f.adapter.applyStructured(f.adapter.captureStructured(),v2());const before=f.native.exportHwpx(),oldTable=f.native.getTableProperties(0,1,0),oldCell=f.native.getTextInCell(0,1,0,2,0,0,4),oldChar=f.native.getCellCharPropertiesAt(0,1,0,2,0,2);
   const c=f.adapter.captureStructuredInsertion();expect(c.range.paragraphCount).toBe(0);await f.adapter.applyStructured(c,v2());expect(f.native.getParagraphCount(0)).toBe(6);expect(f.native.getTableProperties(0,1,0)).toBe(oldTable);expect(f.native.getTextInCell(0,1,0,2,0,0,4)).toBe(oldCell);expect(f.native.getCellCharPropertiesAt(0,1,0,2,0,2)).toBe(oldChar);
   const saved=f.native.exportHwpx(),opened=new HwpDocument(saved);try{expect(opened.getParagraphCount(0)).toBe(6);expect(opened.getTextInCell(0,1,0,2,0,0,4)).toBe(oldCell);expect(opened.getTextInCell(0,4,0,2,0,0,4)).toBe(oldCell);}finally{opened.free();}f.undo();expect(f.native.exportHwpx()).toEqual(before);f.history.redo(f.wasm);expect(f.native.getParagraphCount(0)).toBe(6);
   if(process.env.ACHMAGE_STRUCTURED_EVIDENCE)writeFileSync(process.env.ACHMAGE_STRUCTURED_EVIDENCE+'/v2-existing-table-insertion.hwpx',saved);
  }finally{f.close();}
 });
 it('preserves mixed-style prefix and suffix when inserting before an existing table at a middle caret',async()=>{
  const f=fixture();try{await f.adapter.applyStructured(f.adapter.captureStructured(),v2());f.native.applyCharFormat(0,0,0,2,JSON.stringify({italic:true,fontSize:1800}));const original=paragraphEvidence(f.wasm,0,0),before=f.native.exportHwpx();f.setCursor({sectionIndex:0,paragraphIndex:0,charOffset:2});await f.adapter.applyStructured(f.adapter.captureStructuredInsertion(),v2());
   expect(f.native.getParagraphCount(0)).toBe(7);expect(f.native.getTextRange(0,0,0,2)+f.native.getTextRange(0,4,0,f.native.getParagraphLength(0,4))).toBe(original.text);expect(f.native.getTextInCell(0,5,0,2,0,0,4)).toBe('한글😀');f.undo();expect(f.native.exportHwpx()).toEqual(before);
  }finally{f.close();}
 });
 it('rolls back insertion with existing tables on renderer failure, keeping the previous table package exact',async()=>{
  const f=fixture();try{await f.adapter.applyStructured(f.adapter.captureStructured(),v2());const before=f.native.exportHwpx(),c=f.adapter.captureStructuredInsertion();f.fail();await expect(f.adapter.applyStructured(c,v2())).rejects.toThrow('injected render');expect(f.native.exportHwpx()).toEqual(before);}finally{f.close();}
 });
 it('preserves an existing picture when creating blocks after its body anchor',async()=>{
  const f=fixture();try{const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1kAAAAASUVORK5CYII=','base64'));f.native.insertPicture(0,0,0,'[]',png,1000,1000,1,1,'png','owned test');const before=f.native.exportHwpx(),c=f.adapter.captureStructuredInsertion();await f.adapter.applyStructured(c,v2());expect(JSON.parse(f.native.getControls()).filter((x:{ctrlId:string})=>x.ctrlId==='gso')).toHaveLength(1);const opened=new HwpDocument(f.native.exportHwpx());try{expect(JSON.parse(opened.getControls()).filter((x:{ctrlId:string})=>x.ctrlId==='gso')).toHaveLength(1);}finally{opened.free();}f.undo();expect(f.native.exportHwpx()).toEqual(before);}finally{f.close();}
 });
 it('rejects grapheme-splitting caret, stale identity and forged insertion metadata without changing history',async()=>{
  const f=fixture();try{f.native.insertText(0,0,0,'é끝');f.setCursor({sectionIndex:0,paragraphIndex:0,charOffset:1});expect(()=>f.adapter.captureStructuredInsertion()).toThrow('결합');f.setCursor({sectionIndex:0,paragraphIndex:0,charOffset:2});const c=f.adapter.captureStructuredInsertion(),before=f.native.exportHwpx();c.insertion!.paragraph=99;await expect(f.adapter.applyStructured(c,v2())).rejects.toThrow('검증');expect(f.native.exportHwpx()).toEqual(before);const stale=f.adapter.captureStructuredInsertion();f.reopen();await expect(f.adapter.applyStructured(stale,v2())).rejects.toThrow('문서');expect(f.history.canUndo()).toBe(false);}finally{f.close();}
 });
 it('inserts after an existing table anchor without splitting or replacing that table',async()=>{
  const f=fixture();try{await f.adapter.applyStructured(f.adapter.captureStructured(),v2());const before=f.native.exportHwpx();f.setCursor({sectionIndex:0,paragraphIndex:1,charOffset:0});await f.adapter.applyStructured(f.adapter.captureStructuredInsertion(),v2());expect(f.native.getParagraphCount(0)).toBe(6);expect(f.native.getTextInCell(0,1,0,2,0,0,4)).toBe('한글😀');expect(f.native.getTextRange(0,5,0,f.native.getParagraphLength(0,5))).toBe('뒤 본문');f.undo();expect(f.native.exportHwpx()).toEqual(before);}finally{f.close();}
 });
 it('imports an explicitly selected merged-table source block through one shared snapshot and preserves the target',async()=>{
  const source=fixture(),target=fixture();try{await source.adapter.applyStructured(source.adapter.captureStructured(),v2());source.native.mergeTableCells(0,1,0,0,0,0,1);const bytes=source.native.exportHwpx(),sourceBefore=source.native.exportHwpx();target.native.insertText(0,0,0,'기존 문서');target.setCursor({sectionIndex:0,paragraphIndex:0,charOffset:5});const before=target.native.exportHwpx();await target.adapter.applyImportedDocument(target.adapter.captureStructuredInsertion(),bytes,{start:1,end:3});
   expect(target.native.getParagraphCount(0)).toBe(3);expect(target.native.getTextRange(0,0,0,5)).toBe('기존 문서');expect(JSON.parse(target.native.getTableDimensions(0,1,0))).toEqual(JSON.parse(source.native.getTableDimensions(0,1,0)));expect(target.native.getCellInfo(0,1,0,0)).toBe(source.native.getCellInfo(0,1,0,0));
   const dims=JSON.parse(source.native.getTableDimensions(0,1,0));for(let c=0;c<dims.cellCount;c++){const n=source.native.getCellParagraphLength(0,1,0,c,0);expect(target.native.getTextInCell(0,1,0,c,0,0,n)).toBe(source.native.getTextInCell(0,1,0,c,0,0,n));expect(JSON.parse(target.native.getCellCharPropertiesAt(0,1,0,c,0,0))).toEqual(JSON.parse(source.native.getCellCharPropertiesAt(0,1,0,c,0,0)));}
   const saved=target.native.exportHwpx(),opened=new HwpDocument(saved);try{expect(opened.getCellInfo(0,1,0,0)).toBe(source.native.getCellInfo(0,1,0,0));}finally{opened.free();}expect(source.native.exportHwpx()).toEqual(sourceBefore);target.undo();expect(target.native.exportHwpx()).toEqual(before);target.history.redo(target.wasm);expect(target.native.getParagraphCount(0)).toBe(3);
   if(process.env.ACHMAGE_STRUCTURED_EVIDENCE)writeFileSync(process.env.ACHMAGE_STRUCTURED_EVIDENCE+'/imported-merged-table.hwpx',saved);
  }finally{source.close();target.close();}
 });
 it('rejects full generated document with section controls without silently stripping its title or touching target history',async()=>{
  const source=fixture(),target=fixture();try{await source.adapter.applyStructured(source.adapter.captureStructured(),v2());const before=target.native.exportHwpx();await expect(target.adapter.applyImportedDocument(target.adapter.captureStructuredInsertion(),source.native.exportHwpx())).rejects.toThrow();expect(target.native.exportHwpx()).toEqual(before);expect(target.history.canUndo()).toBe(false);}finally{source.close();target.close();}
 });
 it('rolls back a successful native import when rendering fails, including registered resources',async()=>{
  const source=fixture(),target=fixture();try{await source.adapter.applyStructured(source.adapter.captureStructured(),v2());const before=target.native.exportHwpx();target.fail();await expect(target.adapter.applyImportedDocument(target.adapter.captureStructuredInsertion(),source.native.exportHwpx(),{start:1,end:3})).rejects.toThrow('injected render');expect(target.native.exportHwpx()).toEqual(before);expect(target.history.canUndo()).toBe(false);}finally{source.close();target.close();}
 });
 it('keeps existing redo after unsupported import and rejects stale source targets before mutation',async()=>{
  const source=fixture(),target=fixture();try{await source.adapter.applyStructured(source.adapter.captureStructured(),v2());await target.adapter.applyStructured(target.adapter.captureStructured(),plan);target.undo();const before=target.native.exportHwpx(),c=target.adapter.captureStructuredInsertion();await expect(target.adapter.applyImportedDocument(c,source.native.exportHwpx())).rejects.toThrow();expect(target.history.canRedo()).toBe(true);expect(target.native.exportHwpx()).toEqual(before);target.reopen();await expect(target.adapter.applyImportedDocument(c,source.native.exportHwpx(),{start:1,end:3})).rejects.toThrow('바뀌');expect(target.native.exportHwpx()).toEqual(before);}finally{source.close();target.close();}
 });
 it('rejects malformed source bytes and invalid explicit ranges without changing the target',async()=>{
  const source=fixture(),target=fixture();try{const before=target.native.exportHwpx(),c=target.adapter.captureStructuredInsertion();await expect(target.adapter.applyImportedDocument(c,new Uint8Array([1,2,3]))).rejects.toBeDefined();await expect(target.adapter.applyImportedDocument(c,source.native.exportHwpx(),{start:1,end:0})).rejects.toThrow('범위');expect(target.native.exportHwpx()).toEqual(before);expect(target.history.canUndo()).toBe(false);}finally{source.close();target.close();}
 });
 it('applies the exact six paragraphs and styles; save/reopen and one Undo/Redo',async()=>{
  const f=fixture();try{const before=f.native.exportHwpx(),controls=f.native.getControls(),c=f.adapter.captureStructured();await f.adapter.applyStructured(c,plan);check(f.native);expect(f.native.getControls()).toBe(controls);
   const result=f.native.exportHwpxWithReport();let saved:Uint8Array;try{expect(JSON.parse(result.contentLoss()).count).toBe(0);saved=result.takeBytes();}finally{result.free();}
   const opened=new HwpDocument(saved!);try{check(opened);}finally{opened.free();}
   if(process.env.ACHMAGE_STRUCTURED_EVIDENCE){mkdirSync(process.env.ACHMAGE_STRUCTURED_EVIDENCE,{recursive:true});writeFileSync(process.env.ACHMAGE_STRUCTURED_EVIDENCE+'/user-six-paragraphs.hwpx',saved!);writeFileSync(process.env.ACHMAGE_STRUCTURED_EVIDENCE+'/actual-char-properties.json',JSON.stringify(Array.from({length:6},(_,i)=>paragraphEvidence(f.wasm,0,i)),null,2));}
   f.history.undo(f.wasm);f.bus.emit('document-mutated');expect(f.native.exportHwpx()).toEqual(before);expect(f.history.canUndo()).toBe(false);f.history.redo(f.wasm);check(f.native);
  }finally{f.close();}
 });
 it('supports mixed runs and preserves both outside paragraphs through replacement and reopen',async()=>{
  const f=fixture();try{f.native.insertText(0,0,0,'앞쪽');f.native.splitParagraph(0,0,2);f.native.insertText(0,1,0,'교체');f.native.splitParagraph(0,1,2);f.native.insertText(0,2,0,'뒤쪽');
   f.native.applyCharFormat(0,0,0,2,JSON.stringify({italic:true,fontSize:1300}));f.native.applyCharFormat(0,2,0,2,JSON.stringify({spacings:Array(7).fill(9),bold:true}));
   const first=paragraphEvidence(f.wasm,0,0),last=paragraphEvidence(f.wasm,0,2);
   const p=parseStructuredPlan({schemaVersion:1,operation:'replace_paragraphs',paragraphs:[{runs:[{...plan.paragraphs[0].runs[0],text:'한글 '},{...plan.paragraphs[1].runs[0],text:'😀 é'}]},{runs:[{...plan.paragraphs[2].runs[0],text:'둘째'}]}]});
   await f.adapter.applyStructured(f.adapter.captureStructured({section:0,startParagraph:1,paragraphCount:1}),p);
   expect(paragraphEvidence(f.wasm,0,0)).toEqual(first);expect(paragraphEvidence(f.wasm,0,3)).toEqual(last);expect(f.native.getTextRange(0,1,0,7)).toBe('한글 😀 é');expect(JSON.parse(f.native.getCharPropertiesAt(0,1,3)).fontSize).toBe(1100);
   const reopened=new HwpDocument(f.native.exportHwpx());try{expect(JSON.parse(reopened.getCharPropertiesAt(0,1,3)).fontSize).toBe(1100);}finally{reopened.free();}
  }finally{f.close();}
 });
 it('rolls back after real mutation when render fails, preserving package and redo',async()=>{
  const f=fixture();try{const c=f.adapter.captureStructured(),before=f.native.exportHwpx();f.fail();await expect(f.adapter.applyStructured(c,plan)).rejects.toThrow('injected');expect(f.native.exportHwpx()).toEqual(before);expect(f.history.canUndo()).toBe(false);expect(f.adapter.isStructuredCurrent(c)).toBe(true);}finally{f.close();}
 });
 it('rejects stale capture, implicit overwrite and malformed plans before history mutation',async()=>{
  const f=fixture();try{const c=f.adapter.captureStructured();f.reopen();await expect(f.adapter.applyStructured(c,plan)).rejects.toThrow();f.native.insertText(0,0,0,'원문');expect(()=>f.adapter.captureStructured()).toThrow('전체');const explicit=f.adapter.captureStructured({section:0,startParagraph:0,paragraphCount:1});await expect(f.adapter.applyStructured(explicit,{...plan,eval:'bad'})).rejects.toThrow();expect(f.history.canUndo()).toBe(false);}finally{f.close();}
 });
 it('rejects unknown props, empty/control text, out-of-bounds metrics and split graphemes',()=>{
  const r=plan.paragraphs[0].runs[0];const p=(runs:unknown[])=>({schemaVersion:1,operation:'replace_paragraphs',paragraphs:[{runs}]});
  for(const patch of [{fontSizePt:Infinity},{spacingPercent:51},{text:'a\nline'},{text:''},{fontFamily:'bad;css'},{bold:1},{text:'\ud800'}])expect(()=>parseStructuredPlan(p([{...r,...patch}]))).toThrow();
  expect(()=>parseStructuredPlan(p([{...r,text:'e'},{...r,text:'́'}]))).toThrow('경계');
 });
 it('parses only the explicit annotated syntax, preserving spelling and rejecting prose',()=>{
  const result=parseAnnotatedDraft('[소제목 | 함초롱바탕, 15pt, 굵게, 자간 -5%]\n봄 학기 운영 안내\n\n[본문 | 신명조, 11pt, 보통, 자간 0%]\n밤하늘.');
  expect(result.paragraphs[0].runs[0].fontFamily).toBe('함초롱바탕');expect(result.paragraphs[1].runs[0].fontSizePt).toBe(11);expect(()=>parseAnnotatedDraft('설명을 문서에 넣습니다.')).toThrow();
 });
 it('replaces a selected mixed-style multi-paragraph body and restores all old styles with one Undo',async()=>{
  const f=fixture();try{f.native.insertText(0,0,0,'첫 원문');f.native.splitParagraph(0,0,4);f.native.insertText(0,1,0,'두 번째');f.native.applyCharFormat(0,0,0,1,JSON.stringify({bold:true,fontSize:2300}));f.native.applyCharFormat(0,1,0,2,JSON.stringify({italic:true,fontSize:900}));
   const before=f.native.exportHwpx();await f.adapter.applyStructured(f.adapter.captureStructured({section:0,startParagraph:0,paragraphCount:2}),plan);check(f.native);f.history.undo(f.wasm);expect(f.native.exportHwpx()).toEqual(before);
  }finally{f.close();}
 });
 it('rolls back a mid-operation failure including newly registered fonts and preserves redo',async()=>{
  const f=fixture();try{const original=f.native.exportHwpx();await f.adapter.applyStructured(f.adapter.captureStructured(),plan);f.undo();expect(f.history.canRedo()).toBe(true);const c=f.adapter.captureStructured();f.failStyle();await expect(f.adapter.applyStructured(c,plan)).rejects.toThrow('style failure');expect(f.native.exportHwpx()).toEqual(original);expect(f.history.canUndo()).toBe(false);expect(f.history.canRedo()).toBe(true);f.history.redo(f.wasm);check(f.native);
  }finally{f.close();}
 });
 it('rejects objects and tampered captures rather than overwrite controls or forged scope',async()=>{
  const f=fixture();try{const c=f.adapter.captureStructured();c.beforeParagraphs[0].text='forged';await expect(f.adapter.applyStructured(c,plan)).rejects.toThrow('검증');expect(f.history.canUndo()).toBe(false);
   const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1kAAAAASUVORK5CYII=','base64'));f.native.insertPicture(0,0,0,'[]',png,1000,1000,1,1,'png','owned test');
   expect(()=>f.adapter.captureStructured({section:0,startParagraph:0,paragraphCount:1})).toThrow('개체');
  }finally{f.close();}
 });
});

