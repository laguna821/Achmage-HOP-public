import {describe,it,expect} from 'vitest';
import {HwpDocument} from '../../../vendor/rhwp-core/rhwp.js';
import {historyHarness,bodyDocument} from '../test-support/history-harness';
import {WorkflowDraft} from './draft';
function fixture(){const h=historyHarness(bodyDocument(['PBL 신청서','보존할 내용','']));const t=JSON.parse(h.native.createTable(0,2,0,2,2));for(const [cell,text] of [[0,'수업개요'],[2,'교육목표']] as const)h.native.insertTextInCell(0,t.paraIdx,t.controlIdx,cell,0,0,text);return h;}
describe('atomic document workflow',()=>{
 it('fills two unselected form cells, rehearses privately and commits with one Undo',async()=>{
  const h=fixture(),draft=new WorkflowDraft(h.wasm,h.adapter.identity());try{
   const nodes=draft.read().nodes.filter(n=>n.kind==='cell'&&n.col===1);
   draft.edit(nodes.map((n,i)=>({id:n.id,text:['바이브코딩 PBL\n16주 프로젝트','협업과 검증'][i]})));
   expect(h.native.getTextFileUnicode()).not.toContain('바이브코딩');
   const r=await draft.commit(h.adapter);expect(r.changed).toBe(2);
   expect(h.native.getTextFileUnicode()).toContain('바이브코딩');expect(h.native.getTextFileUnicode()).toContain('보존할 내용');
   const reopened=new HwpDocument(h.native.exportHwpx());expect(reopened.getTextFileUnicode()).toContain('협업과 검증');reopened.free();
   await expect(draft.commit(h.adapter)).rejects.toThrow('이미');h.undo();expect(h.native.getTextFileUnicode()).not.toContain('바이브코딩');expect(h.history.canUndo()).toBe(false);
  }finally{draft.close();h.close();}
 });
 it('does not overwrite concurrent user input',async()=>{
  const h=fixture(),d=new WorkflowDraft(h.wasm,h.adapter.identity());try{
   d.edit([{id:d.read().nodes[1].id,text:'AI'}]);h.native.insertText(0,1,0,'사용자');
   await expect(d.commit(h.adapter)).rejects.toThrow('변경');expect(h.native.getTextFileUnicode()).toContain('사용자');
  }finally{d.close();h.close();}
 });
 it('rolls back all edits if rendering fails',async()=>{
  const h=fixture(),d=new WorkflowDraft(h.wasm,h.adapter.identity());try{
   d.edit([{id:d.read().nodes[1].id,text:'새 내용'}]);h.failRender();await expect(d.commit(h.adapter)).rejects.toThrow();expect(h.native.getTextFileUnicode()).toContain('보존할 내용');
  }finally{d.close();h.close();}
 });
 it('discarding a staged edit changes neither the live document nor its history',()=>{
  const h=fixture(),d=new WorkflowDraft(h.wasm,h.adapter.identity());try{d.edit([{id:d.read().nodes[1].id,text:'취소'}]);d.close();expect(h.native.getTextFileUnicode()).not.toContain('취소');expect(h.history.canUndo()).toBe(false);}finally{d.close();h.close();}
 });
 it('validates all targets before applying any and keeps repeated phrases ambiguous',()=>{
  const h=fixture(),d=new WorkflowDraft(h.wasm,h.adapter.identity());try{
   const n=d.read().nodes[1];expect(()=>d.edit([{id:n.id,text:'a'},{id:'invented',text:'b'}])).toThrow();expect(d.pending).toBe(0);
   expect(()=>d.edit([{id:n.id,before:'없는 말',text:'a'}])).toThrow();
  }finally{d.close();h.close();}
 });
});
it('keeps partial selection boundaries exactly, including emoji',async()=>{
 const h=historyHarness(bodyDocument(['앞😀 선택 뒤','보존']));h.select(0,3,0,6);const c=h.adapter.captureSelection();
 const d=new WorkflowDraft(h.wasm,h.adapter.identity(),c.multi);try{d.editSelection('수정');await d.commit(h.adapter);expect(h.native.getTextRange(0,0,0,h.native.getParagraphLength(0,0))).toBe('앞😀 수정뒤');h.undo();expect(h.native.getTextFileUnicode()).toContain('앞😀 선택 뒤');}finally{d.close();h.close();}
});
it('formats only selected characters and preserves adjacent text and font',async()=>{
 const h=historyHarness(bodyDocument(['앞 선택 뒤']));h.select(0,2,0,4);const d=new WorkflowDraft(h.wasm,h.adapter.identity(),h.adapter.captureSelection().multi);try{const before=JSON.parse(h.native.getCharPropertiesAt(0,0,0));d.formatSelection({bold:true});await d.commit(h.adapter);expect(JSON.parse(h.native.getCharPropertiesAt(0,0,2)).bold).toBe(true);expect(JSON.parse(h.native.getCharPropertiesAt(0,0,0))).toEqual(before);expect(h.native.getTextFileUnicode()).toContain('앞 선택 뒤');h.undo();expect(JSON.parse(h.native.getCharPropertiesAt(0,0,2)).bold).toBe(false);}finally{d.close();h.close();}
});
