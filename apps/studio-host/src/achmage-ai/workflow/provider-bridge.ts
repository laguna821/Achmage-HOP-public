import {authSession,sameAuthSession,type AiConnection,type AiState} from '../bridge';
import {maskPersonal,restorePersonal} from '../outbound-gate';
/** Converts every provider into one cancellable text turn. Authentication remains provider-owned. */
export class WorkflowModelClient {
 private pending:{id:string;session:string;provider:string;accept:(text:string)=>void;reject:(error:Error)=>void;cleanup:()=>void}|null=null;
 constructor(private connection:AiConnection){}
 accept(state:AiState|null):void {
  const p=this.pending;if(!p||!state)return;
  if(!sameAuthSession(state,p.session)||state.selectedProvider!==p.provider){this.fail('계정 또는 공급자가 바뀌어 작업을 중지했습니다.');return;}
  const t=state.turn;if(t?.requestId!==p.id)return;
  if(t.status==='completed'){this.pending=null;p.cleanup();p.accept(t.text??'');}
  else if(t.status==='error'||t.status==='cancelled')this.fail(t.message||'AI 요청을 완료하지 못했습니다. 원문은 변경하지 않았습니다.');
 }
 fail(message:string):void {const p=this.pending;this.pending=null;if(p){p.cleanup();p.reject(Error(message));}}
 ask(prompt:string,signal:AbortSignal,options:{model?:string;reasoningEffort?:string}):Promise<string> {
  if(signal.aborted)return Promise.reject(Error('요청을 중지했습니다.'));
  if(this.pending)return Promise.reject(Error('앞선 AI 요청을 기다리고 있습니다.'));
  const state=this.connection.current,session=authSession(state);if(!session||!state)return Promise.reject(Error('AI 계정을 연결하세요.'));
  const id=crypto.randomUUID(),mask=maskPersonal(prompt);
  return new Promise((resolve,reject)=>{
   const abort=()=>{const turn=this.connection.current?.turn;this.fail('요청을 중지했습니다. 임시 변경은 반영하지 않았습니다.');if(turn?.requestId===id&&turn.id&&!this.connection.busy)void this.connection.send({type:'cancel_turn',turnId:turn.id}).catch(()=>{});};
   signal.addEventListener('abort',abort,{once:true});
   this.pending={id,session,provider:state.selectedProvider,cleanup:()=>signal.removeEventListener('abort',abort),reject,accept:text=>{
    // Decode escapes before restoring masked string values; never restore into JSON syntax.
    try{const raw=text.trim().replace(/^```(?:json)?\s*/u,'').replace(/\s*```$/u,'');const parsed=JSON.parse(raw);const walk=(v:any):any=>{
      if(typeof v==='string'){const r=restorePersonal(v,mask);if(r.unknown.length)throw Error('응답에 알 수 없는 개인정보 표시가 있습니다.');return r.text;}
      if(Array.isArray(v))return v.map(walk);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)]));return v;
     };resolve(JSON.stringify(walk(parsed)));
    }catch(error){if(error instanceof SyntaxError)resolve(text);else reject(error);}
   }};
   void this.connection.send({type:'send',prompt:mask.text,requestId:id,...options}).then(()=>{if(signal.aborted)abort();else this.accept(this.connection.current);},()=>this.fail('AI 연결 요청에 실패했습니다. 원문은 변경하지 않았습니다.'));
  });
 }
}
