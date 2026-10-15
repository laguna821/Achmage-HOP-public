import { invoke } from '@tauri-apps/api/core';
import { registerPanelAction } from './panel-events';
import './runtime-tools.css';

export interface RuntimeView { generation:number; phase:string; version:string|null; installed:boolean; bytes:number|null; sha512:string|null; message:string }
export type RuntimeTransport=(request:{op:'state'|'install'|'cancel';expectedGeneration?:number})=>Promise<RuntimeView>;
export function runtimeBusy(view:RuntimeView|null):boolean{return !!view&&['checking','downloading','cancelling'].includes(view.phase);}
/** Installs only the fixed official Google runtime; credentials and arbitrary paths never cross this API. */
export function installRuntimeTools(transport:RuntimeTransport=request=>invoke('achmage_runtime',{request})):()=>void {
  const dialog=document.createElement('dialog');dialog.className='achmage-runtime-dialog';
  dialog.innerHTML='<h2>Gemini 연결 준비</h2><p>Google 공식 연결 도구의 설치와 업데이트를 관리합니다. 이미 연결되어 있다면 별도 작업 없이 대화할 수 있습니다.</p><p class="runtime-status" role="status"></p><p class="runtime-version"></p><footer><button data-runtime="close">닫기</button><button data-runtime="cancel" hidden>설치 취소</button><button data-runtime="install" disabled>설치 확인</button></footer>';
  document.body.append(dialog);
  const status=dialog.querySelector<HTMLElement>('.runtime-status')!,version=dialog.querySelector<HTMLElement>('.runtime-version')!;
  const button=(name:string)=>dialog.querySelector<HTMLButtonElement>(`[data-runtime="${name}"]`)!;
  let view:RuntimeView|null=null,pending=false,disposed=false,ticket=0;
  function render():void{const busy=runtimeBusy(view);button('install').disabled=pending||!view||busy;button('install').textContent=view?.installed?'업데이트 확인':'설치';button('cancel').hidden=!busy;button('cancel').disabled=pending||view?.phase==='cancelling';version.textContent=view?.version?`앱 전용 버전 ${view.version}`:'';}
  async function action(op:'state'|'install'|'cancel'):Promise<void>{
    if(pending||disposed)return;pending=true;const own=++ticket;render();
    try{const next=await transport({op,...(op==='state'?{}:{expectedGeneration:view?.generation})});if(disposed||own!==ticket)return;if(view&&next.generation<view.generation)return;view=next;status.textContent=next.message;}
    catch{if(!disposed&&own===ticket)status.textContent='런타임 상태를 확인하지 못했습니다. 데스크톱 앱에서 다시 시도하세요.';}
    finally{if(!disposed&&own===ticket){pending=false;render();}}
  }
  button('close').onclick=()=>dialog.close();
  button('install').onclick=()=>{void action('install');};button('cancel').onclick=()=>{void action('cancel');};
  const remove=registerPanelAction({id:'google-runtime',label:'Google 런타임',run:()=>{if(!dialog.open)dialog.showModal();void action('state');}});
  const timer=window.setInterval(()=>{if(dialog.open)void action('state');},800);
  return()=>{disposed=true;ticket++;clearInterval(timer);remove();dialog.close();dialog.remove();};
}
