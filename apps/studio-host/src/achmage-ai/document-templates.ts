import {parseTemplateLook,standardLook,HALLYM_ILSONG_LOOK,HALLYM_AICR_LOOK,KOREAN_COMMUNICATION_LOOK,YOUTH_STUDIES_LOOK,type TemplateLook,type LookPreset} from './template-look';
export type TemplateRole = 'title'|'heading'|'body'|'tableHeader'|'tableCell';
export interface TemplateStyle { fontFamily:string; fontSizePt:number; bold:boolean; spacingPercent:number; alignment:'left'|'center'|'right'|'justify'; lineSpacingPercent:number }
export const ENGINE_PRESETS=['official','report','plan','notice','minutes','gaejosik','press','ministry','bangchim'] as const;
export type EnginePreset=typeof ENGINE_PRESETS[number];
export const COVER_TOC_PRESETS:readonly EnginePreset[]=['report','plan','gaejosik','ministry','bangchim'];
export const AGENCY_PRESETS:readonly EnginePreset[]=['report','plan','ministry','gaejosik','press'];
export interface TemplateLayout { enginePreset:EnginePreset; cover:boolean; toc:boolean; sampleMarkdown:string; paper:'A4'|'A3'|'B4'|'B5'|'Letter'; orientation:'portrait'|'landscape'; agency?:string; agencyRoleOverrides?:TemplateRole[] }
/**
 * `roles` drive edits inside an open document (structured insertion). `look`, when present, drives
 * generated documents: Kordoc's own layout of the document type plus the HanMark style values,
 * instead of restyling every paragraph to the five roles.
 */
export interface DocumentTemplate { schemaVersion:1; id:string; name:string; category:'general'|'government'|'education'|'press'|'personal'; provenance:'sample'|'personal'; description:string; roles:Record<TemplateRole,TemplateStyle>; layout?:TemplateLayout; look?:TemplateLook; /** Set on templates that come from a local data pack. */ pack?:{id:string;strategy:'report'|'minutes'|'fixed';group:string} }
export function templateLayout(template:DocumentTemplate):TemplateLayout {
 const enginePreset=template.category==='government'?'official':template.category==='press'?'press':'report';
 return structuredClone(template.layout??{enginePreset,cover:template.category==='general'||template.category==='education',toc:template.category==='general'||template.category==='education',paper:'A4',orientation:'portrait',sampleMarkdown:'# '+template.name+'\n\n## 1. 개요\n\n이 문서는 선택한 템플릿의 구성과 실제 표 배치를 살펴보기 위한 예시입니다.\n\n## 2. 주요 내용\n\n목적과 검토 사항을 간결하게 정리합니다.\n\n| 구분 | 내용 | 비고 |\n| --- | --- | --- |\n| 안건 | 검토할 주요 사항 | 논의 |\n| 실행 | 구체적인 후속 계획 | 확인 |\n\n## 3. 후속 계획\n\n- 담당 업무와 일정을 확인합니다.\n- 결정 사항을 문서에 기록합니다.'});
}
export const TEMPLATE_ROLES:TemplateRole[]=['title','heading','body','tableHeader','tableCell'];
export const TEMPLATE_ROLE_LABELS:Record<TemplateRole,string>={title:'제목',heading:'소제목',body:'본문',tableHeader:'표 머리글',tableCell:'표 본문'};
const KEY='achmage.hop.document-templates.v1', SELECTED='achmage.hop.selected-document-template.v1', HIDDEN='achmage.hop.hidden-document-templates.v1';
// Summary roles of each built-in are the values its generated document actually uses (measured
// from Kordoc 4.21.31 and HanMark 2.7.0), so edits inside an open document match its look.
const r=(fontFamily:string,fontSizePt:number,bold=false,alignment:TemplateStyle['alignment']='justify',lineSpacingPercent=160,spacingPercent=0):TemplateStyle=>({fontFamily,fontSizePt,bold,spacingPercent,alignment,lineSpacingPercent});
const roles=(title:TemplateStyle,heading:TemplateStyle,body:TemplateStyle,table:string,tablePt:number):Record<TemplateRole,TemplateStyle>=>({title,heading,body,tableHeader:r(table,tablePt,true,'center',130),tableCell:r(table,tablePt,false,'left',130)});
const SAMPLE_REPORT='# 2026년 하반기 업무 추진 계획\n\n> 하반기 주요 과제의 추진 방향과 일정을 정리하고자 함\n\n## 추진 배경\n\n- 상반기 성과를 점검하고 하반기 과제를 확정할 필요\n  - 부서별 협업 과제가 늘어 일정 조정이 필요함\n\n## 주요 내용\n\n### 과제별 추진 계획\n\n| 구분 | 내용 | 일정 |\n| --- | --- | --- |\n| 과제 1 | 현황 조사 | 7월 |\n| 과제 2 | 개선안 마련 | 9월 |\n\n## 향후 계획\n\n- 분기별 점검 회의를 열어 진행 상황을 확인함';
const SAMPLE_MINUTES='# 제1차 운영위원회 회의록\n\n## 회의 개요\n\n- 일시: 2026. 3. 5.(목) 14:00\n- 장소: 대학본부 회의실\n\n## 논의 사항\n\n### 추진 방향\n\n- 교과 운영 개선 방향을 논의함\n  - 세부 일정은 다음 회의에서 확정\n\n| 안건 | 결정 | 담당 |\n| --- | --- | --- |\n| 교과 개편 | 원안 의결 | 교무팀 |\n\n## 후속 조치\n\n- 회의 결과를 학과에 안내함';
const SAMPLE_LETTER='# 2026학년도 교육과정 운영 계획 알림\n\n## 관련: 교무처-1234(2026. 2. 10.)\n\n## 2026학년도 교육과정 운영 계획을 다음과 같이 알려 드립니다.\n\n- 기간: 2026. 3. 2. ~ 2026. 6. 20.\n- 대상: 전 학년\n\n| 구분 | 내용 |\n| --- | --- |\n| 1학기 | 교양 교과 운영 |\n| 2학기 | 전공 교과 운영 |';
const SAMPLE_PRESS='# 대학, 지역 청소년 디지털 교육 확대\n\n> 지역 청소년 300명을 대상으로 디지털 교육을 운영\n\n## 주요 내용\n\n- 교육 대상과 일정을 확정함\n  - 7월부터 12월까지 매주 토요일 운영\n\n| 구분 | 내용 |\n| --- | --- |\n| 대상 | 지역 청소년 |\n| 기간 | 7월~12월 |';
const SAMPLE_PAPER='# 디지털 미디어 이용과 청소년의 사회적 관계\n\n## 1. 서론\n\n디지털 미디어 이용이 청소년의 관계 형성에 미치는 영향을 살펴본다. 선행 연구는 이용 시간보다 이용 방식이 중요하다고 지적한다.\n\n## 2. 이론적 배경\n\n### 1) 미디어 이용 동기\n\n이용 동기는 정보 추구, 관계 유지, 오락으로 나뉜다.\n\n#### (1) 관계 유지 동기\n\n관계 유지 동기는 또래 집단과의 친밀감과 관련된다.\n\n| 구분 | 사례 수 | 비율 |\n| --- | --- | --- |\n| 정보 추구 | 120 | 40% |\n| 관계 유지 | 180 | 60% |\n\n## 3. 결론\n\n연구 결과는 이용 방식에 따른 교육 설계가 필요함을 보여준다.';
const layout=(enginePreset:EnginePreset,cover:boolean,toc:boolean,sampleMarkdown:string):TemplateLayout=>({enginePreset,cover,toc,paper:'A4',orientation:'portrait',sampleMarkdown});
const builtin=(id:string,name:string,category:DocumentTemplate['category'],description:string,look:TemplateLook,l:TemplateLayout,summary:Record<TemplateRole,TemplateStyle>):DocumentTemplate=>({schemaVersion:1,id,name,category,provenance:'sample',description,roles:summary,layout:l,look});
const REPORT_ROLES=roles(r('HY헤드라인M',25,true,'center',130),r('HY헤드라인M',20,true,'left',130),r('한컴돋움',15,false,'justify',180),'한컴돋움',12);
const standard=(id:string,name:string,category:DocumentTemplate['category'],description:string,preset:LookPreset,cover:boolean,toc:boolean,sample:string,summary:Record<TemplateRole,TemplateStyle>)=>builtin(id,name,category,description+' Kordoc 공문 양식이며 공식 제출 양식 인증은 아닙니다.',standardLook(preset),layout(preset,cover,toc,sample),summary);
/** Built-ins: HanMark 2.7.0 institution forms, the nine official document types, and HanMark document styles. Indexes 0-3 keep their former ids. */
export const BUILTIN_DOCUMENT_TEMPLATES:readonly DocumentTemplate[]=[
 standard('builtin-report','보고서','government','서울시 보고서 형식을 참고한 양식입니다(서울시가 배포·인증한 양식 아님). 제목 상자, 요약 상자, 파란 장 띠(Ⅰ Ⅱ), □ ㅇ - ㆍ 항목으로 만듭니다.','report',true,true,SAMPLE_REPORT,REPORT_ROLES),
 standard('builtin-government','기안문·시행문','government','두문(기관명·수신·제목)과 결문(발신명의·결재선·시행) 표가 있는 기안문입니다. 굴림체 12pt, 1. 가. 1) 번호, 끝에 "끝."이 붙습니다.','official',false,false,SAMPLE_LETTER,roles(r('굴림체',14,true,'center'),r('굴림체',12),r('굴림체',12),'한컴돋움',12)),
 builtin('builtin-hallym-ilsong','한림대 일송자유교양대학 (회의록·회의자료)','education','HanMark 기관 문서 모양(비공식): 한림고딕체 11pt, "1." 절 제목과 •·- 항목, 남색 머리행 표, 가운데 쪽 번호. 실제 회의록에서 잰 값이며 공식 배포 양식 인증은 아닙니다.',HALLYM_ILSONG_LOOK,layout('minutes',false,false,SAMPLE_MINUTES),roles(r('한림고딕체 Regular',15,true,'center'),r('한림고딕체 Regular',11,true,'left'),r('한림고딕체 Regular',11),'한림고딕체 Regular',11)),
 standard('builtin-press','보도자료','press','"보도자료" 머리 상자와 큰 제목, □ ㅇ 항목, 담당 부서 표로 만듭니다.','press',false,false,SAMPLE_PRESS,roles(r('함초롬바탕',25,true,'center'),r('함초롬돋움',16,true,'left'),r('함초롬바탕',14),'함초롬바탕',12)),
 builtin('builtin-hallym-aicr','한림대 AI융합연구원 보고서','education','HanMark 기관 문서 모양(비공식): 파랑·청록 선 표지, 휴먼명조, "1." 제목 → "1)" 소제목 → ○·-·· 본문, 쪽 번호. 실제 보고서 양식에서 잰 값이며 공식 배포 양식 인증은 아닙니다.',HALLYM_AICR_LOOK,layout('report',true,false,SAMPLE_REPORT),roles(r('휴먼명조',20,true,'center'),r('휴먼명조',13,true,'left'),r('휴먼명조',11),'휴먼명조',11)),
 standard('builtin-plan','계획서','government','보고서 양식 앞에 방침 표지(날짜, 문서번호·방침번호 칸)를 붙인 추진계획입니다.','plan',true,true,SAMPLE_REPORT,REPORT_ROLES),
 standard('builtin-gaejosik','정부 표준 개조식','government','정부 표준 개조식 보고서입니다. 표지와 목차, 장 띠, □ ○ - ㆍ 항목(휴먼명조 15pt·장평 95%)으로 만듭니다.','gaejosik',true,true,SAMPLE_REPORT,roles(r('HY헤드라인M',30,false,'center',130),r('HY헤드라인M',18,false,'left'),r('휴먼명조',15),'맑은 고딕',12)),
 standard('builtin-ministry','업무보고','government','중앙부처 업무보고입니다. 표지와 목차를 넣고, 장마다 새 쪽에서 시작하며 절마다 번호 띠를 붙입니다.','ministry',true,true,SAMPLE_REPORT,roles(r('HY헤드라인M',32,false,'center',130),r('HY헤드라인M',17,false,'left',130),r('함초롬바탕',15,false,'justify',145),'맑은 고딕',12)),
 standard('builtin-bangchim','방침서','government','서울시 방침서 형식을 참고한 양식입니다(서울시가 배포·인증한 양식 아님). 번호 상자와 괘선 장 제목, □ ㅇ 항목으로 만듭니다.','bangchim',false,false,SAMPLE_REPORT,roles(r('HY헤드라인M',26,true,'center',100),r('HY견고딕',20,false,'center',150),r('HY견고딕',16,false,'justify',190),'한컴돋움',12)),
 standard('builtin-notice','통지·안내','government','통지·안내문입니다. 큰 제목, 본문 15pt, 1. 가. 번호, 끝에 날짜가 붙습니다.','notice',false,false,SAMPLE_LETTER,roles(r('HY헤드라인M',20,true,'center'),r('굴림체',15),r('굴림체',15),'한컴돋움',12)),
 standard('builtin-minutes','회의록','government','회의록입니다. 큰 제목에 본문 14pt, 줄 간격 130%로 촘촘하게 1. 가. 번호를 붙입니다.','minutes',false,false,SAMPLE_MINUTES,roles(r('HY헤드라인M',20,true,'center'),r('굴림체',14,false,'justify',130),r('굴림체',14,false,'justify',130),'한컴돋움',12)),
 builtin('builtin-kordoc-default','Kordoc 기본','general','HanMark 문서 스타일: Kordoc 기본값 그대로입니다. 본문 함초롬바탕 10pt, 제목 함초롬돋움.',{kind:'document'},layout('report',false,false,SAMPLE_PAPER),roles(r('함초롬돋움',18,true,'left',180),r('함초롬돋움',14,true,'left',170),r('함초롬바탕',10),'함초롬바탕',10)),
 builtin('builtin-korean-communication','한국언론학회','general','HanMark 문서 스타일(학회 투고 형식 참고, 비공식): 본문 신명조 10pt·장평 95%·자간 -10%·첫 줄 10pt 들여쓰기, 제목 맑은 고딕 14pt 가운데, 소제목 HY견고딕.',KOREAN_COMMUNICATION_LOOK,layout('report',false,false,SAMPLE_PAPER),roles(r('맑은 고딕',14,true,'center',160,-10),r('HY견고딕',10,false,'justify',160,-10),r('신명조',10,false,'justify',160,-10),'신명조',10)),
 builtin('builtin-youth-studies','청소년학','general','HanMark 문서 스타일(학회 투고 형식 참고, 비공식): 휴먼명조 본문 10pt·장평 95%·줄간격 170%·첫 줄 10pt 들여쓰기, 제목 15pt 가운데.',YOUTH_STUDIES_LOOK,layout('report',false,false,SAMPLE_PAPER),roles(r('휴먼명조',15,true,'center',170),r('휴먼명조',12,true,'center',170),r('휴먼명조',10,false,'justify',170),'휴먼명조',10)),
];
/** Group shown in the template list. */
export function templateGroup(template:DocumentTemplate):string{
 if(template.pack)return template.pack.group;
 if(template.provenance==='personal')return '내 템플릿';
 if(template.id.startsWith('builtin-hallym'))return '한림대 문서 모양(비공식)';
 return template.look?.kind==='document'?'문서 스타일':'공문서 양식';
}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('템플릿 형식이 올바르지 않습니다.');return value as Record<string,unknown>;}
export function parseDocumentTemplate(value:unknown):DocumentTemplate {
 const p=record(value),roles=record(p.roles);
 if(p.schemaVersion!==1||typeof p.id!=='string'||!/^([a-z0-9-]{1,100})$/.test(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>80||typeof p.description!=='string'||p.description.length>1000||!['general','government','education','press','personal'].includes(String(p.category))||!['sample','personal'].includes(String(p.provenance)))throw Error('템플릿 이름과 형식을 확인하세요.');
 const parsed={} as Record<TemplateRole,TemplateStyle>;
 for(const name of TEMPLATE_ROLES){const s=record(roles[name]);if(typeof s.fontFamily!=='string'||!s.fontFamily.trim()||s.fontFamily.length>80||/[\u0000-\u001f<>]/u.test(s.fontFamily)||typeof s.fontSizePt!=='number'||!Number.isFinite(s.fontSizePt)||s.fontSizePt<5||s.fontSizePt>72||!Number.isInteger(s.fontSizePt*100)||typeof s.bold!=='boolean'||typeof s.spacingPercent!=='number'||!Number.isInteger(s.spacingPercent)||s.spacingPercent< -50||s.spacingPercent>50||!['left','center','right','justify'].includes(String(s.alignment))||typeof s.lineSpacingPercent!=='number'||!Number.isInteger(s.lineSpacingPercent)||s.lineSpacingPercent<50||s.lineSpacingPercent>500)throw Error(TEMPLATE_ROLE_LABELS[name]+' 서식 값을 확인하세요.');parsed[name]={fontFamily:s.fontFamily.trim(),fontSizePt:s.fontSizePt,bold:s.bold,spacingPercent:s.spacingPercent,alignment:s.alignment as TemplateStyle['alignment'],lineSpacingPercent:s.lineSpacingPercent};}
 for(const style of Object.values(parsed))if(/["'<>;,\\]/u.test(style.fontFamily))throw Error('글꼴 이름에 지원하지 않는 문자가 있습니다.');
 let layout:TemplateLayout|undefined;
 if(p.layout!==undefined){const l=record(p.layout);if(!ENGINE_PRESETS.includes(l.enginePreset as EnginePreset)||typeof l.cover!=='boolean'||typeof l.toc!=='boolean'||typeof l.sampleMarkdown!=='string'||l.sampleMarkdown.length>32000||!l.sampleMarkdown.trim()||!['A4','A3','B4','B5','Letter'].includes(String(l.paper))||!['portrait','landscape'].includes(String(l.orientation)))throw Error('문서 구성과 미리보기 본문을 확인하세요.');layout={enginePreset:l.enginePreset as TemplateLayout['enginePreset'],cover:l.cover,toc:l.toc,sampleMarkdown:l.sampleMarkdown,paper:l.paper as TemplateLayout['paper'],orientation:l.orientation as TemplateLayout['orientation']};
  if(l.agency!==undefined){if(typeof l.agency!=='string'||!l.agency.trim()||l.agency.length>100||/[\u0000-\u001f<>]/u.test(l.agency))throw Error('기관 이름을 확인하세요.');if(!AGENCY_PRESETS.includes(layout.enginePreset))throw Error('이 문서 유형은 기관 스타일을 지원하지 않습니다. 기관 선택을 해제하세요.');layout.agency=l.agency;}
  if(l.agencyRoleOverrides!==undefined){if(!layout.agency||!Array.isArray(l.agencyRoleOverrides)||l.agencyRoleOverrides.some(v=>!TEMPLATE_ROLES.includes(v as TemplateRole))||new Set(l.agencyRoleOverrides).size!==l.agencyRoleOverrides.length)throw Error('기관 서식을 변경할 역할을 확인하세요.');layout.agencyRoleOverrides=[...l.agencyRoleOverrides] as TemplateRole[];}
 }
 if(layout&&(layout.cover||layout.toc)&&!COVER_TOC_PRESETS.includes(layout.enginePreset))throw Error('이 문서 유형은 표지·목차를 지원하지 않습니다. 선택을 해제하세요.');
 let look:TemplateLook|undefined;
 if(p.look!==undefined){
  look=parseTemplateLook(p.look);
  if(!layout)throw Error('HanMark 서식에는 문서 구성이 필요합니다.');
  if(layout.agency!==undefined)throw Error('기관 스타일과 HanMark 서식은 함께 쓸 수 없습니다. 기관 선택을 해제하세요.');
  if(look.kind==='document'&&(layout.cover||layout.toc))throw Error('문서 스타일 템플릿은 표지·목차를 만들지 않습니다. 선택을 해제하세요.');
  if(look.kind==='gongmun'&&look.preset!==layout.enginePreset)throw Error('템플릿의 문서 종류와 서식 종류가 다릅니다.');
 }
 return {schemaVersion:1,id:p.id,name:p.name.trim(),category:p.category as DocumentTemplate['category'],provenance:p.provenance as DocumentTemplate['provenance'],description:p.description,roles:parsed,...(layout?{layout}:{}),...(look?{look}:{})};
}
export class DocumentTemplateStore {
 /** `extra`: templates from local data packs, loaded separately. */
 constructor(private storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,private extra:()=>readonly DocumentTemplate[]=()=>[]){}
 /** Saved rows that no longer validate are set aside (and reported), never allowed to break the list (F12). */
 quarantined=0;
 private custom():DocumentTemplate[]{
  let rows:unknown;try{const raw=this.storage.getItem(KEY);if(!raw)return [];if(raw.length>250000)throw Error('size');rows=JSON.parse(raw);}catch{this.quarantined=1;return [];}
  if(!Array.isArray(rows)){this.quarantined=1;return [];}
  const valid:DocumentTemplate[]=[];let bad=0;
  for(const row of rows.slice(0,50)){try{const t=parseDocumentTemplate(row);if(t.provenance==='personal'&&!t.id.startsWith('builtin-'))valid.push(t);}catch{bad++;}}
  this.quarantined=bad+Math.max(0,rows.length-50);return valid;
 }
 /** Every template, hidden built-ins included. */
 listAll():DocumentTemplate[]{return [...BUILTIN_DOCUMENT_TEMPLATES,...this.custom(),...this.extra()].map(t=>structuredClone(t));}
 /** The templates shown and offered: built-ins the user hid are left out (they stay in the app and can be shown again). */
 list():DocumentTemplate[]{const hidden=this.hidden();return this.listAll().filter(t=>!hidden.has(t.id));}
 hidden():Set<string>{try{const raw=this.storage.getItem(HIDDEN);const ids=raw?JSON.parse(raw):[];return new Set(Array.isArray(ids)?ids.filter((id):id is string=>typeof id==='string'&&id.startsWith('builtin-')).slice(0,200):[]);}catch{return new Set();}}
 /** Built-in templates are part of the app, so they are hidden rather than deleted; `unhide` brings them back. */
 hide(id:string):void{if(!id.startsWith('builtin-'))throw Error('기본 서식만 숨길 수 있습니다. 내 서식과 서식 팩은 삭제하세요.');if(!BUILTIN_DOCUMENT_TEMPLATES.some(t=>t.id===id))throw Error('숨길 기본 서식을 찾지 못했습니다.');const ids=this.hidden();ids.add(id);this.storage.setItem(HIDDEN,JSON.stringify([...ids]));if(this.storage.getItem(SELECTED)===id)this.storage.removeItem(SELECTED);}
 unhide(id?:string):void{if(id===undefined){this.storage.removeItem(HIDDEN);return;}const ids=this.hidden();ids.delete(id);if(ids.size)this.storage.setItem(HIDDEN,JSON.stringify([...ids]));else this.storage.removeItem(HIDDEN);}
 selected():DocumentTemplate|undefined {const id=this.storage.getItem(SELECTED);return this.list().find(t=>t.id===id);}
 select(id:string|null):void{if(id===null){this.storage.removeItem(SELECTED);return;}if(!this.list().some(t=>t.id===id))throw Error('선택할 템플릿을 찾지 못했습니다.');this.storage.setItem(SELECTED,id);}
 /** The stored rows exactly as saved, unreadable ones included; null when the storage itself cannot be read safely. */
 private rawRows():unknown[]|null{try{const raw=this.storage.getItem(KEY);if(!raw)return [];if(raw.length>250000)return null;const rows=JSON.parse(raw);return Array.isArray(rows)?rows:null;}catch{return null;}}
 save(value:unknown):DocumentTemplate{const parsed=parseDocumentTemplate(value);if(parsed.id.startsWith('builtin-')||parsed.provenance!=='personal')throw Error('기본 템플릿은 복사해서 내 템플릿으로 저장하세요.');const rows=this.rawRows();if(!rows)throw Error('저장된 내 템플릿 목록을 읽지 못해 덮어쓰지 않습니다. 원본은 그대로 두었습니다.');const index=rows.findIndex(t=>!!t&&typeof t==='object'&&(t as {id?:unknown}).id===parsed.id);if(index<0)rows.push(parsed);else rows[index]=parsed;if(rows.length>50)throw Error('내 템플릿은 50개까지 보관할 수 있습니다.');const serialized=JSON.stringify(rows);if(serialized.length>250000)throw Error('템플릿 저장 용량을 넘었습니다. 설명을 줄이거나 사용하지 않는 템플릿을 삭제하세요.');this.storage.setItem(KEY,serialized);return structuredClone(parsed);}
 remove(id:string):void{if(id.startsWith('builtin-'))throw Error('기본 템플릿은 삭제할 수 없습니다.');const rows=this.rawRows();if(!rows)throw Error('저장된 내 템플릿 목록을 읽지 못해 지우지 않습니다. 원본은 그대로 두었습니다.');this.storage.setItem(KEY,JSON.stringify(rows.filter(t=>!(t&&typeof t==='object'&&(t as {id?:unknown}).id===id))));if(this.storage.getItem(SELECTED)===id)this.storage.removeItem(SELECTED);}
 duplicate(template:DocumentTemplate):DocumentTemplate{let name='';for(const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(template.name)){if(name.length+segment.length>77)break;name+=segment;}return {...structuredClone(template),id:'custom-'+crypto.randomUUID(),name:name+' 사본',provenance:'personal',category:'personal',description:'내가 만든 문서 스타일'};}
}
