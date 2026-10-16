import {describe,it,expect} from 'vitest';
import {historyHarness,bodyDocument} from './test-support/history-harness';
import {buildDocumentStateCard} from './document-state-card';
import {offerOperations} from './intent-router';

describe('existing blank form cells through AiDocument',()=>{
 const fixture=()=>{
  const h=historyHarness(bodyDocument(['앞 문단','']));
  const t=JSON.parse(h.native.createTable(0,1,0,2,2));
  h.native.insertTextInCell(0,t.paraIdx,t.controlIdx,0,0,0,'수업개요');
  const position={sectionIndex:0,paragraphIndex:0,charOffset:0,parentParaIndex:t.paraIdx,controlIndex:t.controlIdx,cellIndex:1,cellParaIndex:0};
  h.cellCaret(position);
  const text=()=>h.native.getTextInCell(0,t.paraIdx,t.controlIdx,1,0,0,h.native.getCellParagraphLength(0,t.paraIdx,t.controlIdx,1,0));
  return {h,t,position,text};
 };
 it('routes an empty cell, writes only there, and undoes in one step',async()=>{
  const {h,t,position,text}=fixture();
  try{
   const card=buildDocumentStateCard(h.wasm,{getSelection:()=>null,getCursorPosition:()=>position},null);
   expect(card.selection).toMatchObject({emptyCell:true,inTable:true});
   expect(offerOperations(card).find(o=>o.id==='edit_selection')?.available).toBe(true);
   const before=h.native.getTableDimensions(0,t.paraIdx,t.controlIdx);
   await h.adapter.apply(h.adapter.captureSelection(),'미디어콘텐츠 바이브코딩\n협력기업 연계 PBL');
   expect(text()).toBe('미디어콘텐츠 바이브코딩');
   expect(h.native.getTableDimensions(0,t.paraIdx,t.controlIdx)).toBe(before);
   expect(h.native.getTextInCell(0,t.paraIdx,t.controlIdx,0,0,0,4)).toBe('수업개요');
   h.undo();expect(text()).toBe('');expect(h.history.canUndo()).toBe(false);
  }finally{h.close();}
 });
 it('rejects a stale cell target after moving to another cell',async()=>{
  const {h,position,text}=fixture();
  try{const c=h.adapter.captureSelection();h.cellCaret({...position,cellIndex:3});await expect(h.adapter.apply(c,'잘못된 입력')).rejects.toThrow();expect(text()).toBe('');}finally{h.close();}
 });
});
