import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {historyHarness,bodyDocument} from '../test-support/history-harness';
import {WorkflowDraft} from './draft';
import {checkboxTargets} from '../checkbox-edit';
import {bridgeFor} from './document-map';
function form(){const h=historyHarness(bodyDocument(['제목','']));const t=JSON.parse(h.native.createTable(0,1,0,3,2));h.native.insertTextInCell(0,t.paraIdx,t.controlIdx,0,0,0,'라벨 보존');return h;}
it('adds rows, reads the new map, fills an added cell and undoes once',async()=>{
 const h=form(),d=new WorkflowDraft(h.wasm,h.adapter.identity());try{
  const table=d.read().nodes.find(n=>n.kind==='table')!;d.control({tool:'table',id:table.id,operation:'insert_rows',index:3,count:2});
  const newCell=d.read().nodes.find(n=>n.kind==='cell'&&n.row===4&&n.col===1)!;d.edit([{id:newCell.id,text:'새 주차 내용'}]);
  await d.commit(h.adapter);expect(h.native.getTextFileUnicode()).toContain('새 주차 내용');expect(h.native.getTextFileUnicode()).toContain('라벨 보존');h.undo();expect(h.native.getTextFileUnicode()).not.toContain('새 주차 내용');expect(h.history.canUndo()).toBe(false);
 }finally{d.close();h.close();}
});
for(const operation of ['insert_columns','delete_rows','delete_columns','merge','split'])it(`validates ${operation} on the private engine`,()=>{
 const h=form(),d=new WorkflowDraft(h.wasm,h.adapter.identity());try{
  let table=d.read().nodes.find(n=>n.kind==='table')!;
  if(operation==='split'){d.control({tool:'table',id:table.id,operation:'merge',startRow:1,startCol:0,endRow:1,endCol:1});table=d.read().nodes.find(n=>n.kind==='table')!;}
  d.control({tool:'table',id:table.id,operation,index:1,startRow:1,startCol:0,endRow:1,endCol:1});expect(d.pending).toBeGreaterThan(0);
 }finally{d.close();h.close();}
});
it('rejects out-of-bounds deletion without partial changes',()=>{
 const h=form(),d=new WorkflowDraft(h.wasm,h.adapter.identity());try{const table=d.read().nodes.find(n=>n.kind==='table')!,before=d.map.fingerprint();expect(()=>d.control({tool:'table',id:table.id,operation:'delete_rows',index:1,count:4})).toThrow();expect(d.map.fingerprint()).toBe(before);expect(d.pending).toBe(0);}finally{d.close();h.close();}
});
it('sets real checkbox controls, saves, reopens and rolls back all with one Undo',async()=>{
 const h=historyHarness(readFileSync(new URL('../../../../../third_party/rhwp/samples/hwpx/form-002.hwpx',import.meta.url))),d=new WorkflowDraft(h.wasm,h.adapter.identity());try{
  const original=checkboxTargets(bridgeFor(h.native));d.control({tool:'checkbox',checked:true});d.control({tool:'checkbox',checked:false});await d.commit(h.adapter);expect(checkboxTargets(bridgeFor(h.native)).every(t=>t.value===0)).toBe(true);h.undo();expect(checkboxTargets(bridgeFor(h.native)).map(t=>t.value)).toEqual(original.map(t=>t.value));
 }finally{d.close();h.close();}
});
