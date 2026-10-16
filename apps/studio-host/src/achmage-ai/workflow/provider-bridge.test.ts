import {it,expect} from 'vitest';
import {AiConnection,type AiState} from '../bridge';
import {WorkflowModelClient} from './provider-bridge';
const base=(provider:AiState['selectedProvider']):AiState=>({generation:1,selectedProvider:provider,providers:[],auth:{status:'signed_in',sessionGeneration:'a'},usage:{},turn:null});
for(const provider of ['openai','claude','gemini','grok'] as const)it(`${provider} keeps request identity and uses the same JSON contract`,async()=>{
 let state=base(provider),sent='';let client:WorkflowModelClient;
 const c=new AiConnection({state:async()=>state,action:async(_g,a)=>{if(a.type==='send'){sent=a.prompt;state={...state,generation:2,turn:{id:'t',requestId:a.requestId,status:'completed',text:'{"tool":"answer","text":"읽었습니다"}'}};}return state;}},()=>client?.accept(c.current));client=new WorkflowModelClient(c);await c.refresh();
 expect(JSON.parse(await client.ask('내용 읽어봐',new AbortController().signal,{})).text).toBe('읽었습니다');expect(sent).toBe('내용 읽어봐');
});
it('cancelled requests reject and cannot be completed by a late response',async()=>{
 let state=base('claude');let client:WorkflowModelClient;const c=new AiConnection({state:async()=>state,action:async(_g,a)=>{if(a.type==='send')state={...state,turn:{id:'t',requestId:a.requestId,status:'running'}};return state;}},()=>client?.accept(c.current));client=new WorkflowModelClient(c);await c.refresh();
 const abort=new AbortController(),pending=client.ask('요청',abort.signal,{});abort.abort();await expect(pending).rejects.toThrow('중지');
 client.accept({...state,turn:state.turn?{...state.turn,status:'completed',text:'late'}:null});
});
