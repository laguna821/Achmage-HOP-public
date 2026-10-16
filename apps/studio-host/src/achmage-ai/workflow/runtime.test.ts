import {describe,it,expect} from 'vitest';
import {decodeTool} from './protocol';
import {runWorkflow,type WorkflowHost} from './runtime';
import {WorkflowDraft} from './draft';
import {historyHarness,bodyDocument} from '../test-support/history-harness';
describe('provider-independent workflow loop',()=>{
 it.each(['openai','claude'])('inspects, stages and commits identically through %s',async()=>{
  const h=historyHarness(bodyDocument(['원문'])),d=new WorkflowDraft(h.wasm,h.adapter.identity());let turn=0;
  const host:WorkflowHost={ask:async()=>JSON.stringify(++turn===1?{tool:'edit',changes:[{id:d.read().nodes[0].id,text:'수정'}]}:{tool:'finish',text:'반영합니다.'}),commit:d=>d.commit(h.adapter),action:async()=>{},progress:()=>{}};
  try{const result=await runWorkflow({text:'좀 매끈하게',history:[]},d,host,new AbortController().signal);expect(result.changed).toBe(1);h.undo();expect(h.native.getTextFileUnicode()).toContain('원문');}finally{d.close();h.close();}
 });
 it('a vague answer never mutates the document',async()=>{
  const h=historyHarness(bodyDocument(['원문'])),d=new WorkflowDraft(h.wasm,h.adapter.identity());try{
   const r=await runWorkflow({text:'아 왜 이거 안했어?',history:[]},d,{ask:async()=>'{"tool":"answer","text":"어느 항목을 말씀하시나요?"}',commit:async()=>{throw Error('must not commit');},action:async()=>{},progress:()=>{}},new AbortController().signal);
   expect(r.changed).toBe(0);expect(h.history.canUndo()).toBe(false);
  }finally{d.close();h.close();}
 });
 it('does not commit after cancellation or malformed replies',async()=>{
  const c=new AbortController();let writes=0;
  const host:WorkflowHost={ask:async()=>{c.abort();return '{"tool":"finish","text":"done"}';},commit:async()=>{writes++;return {changed:1,message:''};},action:async()=>{},progress:()=>{}};
  await expect(runWorkflow({text:'해봐',history:[]},null,host,c.signal)).rejects.toThrow('중지');expect(writes).toBe(0);
  host.ask=async()=>'{broken';await expect(runWorkflow({text:'해봐',history:[]},null,host,new AbortController().signal)).rejects.toThrow('JSON');
 });
 it.each(['{"tool":"edit","shell":"rm","changes":[]}','{"tool":"read","offset":-1}','{"tool":"checkbox","checked":"false"}','{"tool":"answer"}'])('rejects malformed envelopes %s',text=>expect(()=>decodeTool(text)).toThrow());
});
it('recovers an unavailable font name through resource discovery before staging',async()=>{
 const h=historyHarness(bodyDocument(['본문'])),d=new WorkflowDraft(h.wasm,h.adapter.identity());let step=0;try{const id=d.read().nodes[0].id;
  const replies=[{tool:'format',ids:[id],format:{fontFamily:'신명조'}},{tool:'fonts',query:'신명조'},{tool:'format',ids:[id],format:{fontFamily:'HY신명조',fontSizePt:11}},{tool:'finish',text:'설치된 HY신명조를 적용합니다.'}];
  const result=await runWorkflow({text:'신명조로',history:[]},d,{fonts:async()=>['HY신명조'],ask:async p=>{if(step===1)expect(p).toContain('fonts 도구');if(step===2)expect(p).toContain('HY신명조');return JSON.stringify(replies[step++]);},commit:d=>d.commit(h.adapter),action:async()=>{},progress:()=>{}},new AbortController().signal);
  expect(result.changed).toBe(1);expect(JSON.parse(h.native.getCharPropertiesAt(0,0,0)).fontFamilies).toEqual(Array(7).fill('HY신명조'));
 }finally{d.close();h.close();}
});
