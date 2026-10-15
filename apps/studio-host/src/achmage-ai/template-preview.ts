import {parseDocumentTemplate,templateLayout,TEMPLATE_ROLE_LABELS,type DocumentTemplate,type TemplateRole} from './document-templates';
import {generateKordocDocument} from './kordoc-engine';
/** Translate only recognized warnings; unknown engine findings remain available verbatim. */
export function previewWarningText(warning:string):string{
 if(warning.startsWith('보고서 요약박스가 없습니다'))return '보고 목적을 정리한 요약 상자가 없습니다. 필요하면 작성 요청에 “보고 목적을 ‘…하고자 함’으로 끝나는 한 문장, 3줄 이내의 요약 상자로 넣어 주세요”라고 덧붙이세요.';
 if(warning==='목차는 소제목 목록입니다. 자동 쪽번호 필드는 아직 제공하지 않습니다.'||warning==='목차는 Kordoc 원본 구성입니다. 자동 쪽번호 필드는 제공하지 않습니다.')return '목차에 자동으로 갱신되는 쪽번호가 없습니다. 최종 편집을 마친 뒤 목차와 본문 쪽번호를 확인하세요.';
 if(warning==='미리보기는 Kordoc 조판 결과입니다. 로컬 글꼴 유무와 HOP/한글의 조판 결과는 다를 수 있습니다.')return '미리보기와 실제 편집 화면은 설치된 글꼴이나 문서 배치 방식에 따라 다를 수 있습니다. 저장할 문서의 줄바꿈과 쪽나눔을 확인하세요.';
 const fallback=/^기관 (.+): 보고서 실측 규칙이 없어 공통 서식을 사용합니다\.$/u.exec(warning);
 if(fallback)return fallback[1]+'의 보고서 서식 자료가 없어 공통 보고서 스타일을 사용했습니다. 제출 전 해당 기관의 서식 기준을 확인하세요.';
 const agency=/^기관 (.+)의 엔진 기본 서식을 사용합니다\. 명시한 역할만 덮어씁니다: (.+)\. 공식 제출 수용 인증은 아닙니다\.$/u.exec(warning);
 if(agency){const keys=agency[2].split(', ').filter(k=>k!=='없음');if(keys.every(k=>Object.hasOwn(TEMPLATE_ROLE_LABELS,k)))return agency[1]+'의 배포 스타일을 사용했습니다. '+(keys.length?keys.map(k=>TEMPLATE_ROLE_LABELS[k as TemplateRole]).join(', ')+'에만 내 서식을 적용했습니다. ':'기본 역할 서식을 유지했습니다. ')+'공식 제출 양식으로 인증된 것은 아니므로 제출처 기준을 확인하세요.';}
 return warning;
}
/** Use rendered HWPX bytes, never a CSS imitation of a page. */
export function installTemplatePreview(host:HTMLElement){
 const pages=host.querySelector<HTMLElement>('.template-preview-pages')!,status=host.querySelector<HTMLElement>('.template-preview-status')!,count=host.querySelector<HTMLElement>('.template-preview-count')!;
 const warnings=host.querySelector<HTMLDetailsElement>('.template-preview-warnings')!,warningTitle=host.querySelector<HTMLElement>('.template-preview-warnings-summary')!,warningList=host.querySelector<HTMLElement>('.template-preview-warnings-list')!;
 let timer:ReturnType<typeof setTimeout>|undefined,epoch=0,disposed=false,urls:string[]=[];
 let running=false,pending:{epoch:number;template:DocumentTemplate}|undefined;
 function clear(){for(const url of urls)URL.revokeObjectURL(url);urls=[];pages.replaceChildren();count.textContent='';warnings.hidden=true;warnings.open=false;warningTitle.textContent='';warningList.replaceChildren();}
 function suspend(){epoch++;if(timer)clearTimeout(timer);timer=undefined;pending=undefined;clear();}
 async function drain(){
  if(disposed||running||timer!==undefined||!pending)return;
  const job=pending;pending=undefined;running=true;
  try{
   const result=await generateKordocDocument({template:job.template,markdown:templateLayout(job.template).sampleMarkdown});
   if(disposed||job.epoch!==epoch)return;clear();
   for(const [i,page] of result.pages.entries()){const figure=document.createElement('figure'),caption=document.createElement('figcaption'),img=document.createElement('img');const url=URL.createObjectURL(new Blob([page.svg],{type:'image/svg+xml'}));urls.push(url);img.src=url;img.alt=(i+1)+'쪽';img.width=page.width;img.height=page.height;caption.textContent=(i+1)+' / '+result.pages.length+'쪽';figure.append(img,caption);pages.append(figure);}
   const layout=templateLayout(job.template);count.textContent=result.pages.length+'쪽';status.textContent='전체 '+result.pages.length+'쪽 · '+[...(layout.cover?['표지']:[]),...(layout.toc?['목차']:[]),'본문'].join(' / ');
   if(result.warnings.length){warningTitle.textContent='서식 확인 사항 '+result.warnings.length;for(const warning of result.warnings){const item=document.createElement('li');item.textContent=previewWarningText(warning);warningList.append(item);}warnings.hidden=false;}
  }catch(e){if(!disposed&&job.epoch===epoch){clear();status.textContent=e instanceof Error?e.message:'미리보기를 만들지 못했습니다.';}}
  finally{running=false;void drain();}
 }
 function update(value:DocumentTemplate){
  if(disposed)return;suspend();let template:DocumentTemplate;
  try{template=parseDocumentTemplate(value);}catch(e){clear();status.textContent=e instanceof Error?e.message:'서식 값을 확인하세요.';return;}
  clear();status.textContent='문서 전체를 조판하고 있어요…';
  pending={epoch,template};
  timer=setTimeout(()=>{timer=undefined;void drain();},450);
 }
 return {update,suspend,dispose(){disposed=true;suspend();clear();}};
}
