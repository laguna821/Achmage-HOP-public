/** Opt-in synthetic live evaluation. No user files, shell tools or MCP access. */
import {it,expect} from 'vitest';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {historyHarness,bodyDocument} from '../test-support/history-harness';
import {WorkflowDraft} from './draft';
import {runWorkflow} from './runtime';
function ask(prompt:string):Promise<string>{return new Promise((resolve,reject)=>{
 const p=spawn(process.env.HOP_CLAUDE_BIN??'claude',['-p','--output-format','json','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--setting-sources','','--restricted','--no-session-persistence'],{cwd:tmpdir(),stdio:['pipe','pipe','pipe']});let out='';p.stdout.on('data',c=>out+=c);p.stderr.resume();const timer=setTimeout(()=>{p.kill('SIGTERM');reject(Error('live provider timeout'));},120000);p.on('error',reject);p.on('close',code=>{clearTimeout(timer);if(code!==0){reject(Error('live provider exit '+code));return;}try{resolve(JSON.parse(out).result);}catch(e){reject(e);}});p.stdin.end(prompt);
});}
const live=process.env.HOP_LIVE_WORKFLOW==='1'?it:it.skip;
for(const text of ['수업개요 빈칸에 미디어콘텐츠 바이브코딩 PBL이라고 써줘. 서식 유지.','개요쪽 비엇네 거따 미디어콘텐츠 바이브코딩 PBL 넣어바','표 맨밑에 두줄 더해줘','고치지 말고 빈칸이 뭐 있는지만 알려줘','아 왜 이거 안했어?'])live(text,async()=>{
 const h=historyHarness(bodyDocument(['신청서',''])),t=JSON.parse(h.native.createTable(0,1,0,2,2));h.native.insertTextInCell(0,t.paraIdx,t.controlIdx,0,0,0,'수업개요');h.native.insertTextInCell(0,t.paraIdx,t.controlIdx,2,0,0,'교육목표');const d=new WorkflowDraft(h.wasm,h.adapter.identity());
 try{const result=await runWorkflow({text,history:[]},d,{ask,commit:d=>d.commit(h.adapter),action:async()=>{throw Error('No recreation authorized');},progress:()=>{}},new AbortController().signal);
  if(text.startsWith('고치지')||text.startsWith('아 왜')){expect(result.changed).toBe(0);expect(h.history.canUndo()).toBe(false);}
  else if(text.startsWith('표'))expect(JSON.parse(h.native.getTableDimensions(0,t.paraIdx,t.controlIdx)).rowCount).toBe(4);
  else expect(h.native.getTextInCell(0,t.paraIdx,t.controlIdx,1,0,0,100)).toContain('미디어콘텐츠 바이브코딩');
  console.log(JSON.stringify({case:text,changed:result.changed,steps:result.steps}));
 }finally{d.close();h.close();}
},300000);
live('follow-up keeps the course brief and completes the omitted field',async()=>{
 const h=historyHarness(bodyDocument(['신청서',''])),t=JSON.parse(h.native.createTable(0,1,0,2,2));h.native.insertTextInCell(0,t.paraIdx,t.controlIdx,0,0,0,'수업개요');h.native.insertTextInCell(0,t.paraIdx,t.controlIdx,2,0,0,'교육목표');
 const history:{role:string;text:string}[]=[];const brief='미디어콘텐츠 바이브코딩 과목이야. 학부 3-4학년이 옵시디언 GitHub Claude Code Codex로 HTML 슬라이드와 웹을 만드는 PBL이고 더픽트와 해커톤 출품을 목표로 해. 수업개요부터 그 칸에 채워줘.';
 try{for(const text of [brief,'아 목표는 왜 안했어 거기도 마저 해']){const d=new WorkflowDraft(h.wasm,h.adapter.identity());try{const r=await runWorkflow({text,history},d,{ask,commit:d=>d.commit(h.adapter),action:async()=>{throw Error('must preserve form');},progress:()=>{}},new AbortController().signal);history.push({role:'user',text},{role:'assistant',text:r.text});}finally{d.close();}}
  const all=h.native.getTextFileUnicode();expect(all).toContain('바이브코딩');expect(h.native.getCellParagraphLength(0,t.paraIdx,t.controlIdx,3,0)).toBeGreaterThan(0);expect(all).not.toContain('지역사회 문제를');
 }finally{h.close();}
},300000);
for(const wording of ['체크된거 싹~~~다 해제 ㄱㄱ','싸그리 다 몽~땅 풀어봐','체크는 건들지 말고 몇개인지 알려줘'])live(wording,async()=>{
 const {readFileSync}=await import('node:fs');const {checkboxTargets}=await import('../checkbox-edit');const {bridgeFor}=await import('./document-map');
 const h=historyHarness(readFileSync(new URL('../../../../../third_party/rhwp/samples/hwpx/form-002.hwpx',import.meta.url)));const all=checkboxTargets(bridgeFor(h.native));for(const t of all){if(t.inCell)h.native.setFormValueInCell(t.sec!,t.tablePara!,t.tableCi!,t.cellIdx!,t.cellPara!,t.ci!,'{"value":1}');else h.native.setFormValue(t.sec!,t.para!,t.ci!,'{"value":1}');}const d=new WorkflowDraft(h.wasm,h.adapter.identity());
 try{const r=await runWorkflow({text:wording,history:wording.startsWith('싸그리')?[{role:'user',text:'체크박스를 해제해줘'},{role:'assistant',text:'어느 체크박스를 해제할까요?'}]:[]},d,{ask,commit:d=>d.commit(h.adapter),action:async()=>{throw Error('must preserve');},progress:()=>{}},new AbortController().signal);expect(checkboxTargets(bridgeFor(h.native)).every(t=>t.value===(wording.startsWith('체크는')?1:0))).toBe(true);if(wording.startsWith('체크는'))expect(r.changed).toBe(0);}finally{d.close();h.close();}
},300000);
