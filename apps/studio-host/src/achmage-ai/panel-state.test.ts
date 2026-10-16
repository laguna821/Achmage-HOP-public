import { conversationContext } from './panel-state';
import { describe, it, expect } from 'vitest';
import { panelWidth, loadHistory, saveHistory, addHistory, boundedHistory, acceptsCompletion, unwrapQuotedReply, CHAT_STORAGE_KEY, MAX_CHAT_BYTES, type ChatEntry } from './panel-state';
import { registerPanelAction, watchPanelActions } from './panel-events';
const entry = (id:string,text='한글'):ChatEntry => ({id,provider:'openai',role:'user',text,at:1});
const storage = () => { const data=new Map<string,string>(); return { getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);} }; };
describe('panel local state',()=>{
  it('clamps resizing and invalid preference values',()=>{ expect([panelWidth(10),panelWidth(1000),panelWidth(NaN),panelWidth(399.6)]).toEqual([320,560,380,400]); });
  it('restores display-only messages with an allowlist and strips unexpected secret fields',()=>{const s=storage();s.setItem(CHAT_STORAGE_KEY,JSON.stringify([{...entry('a'),accessToken:'must-not-copy'},entry('b','<img src=x onerror=alert(1)>'),{...entry('x'),role:'system'}]));const data=loadHistory(s);expect(data).toHaveLength(2);expect(data[0]).not.toHaveProperty('accessToken');expect(data[1].text).toContain('<img');});
  it('rejects oversized and malformed persistence without failing the app',()=>{const s=storage();s.setItem(CHAT_STORAGE_KEY,'[');expect(loadHistory(s)).toEqual([]);s.setItem(CHAT_STORAGE_KEY,'x'.repeat(MAX_CHAT_BYTES+1));expect(loadHistory(s)).toEqual([]);expect(loadHistory({ ...s,getItem:()=>{throw new Error('blocked');} })).toEqual([]);});
  it('bounds Unicode byte storage and retains newest messages',()=>{const data=boundedHistory(Array.from({length:130},(_,i)=>entry(String(i),'한'.repeat(3000))));expect(data.at(-1)?.id).toBe('129');expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeLessThanOrEqual(MAX_CHAT_BYTES);expect(data.length).toBeLessThanOrEqual(100);});
  it('updates each reply once without losing the paired user entry',()=>{let list=addHistory([],entry('a'));list=addHistory(list,{...entry('a','reply'),role:'assistant'});list=addHistory(list,{...entry('a','final'),role:'assistant'});expect(list.map(v=>v.text)).toEqual(['한글','final']);});
  it('reports quota denial while keeping callers memory data intact',()=>{const data=[entry('a')];expect(saveHistory({...storage(),setItem:()=>{throw new Error('quota');}},data)).toBe(false);expect(data).toEqual([entry('a')]);});
  it('requires both account generation and matching request for completion',()=>{const request={id:'mine',session:'a'};expect(acceptsCompletion(request,'a',{requestId:'mine',status:'completed'})).toBe(true);for(const session of ['b',null])expect(acceptsCompletion(request,session,{requestId:'mine',status:'completed'})).toBe(false);expect(acceptsCompletion(request,'a',{requestId:'old',status:'completed'})).toBe(false);expect(acceptsCompletion(request,'a',{requestId:'mine',status:'running'})).toBe(false);});
  it('registers only real extensions and removes them when disposed',()=>{const seen:string[][]=[];const stop=watchPanelActions(actions=>seen.push(actions.map(a=>a.id)));const remove=registerPanelAction({id:'test-real',label:'실제도구',run(){}});expect(()=>registerPanelAction({id:'test-real',label:'duplicate',run(){}})).toThrow();remove();stop();expect(seen).toEqual([[],['test-real'],[]]);});
});
describe('quoted reply cleanup', () => {
  it('removes echoed outer quotes the original did not have, and only then', () => {
    expect(unwrapQuotedReply('"010-1234-5678로 연락 바랍니다"', '010-1234-5678 로 연락 바랍니다')).toBe('010-1234-5678로 연락 바랍니다');
    expect(unwrapQuotedReply('"첫 줄\n둘째 줄"', '첫 줄\n둘째')).toBe('첫 줄\n둘째 줄');
    expect(unwrapQuotedReply('\u201c정리된 문장\u201d', '정리 문장')).toBe('정리된 문장');
    expect(unwrapQuotedReply('"A" 그리고 "B"', 'A 그리고 B')).toBe('"A" 그리고 "B"');
    expect(unwrapQuotedReply('"인용"', '"인용 원문"')).toBe('"인용"');
    expect(unwrapQuotedReply('그대로', '원문')).toBe('그대로');
  });
});

it('retains the course brief through repeated clarifications', () => {
  const brief = '미디어콘텐츠 바이브코딩 ' + '설명'.repeat(400) + ' 협력기업 16주 PBL';
  const entries = Array.from({length:30},(_,i)=>({id:String(i),provider:'openai' as const,role:'user' as const,text:i ? '수업개요와 교육목표부터' : brief,at:i}));
  const context = conversationContext(entries,'openai');
  expect(context[0].text).toBe(brief);
  expect(context).toHaveLength(24);
  expect(conversationContext([],'openai')).toEqual([]);
});
