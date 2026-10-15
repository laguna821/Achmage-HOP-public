// HanMark template looks (ported from HanMark 2.7.0: documentStylePresets.ts, institutionStyles.ts).
// A look keeps Kordoc's own layout of a document type and adds only what the style changes.
// The engine (apps/kordoc-engine/hanmark-styles.mjs) validates the same shape again before use.
export type LookPreset='official'|'report'|'plan'|'notice'|'minutes'|'gaejosik'|'press'|'ministry'|'bangchim';
export type LookAlignment='LEFT'|'CENTER'|'RIGHT'|'JUSTIFY'|'DISTRIBUTE'|'DISTRIBUTE_SPACE';
export interface LookCharacter {fontFamily?:string;latinFontFamily?:string;fontSizePt?:number;bold?:boolean;italic?:boolean;underline?:boolean;color?:string;widthPercent?:number;letterSpacingPercent?:number}
export interface LookParagraph {alignment?:LookAlignment;lineSpacingPercent?:number;firstLineIndentHu?:number;marginLeftHu?:number;marginRightHu?:number;spaceBeforeHu?:number;spaceAfterHu?:number;keepWithNext?:boolean}
export type DocumentStyleRole='body'|'h1'|'h2'|'h3'|'h4'|'h5'|'h6'|'quote'|'code'|'list';
export interface LookRole {styleName?:string;character?:LookCharacter;paragraph?:LookParagraph}
export interface LookPage {widthHu:number;heightHu:number;landscape?:'WIDELY'|'NARROWLY';gutterType?:'LEFT_ONLY'|'LEFT_RIGHT'|'TOP_BOTTOM';margins:{top:number;bottom:number;left:number;right:number;header?:number;footer?:number;gutter?:number}}
export interface DocumentLook {kind:'document';profile?:{roles:Partial<Record<DocumentStyleRole,LookRole>>;page?:LookPage}}
export type MarkerClass='legal1'|'legal2'|'legal3'|'legal4'|'legal5'|'legal6'|'legal7'|'box0'|'box1'|'box2'|'box3';
export interface GongmunLookOptions {bodyFont?:'myeongjo'|'gothic';bodyPt?:number;lineSpacing?:number;numbering?:'standard'|'report'|'gaejosik';bullet2?:'ㅇ'|'○'|'◦'|'❍';h2Marker?:'band'|'roman'|'box'|'number'|'none'|'square';bandColor?:string;bandTextColor?:string;fonts?:{body?:string;heading?:string;ref?:string;table?:string};levels?:Partial<Record<'0'|'1'|'2'|'3',{font?:string;pt?:number;bold?:boolean}>>;margins?:{top:number;bottom:number;left:number;right:number};pageNumbers?:boolean;endMark?:boolean;suppressSingle?:boolean;autoFit?:boolean;centerTitle?:boolean}
export interface GongmunLookFinish {markers?:Partial<Record<MarkerClass,string>>;tableHeader?:{fill:string;textColor:string};title?:{pt?:number;bold?:boolean;font?:'body'};chapter?:{pt?:number;bold?:boolean;blankLineBefore?:boolean};cover?:{removeInfoBox?:boolean;removeBodyTitle?:boolean;barColors?:[string,string];linePt?:number;lineBold?:boolean}}
export interface GongmunLook {kind:'gongmun';preset:LookPreset;options:GongmunLookOptions;finish?:GongmunLookFinish;outline?:{nestChapterLists?:boolean;boldSubHeadings?:boolean};coverDate?:'month'|'day';quietEngineNotes?:string[]}
export type TemplateLook=DocumentLook|GongmunLook;

// ------------------------------------------------------------------ validation
type Rule={t:'str';max?:number}|{t:'font'}|{t:'num';min:number;max:number;int?:boolean}|{t:'bool'}|{t:'enum';v:readonly string[]}|{t:'color'}|{t:'obj';f:Record<string,Rule>;req?:readonly string[]}|{t:'map';keys:readonly string[];v:Rule}|{t:'tuple';v:Rule;n:number}|{t:'list';v:Rule;max:number};
const fail=(message:string):never=>{throw Error(message);};
function check(rule:Rule,value:unknown,label:string):unknown{
 const bad=()=>fail(label+' 서식 값을 확인하세요.');
 switch(rule.t){
  case 'str':return typeof value==='string'&&value.length<=(rule.max??80)&&!/[\u0000-\u001f<>]/u.test(value)?value:bad();
  case 'font':{if(typeof value!=='string')return bad();const v=value.replace(/\s+/gu,' ').trim();return v&&v.length<=80&&!/[\u0000-\u001f<>"';,\\]/u.test(v)?v:bad();}
  case 'num':return typeof value==='number'&&Number.isFinite(value)&&value>=rule.min&&value<=rule.max&&(!rule.int||Number.isInteger(value))?value:bad();
  case 'bool':return typeof value==='boolean'?value:bad();
  case 'enum':return typeof value==='string'&&rule.v.includes(value)?value:bad();
  case 'color':return typeof value==='string'&&/^#[0-9A-F]{6}$/u.test(value)?value:bad();
  case 'tuple':return Array.isArray(value)&&value.length===rule.n?value.map(v=>check(rule.v,v,label)):bad();
  case 'list':return Array.isArray(value)&&value.length<=rule.max?value.map(v=>check(rule.v,v,label)):bad();
  case 'map':case 'obj':{
   if(!value||typeof value!=='object'||Array.isArray(value))return bad();
   const allowed=rule.t==='map'?rule.keys:Object.keys(rule.f),out:Record<string,unknown>={};
   for(const [k,v] of Object.entries(value as Record<string,unknown>)){if(!allowed.includes(k))return bad();if(v===undefined)continue;out[k]=check(rule.t==='map'?rule.v:rule.f[k],v,label);}
   if(rule.t==='obj')for(const k of rule.req??[])if(!(k in out))return bad();
   return out;
  }
 }
}
const font:Rule={t:'font'},bool:Rule={t:'bool'},num=(min:number,max:number,int=false):Rule=>({t:'num',min,max,int});
const CHARACTER:Rule={t:'obj',f:{fontFamily:font,latinFontFamily:font,fontSizePt:num(4,100),bold:bool,italic:bool,underline:bool,color:{t:'color'},widthPercent:num(50,200,true),letterSpacingPercent:num(-50,50,true)}};
const PARAGRAPH:Rule={t:'obj',f:{alignment:{t:'enum',v:['LEFT','CENTER','RIGHT','JUSTIFY','DISTRIBUTE','DISTRIBUTE_SPACE']},lineSpacingPercent:num(70,400,true),firstLineIndentHu:num(-100000,100000,true),marginLeftHu:num(0,100000,true),marginRightHu:num(0,100000,true),spaceBeforeHu:num(0,100000,true),spaceAfterHu:num(0,100000,true),keepWithNext:bool}};
const HU=num(0,100000,true);
const PAGE:Rule={t:'obj',req:['widthHu','heightHu','margins'],f:{widthHu:num(10000,200000,true),heightHu:num(10000,200000,true),landscape:{t:'enum',v:['WIDELY','NARROWLY']},gutterType:{t:'enum',v:['LEFT_ONLY','LEFT_RIGHT','TOP_BOTTOM']},margins:{t:'obj',req:['top','bottom','left','right'],f:{top:HU,bottom:HU,left:HU,right:HU,header:HU,footer:HU,gutter:HU}}}};
export const DOCUMENT_STYLE_ROLES:readonly DocumentStyleRole[]=['body','h1','h2','h3','h4','h5','h6','quote','code','list'];
const DOCUMENT_LOOK:Rule={t:'obj',req:['kind'],f:{kind:{t:'enum',v:['document']},profile:{t:'obj',req:['roles'],f:{roles:{t:'map',keys:DOCUMENT_STYLE_ROLES,v:{t:'obj',f:{styleName:{t:'str'},character:CHARACTER,paragraph:PARAGRAPH}}},page:PAGE}}}};
export const LOOK_PRESETS:readonly LookPreset[]=['official','report','plan','notice','minutes','gaejosik','press','ministry','bangchim'];
const MARKERS:readonly MarkerClass[]=['legal1','legal2','legal3','legal4','legal5','legal6','legal7','box0','box1','box2','box3'];
const LEVEL:Rule={t:'obj',f:{font,pt:num(6,60),bold:bool}},MM=num(5,60);
const GONGMUN_LOOK:Rule={t:'obj',req:['kind','preset','options'],f:{kind:{t:'enum',v:['gongmun']},preset:{t:'enum',v:LOOK_PRESETS},
 options:{t:'obj',f:{bodyFont:{t:'enum',v:['myeongjo','gothic']},bodyPt:num(8,24),lineSpacing:num(100,250,true),numbering:{t:'enum',v:['standard','report','gaejosik']},bullet2:{t:'enum',v:['ㅇ','○','◦','❍']},h2Marker:{t:'enum',v:['band','roman','box','number','none','square']},bandColor:{t:'color'},bandTextColor:{t:'color'},fonts:{t:'obj',f:{body:font,heading:font,ref:font,table:font}},levels:{t:'map',keys:['0','1','2','3'],v:LEVEL},margins:{t:'obj',req:['top','bottom','left','right'],f:{top:MM,bottom:MM,left:MM,right:MM}},pageNumbers:bool,endMark:bool,suppressSingle:bool,autoFit:bool,centerTitle:bool}},
 finish:{t:'obj',f:{markers:{t:'map',keys:MARKERS,v:{t:'str',max:4}},tableHeader:{t:'obj',req:['fill','textColor'],f:{fill:{t:'color'},textColor:{t:'color'}}},title:{t:'obj',f:{pt:num(6,60),bold:bool,font:{t:'enum',v:['body']}}},chapter:{t:'obj',f:{pt:num(6,60),bold:bool,blankLineBefore:bool}},cover:{t:'obj',f:{removeInfoBox:bool,removeBodyTitle:bool,barColors:{t:'tuple',v:{t:'color'},n:2},linePt:num(6,60),lineBold:bool}}}},
 outline:{t:'obj',f:{nestChapterLists:bool,boldSubHeadings:bool}},coverDate:{t:'enum',v:['month','day']},quietEngineNotes:{t:'list',v:{t:'str'},max:8}}};
/** A validated deep copy; unknown keys and out-of-range values fail. */
export function parseTemplateLook(value:unknown):TemplateLook{
 const kind=(value as {kind?:unknown}|null)?.kind;
 if(kind==='document')return check(DOCUMENT_LOOK,value,'문서 스타일') as DocumentLook;
 if(kind==='gongmun'){const look=check(GONGMUN_LOOK,value,'공문 서식') as GongmunLook;for(const m of Object.values(look.finish?.markers??{}))if(!m||/[\s&"]/u.test(m))fail('항목 부호를 확인하세요.');return look;}
 return fail('템플릿 서식 종류를 확인하세요.');
}

// ------------------------------------------------------------------ built-in looks (HanMark 2.7.0 measurements)
const HM_PAGE:LookPage={widthHu:59530,heightHu:84190,landscape:'WIDELY',gutterType:'LEFT_ONLY',margins:{top:4255,bottom:4960,left:7200,right:7200,header:4250,footer:2240,gutter:0}};
const character=(fontFamily:string,fontSizePt:number,bold:boolean,widthPercent:number,letterSpacingPercent:number):LookCharacter=>({fontFamily,latinFontFamily:fontFamily,fontSizePt,bold,italic:false,underline:false,color:'#000000',widthPercent,letterSpacingPercent});
const paragraph=(alignment:LookAlignment,lineSpacingPercent:number,firstLineIndentHu=0,spaceBeforeHu=0,keepWithNext=true):LookParagraph=>({alignment,lineSpacingPercent,firstLineIndentHu,marginLeftHu:0,marginRightHu:0,spaceBeforeHu,spaceAfterHu:0,keepWithNext});
export const KOREAN_COMMUNICATION_LOOK:DocumentLook={kind:'document',profile:{page:HM_PAGE,roles:{
 body:{styleName:'바탕글',character:character('신명조',10,false,95,-10),paragraph:paragraph('JUSTIFY',160,1000,0,false)},
 h1:{styleName:'제목 1',character:character('맑은 고딕',14,true,95,-10),paragraph:paragraph('CENTER',160)},
 h2:{styleName:'제목 2',character:character('HY견고딕',10,false,95,-10),paragraph:paragraph('JUSTIFY',160)},
 h3:{styleName:'제목 3',character:character('맑은 고딕',10,true,100,0),paragraph:paragraph('JUSTIFY',160)},
 h4:{styleName:'제목 4',character:character('신명조',10,true,100,0),paragraph:paragraph('JUSTIFY',160)},
 h5:{styleName:'제목 5',character:character('휴먼명조',13,true,100,0),paragraph:paragraph('LEFT',180)},
 h6:{styleName:'제목 6',character:character('맑은 고딕',10,true,100,0),paragraph:paragraph('LEFT',180,0,1000)}}}};
export const YOUTH_STUDIES_LOOK:DocumentLook={kind:'document',profile:{page:HM_PAGE,roles:{
 body:{styleName:'바탕글',character:character('휴먼명조',10,false,95,0),paragraph:paragraph('JUSTIFY',170,1000,0,false)},
 h1:{styleName:'제목 1',character:character('휴먼명조',15,true,95,0),paragraph:paragraph('CENTER',170)},
 h2:{styleName:'제목 2',character:character('휴먼명조',12,true,95,0),paragraph:paragraph('CENTER',170)},
 h3:{styleName:'제목 3',character:character('휴먼명조',11,true,95,0),paragraph:paragraph('LEFT',170)},
 h4:{styleName:'제목 4',character:character('휴먼명조',11,true,100,0),paragraph:paragraph('LEFT',170)},
 h5:{styleName:'제목 5',character:character('휴먼명조',13,true,100,0),paragraph:paragraph('LEFT',180)},
 h6:{styleName:'제목 6',character:character('맑은 고딕',10,true,100,0),paragraph:paragraph('LEFT',180,0,1000)}}}};
const HALLYM_GOTHIC='한림고딕체 Regular',HUMAN_MYEONGJO='휴먼명조';
/** 회의록·회의자료 모양: 한림고딕체 11pt, "1." 절 제목, • / - 항목, 남색 머리행 표, 가운데 쪽 번호. */
export const HALLYM_ILSONG_LOOK:GongmunLook={kind:'gongmun',preset:'minutes',
 options:{bodyPt:11,lineSpacing:160,numbering:'standard',fonts:{body:HALLYM_GOTHIC,heading:HALLYM_GOTHIC,ref:HALLYM_GOTHIC,table:HALLYM_GOTHIC},levels:{'0':{bold:true}},margins:{top:20,bottom:15,left:20,right:20},pageNumbers:true,endMark:false},
 finish:{markers:{legal1:'•',legal2:'-',legal3:'·',legal4:'·',legal5:'·',legal6:'·',legal7:'·'},tableHeader:{fill:'#203864',textColor:'#FFFFFF'},title:{pt:15,bold:true,font:'body'},chapter:{blankLineBefore:true}},
 outline:{boldSubHeadings:true}};
/** 연구 보고서 모양: 파랑·청록 선 표지, 휴먼명조, 1. 제목 → 1) 소제목 → ○ → - → · 본문. */
export const HALLYM_AICR_LOOK:GongmunLook={kind:'gongmun',preset:'report',
 options:{bodyPt:11,lineSpacing:160,numbering:'report',h2Marker:'number',bullet2:'○',fonts:{body:HUMAN_MYEONGJO,heading:HUMAN_MYEONGJO,ref:HUMAN_MYEONGJO,table:HUMAN_MYEONGJO},levels:{'0':{font:HUMAN_MYEONGJO,pt:13,bold:false},'1':{font:HUMAN_MYEONGJO,pt:11},'2':{font:HUMAN_MYEONGJO,pt:11},'3':{font:HUMAN_MYEONGJO,pt:11}},pageNumbers:true},
 finish:{markers:{box0:'{n})'},chapter:{pt:13,bold:true},cover:{removeInfoBox:true,removeBodyTitle:true,barColors:['#0066B3','#00B6AD'],linePt:15,lineBold:false}},
 quietEngineNotes:['보고서 요약박스가 없습니다'],coverDate:'day',outline:{nestChapterLists:true}};
export const standardLook=(preset:LookPreset):GongmunLook=>({kind:'gongmun',preset,options:{}});

// ------------------------------------------------------------------ editing and description
export type SummaryRole='title'|'heading'|'body'|'tableHeader'|'tableCell';
export interface RolePatch {fontFamily?:string;fontSizePt?:number;bold?:boolean;spacingPercent?:number;alignment?:'left'|'center'|'right'|'justify';lineSpacingPercent?:number}
const DOCUMENT_ROLE:Partial<Record<SummaryRole,DocumentStyleRole>>={title:'h1',heading:'h2',body:'body'};
/** Fields of a summary role that change this look's generated document (others are fixed by the document type). */
export function editableLookFields(look:TemplateLook,role:SummaryRole):(keyof RolePatch)[]{
 if(look.kind==='document')return DOCUMENT_ROLE[role]?['fontFamily','fontSizePt','bold','spacingPercent','alignment','lineSpacingPercent']:[];
 return role==='body'?['fontFamily','fontSizePt','lineSpacingPercent']:role==='title'||role==='heading'?['fontFamily','fontSizePt','bold']:['fontFamily'];
}
/** Applies explicit role values to the look; returns the fields that this look cannot take. */
export function applyRolePatchToLook(look:TemplateLook,role:SummaryRole,patch:RolePatch):(keyof RolePatch)[]{
 const editable=editableLookFields(look,role),skipped=(Object.keys(patch) as (keyof RolePatch)[]).filter(k=>patch[k]!==undefined&&!editable.includes(k));
 if(look.kind==='document'){
  const target=DOCUMENT_ROLE[role];if(!target)return skipped;
  const profile=look.profile??={roles:{}},r=profile.roles[target]??={};const c=r.character??={},p=r.paragraph??={};
  if(patch.fontFamily!==undefined){c.fontFamily=patch.fontFamily;c.latinFontFamily=patch.fontFamily;}
  if(patch.fontSizePt!==undefined)c.fontSizePt=patch.fontSizePt;
  if(patch.bold!==undefined)c.bold=patch.bold;
  if(patch.spacingPercent!==undefined)c.letterSpacingPercent=patch.spacingPercent;
  if(patch.alignment!==undefined)p.alignment=patch.alignment.toUpperCase() as LookAlignment;
  if(patch.lineSpacingPercent!==undefined)p.lineSpacingPercent=Math.max(70,Math.min(400,patch.lineSpacingPercent));
  return skipped;
 }
 const o=look.options;
 if(role==='body'){
  if(patch.fontFamily!==undefined){o.fonts={...o.fonts,body:patch.fontFamily};for(const level of Object.values(o.levels??{}))if(level?.font)level.font=patch.fontFamily;}
  if(patch.fontSizePt!==undefined)o.bodyPt=Math.max(8,Math.min(24,patch.fontSizePt));
  if(patch.lineSpacingPercent!==undefined)o.lineSpacing=Math.max(100,Math.min(250,patch.lineSpacingPercent));
 }else if(role==='title'||role==='heading'){
  if(patch.fontFamily!==undefined)o.fonts={...o.fonts,heading:patch.fontFamily};
  const key=role==='title'?'title':'chapter';
  if(patch.fontSizePt!==undefined||patch.bold!==undefined){const f=look.finish??={};const t:{pt?:number;bold?:boolean}=f[key]??={};if(patch.fontSizePt!==undefined)t.pt=Math.max(6,Math.min(60,patch.fontSizePt));if(patch.bold!==undefined)t.bold=patch.bold;}
 }else if(patch.fontFamily!==undefined)o.fonts={...o.fonts,table:patch.fontFamily};
 return skipped;
}
const PRESET_NAMES:Record<LookPreset,string>={official:'기안문',report:'보고서',plan:'계획서',notice:'통지·안내',minutes:'회의록',gaejosik:'정부 표준 개조식',press:'보도자료',ministry:'업무보고',bangchim:'방침서'};
const ALIGN:Record<string,string>={LEFT:'왼쪽',CENTER:'가운데',RIGHT:'오른쪽',JUSTIFY:'양쪽',DISTRIBUTE:'배분',DISTRIBUTE_SPACE:'나눔'};
const ROLE_NAMES:Record<DocumentStyleRole,string>={body:'본문',h1:'제목 1',h2:'제목 2',h3:'제목 3',h4:'제목 4',h5:'제목 5',h6:'제목 6',quote:'인용',code:'코드',list:'목록'};
const MARKER_ORDER:MarkerClass[]=['legal1','legal2','legal3','box0','box1','box2','box3'];
/** Human-readable values of a look, for the template window. */
export function describeTemplateLook(look:TemplateLook):string[]{
 if(look.kind==='document'){
  if(!look.profile)return ['Kordoc 기본 문서 스타일: 본문 함초롬바탕 10pt · 줄간격 160%, 제목 함초롬돋움 18/14/12/11pt 굵게'];
  const lines=Object.entries(look.profile.roles).map(([role,r])=>{const c=r?.character??{},p=r?.paragraph??{};return [ROLE_NAMES[role as DocumentStyleRole],[c.fontFamily,c.fontSizePt!==undefined?c.fontSizePt+'pt':'',c.bold?'굵게':''].filter(Boolean).join(' '),c.widthPercent!==undefined&&c.widthPercent!==100?'장평 '+c.widthPercent+'%':'',c.letterSpacingPercent?'자간 '+c.letterSpacingPercent+'%':'',p.alignment?ALIGN[p.alignment]+' 정렬':'',p.lineSpacingPercent?'줄간격 '+p.lineSpacingPercent+'%':'',p.firstLineIndentHu?'첫 줄 '+p.firstLineIndentHu/100+'pt 들여쓰기':'',p.spaceBeforeHu?'위 '+p.spaceBeforeHu/100+'pt':''].filter(Boolean).join(' · ');});
  const mm=(hu:number)=>(hu/283.46).toFixed(0),page=look.profile.page;
  if(page)lines.push(`용지 ${mm(page.widthHu)}×${mm(page.heightHu)}mm · 여백 위 ${mm(page.margins.top)} 아래 ${mm(page.margins.bottom)} 좌 ${mm(page.margins.left)} 우 ${mm(page.margins.right)}mm`);
  return lines;
 }
 const o=look.options,f=look.finish,lines=['문서 종류: '+PRESET_NAMES[look.preset]+' (Kordoc 양식 위에 아래 값만 바꿉니다)'];
 const body=[[o.fonts?.body,o.bodyPt!==undefined?o.bodyPt+'pt':''].filter(Boolean).join(' '),o.lineSpacing!==undefined?'줄간격 '+o.lineSpacing+'%':''].filter(Boolean).join(' · ');if(body)lines.push('본문 '+body);
 if(o.fonts?.heading&&o.fonts.heading!==o.fonts.body)lines.push('제목 계열 '+o.fonts.heading);
 if(o.fonts?.table&&o.fonts.table!==o.fonts.body)lines.push('표 '+o.fonts.table);
 if(f?.title)lines.push('문서 제목 '+[f.title.pt?f.title.pt+'pt':'',f.title.bold?'굵게':'',f.title.font==='body'?'본문 글꼴':''].filter(Boolean).join(' '));
 if(f?.chapter)lines.push('절 제목 '+[f.chapter.pt?f.chapter.pt+'pt':'',f.chapter.bold?'굵게':'',f.chapter.blankLineBefore?'절 사이 한 줄 띄움':''].filter(Boolean).join(' '));
 const marks=MARKER_ORDER.filter(k=>f?.markers?.[k]).map(k=>f!.markers![k]==='{n})'?'1) 2)':f!.markers![k]);if(marks.length)lines.push('항목 부호 '+[...new Set(marks)].join(' '));
 if(o.h2Marker==='number')lines.push('장 제목 "1." 번호');else if(o.h2Marker)lines.push('장 제목 표기 '+o.h2Marker);
 if(o.bullet2)lines.push('2단계 부호 '+o.bullet2);
 if(f?.tableHeader)lines.push('표 머리행 '+f.tableHeader.fill+' 바탕 · 흰 글자');
 if(f?.cover?.barColors)lines.push('표지 선 '+f.cover.barColors.join(' · ')+(f.cover.removeInfoBox?' · 서울시 정보 상자 없음':''));
 if(o.margins)lines.push(`여백 위 ${o.margins.top} 아래 ${o.margins.bottom} 좌 ${o.margins.left} 우 ${o.margins.right}mm`);
 if(o.pageNumbers)lines.push('가운데 쪽 번호');
 if(look.preset==='notice')lines.push('끝에 오늘 날짜를 오른쪽 정렬로 붙입니다');
 if(look.outline?.boldSubHeadings)lines.push('소제목은 번호 없이 굵게');
 return lines;
}
/** Font families a look writes on purpose (Kordoc's own preset fonts are reported from the generated file). */
export function lookFontFamilies(look:TemplateLook):string[]{
 const found=new Set<string>();
 if(look.kind==='document')for(const r of Object.values(look.profile?.roles??{})){if(r?.character?.fontFamily)found.add(r.character.fontFamily);if(r?.character?.latinFontFamily)found.add(r.character.latinFontFamily);}
 else{for(const f of Object.values(look.options.fonts??{}))if(f)found.add(f);for(const l of Object.values(look.options.levels??{}))if(l?.font)found.add(l.font);}
 return [...found].map(f=>f==='신명조'?'한양신명조':f);
}
