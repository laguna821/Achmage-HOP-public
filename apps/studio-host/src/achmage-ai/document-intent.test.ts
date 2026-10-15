import {describe,it,expect,vi} from 'vitest';
vi.mock('../core/desktop-local-fonts',()=>({getDesktopFonts:()=>['함초롬바탕','신명조']}));
import {prepareStructuredEdit,decodeStructuredResponse,shouldUseStructuredEdit,asksForDocumentWriting,asksForWholeDocumentRecomposition,resolveDocumentTemplate,type IntentDeps} from './document-intent';
import type {AiDocument} from './document';
import type {ParagraphRange,StructuredCapture} from './structured-edit';
import {parseStructuredPlan,structuredParagraphs} from './structured-edit';
import {templateLayout} from './document-templates';
import {roleTemplateFixture} from './document-template-fixture';
function fixture(texts:string[],selection:unknown=null){
 const capture=vi.fn((range?:ParagraphRange):StructuredCapture=>({range:range??{section:0,startParagraph:0,paragraphCount:1},identity:{} as StructuredCapture['identity'],selection:'fixed',controls:'[]',beforeParagraphs:(range?texts.slice(range.startParagraph,range.startParagraph+range.paragraphCount):[texts[0]]).map(text=>({text,paraFormat:{alignment:'LEFT'},charFormats:[{fontFamilies:['신명조'],fontSize:1100}]})),allParagraphs:[]}));
 const insertion=vi.fn(()=>({...capture(),range:{section:0,startParagraph:1,paragraphCount:0}}));
 const doc={captureStructured:capture,captureStructuredInsertion:insertion} as unknown as AiDocument;
 const deps={wasm:{getSectionCount:()=>1,getParagraphCount:()=>texts.length,getParagraphLength:(_s:number,p:number)=>Array.from(texts[p]).length,getTextRange:(_s:number,p:number)=>texts[p]},input:{getSelection:()=>selection,getCursorPosition:()=>({sectionIndex:0,paragraphIndex:0,charOffset:0})},availableFonts:['함초롬바탕','신명조']} as unknown as IntentDeps;
 return {doc,deps,capture,insertion};
}
const run={text:'본문',fontFamily:'신명조',fontSizePt:11,bold:false,spacingPercent:0};
const plan={schemaVersion:1,operation:'replace_paragraphs',paragraphs:[{runs:[run]}]};
const v2=()=>({schemaVersion:2,operation:'replace_paragraphs',styles:{body:{fontFamily:'신명조',fontSizePt:11,bold:false,spacingPercent:0},tableCell:{fontFamily:'신명조',fontSizePt:11,bold:false,spacingPercent:0}},blocks:[{type:'paragraph',runs:[{text:'본문',style:'body'}],paragraphFormat:{alignment:'left',lineSpacingPercent:160}},{type:'table',rows:[[{runs:[{text:'표 내용',style:'tableCell'}],paragraphFormat:{alignment:'left',lineSpacingPercent:130}}]]}]});
describe('document intent bounded scope and typed plans',()=>{
 it('recognizes the exact current-document full-template request without reading or modifying a document',()=>{
  expect(asksForWholeDocumentRecomposition('양식을 바꿨는데 바뀐 양식대로 표지 목차 등이 전부 적용될 수 있게 만들어봐. 현재 한글에 작성한 문서 내용 전체 기준으로')).toBe(true);
  expect(asksForWholeDocumentRecomposition('양식을 바꿨는데 바뀐 양식대로 표지 목차 등이 전부 적용될 수 있게 만들어봐')).toBe(true);
  expect(asksForWholeDocumentRecomposition('바뀐 양식대로 표지 목차 등이 전부 적용될 수 있는 방법 알려줘')).toBe(false);
  for(const t of ['현재 문서 전체를 선택한 템플릿으로 재구성해줘','전체 문서에 바뀐 양식을 적용해 주세요','기존 본문 전부를 기준으로 표지와 목차가 있는 보고서를 만들어줘','현재 한글에 쓴 내용 전체를 새 서식으로 만들어봐. 개인정보와 날짜는 쓰지 말아줘','문서 전체를 새 양식으로 만들어줘. 내용은 바꾸지 말고'])expect(asksForWholeDocumentRecomposition(t),t).toBe(true);
 });
 it('does not promote partial edits, questions, quotes, history or cancelled composition to entire-document generation',()=>{
  expect(asksForWholeDocumentRecomposition('문서 전체를 새 서식으로 만들어줘. 아니 적용하지마')).toBe(false);
  expect(asksForWholeDocumentRecomposition('전체 문서가 아니고 선택한 내용에만 새 양식을 적용해줘')).toBe(false);
  for(const t of ['새 서식으로 보고서를 만들어줘','선택한 문단에 서식을 적용해줘','문서 전체가 아니라 선택한 부분만 새 양식으로 만들어줘','현재 문서 전체 중 제목만 서식을 바꿔줘','문서 전체에 양식을 적용하는 방법 알려줘','현재 문서 전체를 새 서식으로 만들지 말아줘','현재 문서 전체에 새 서식을 적용하지 말아줘','현재 문서 전체를 재구성해줘. 아니 재구성하지 말아줘','"현재 문서 전체를 새 양식으로 만들어줘"라는 요청을 설명해줘','문서 전체 양식을 바꿨어'])expect(asksForWholeDocumentRecomposition(t),t).toBe(false);
 });
 it('resolves new-document template roles without any open-document capture or mutation',()=>{
  const source=roleTemplateFixture(),before=JSON.stringify(source);
  const result=resolveDocumentTemplate(source,'본문 함초롱바탕 11pt 줄간격 180%, 표 내용 신명조 10pt',['함초롬바탕','신명조']);
  expect(result.template.roles.body).toMatchObject({fontFamily:'함초롬바탕',fontSizePt:11,lineSpacingPercent:180});expect(result.template.roles.tableCell).toMatchObject({fontFamily:'신명조',fontSizePt:10});expect(result.notices).toHaveLength(1);expect(JSON.stringify(source)).toBe(before);
  expect(()=>resolveDocumentTemplate(source,'함초롱바탕으로 써줘',['신명조'])).toThrow('확인');
 });
 it('routes the actual selected-format meeting request with the Korean table particle',()=>{
  expect(shouldUseStructuredEdit('서식을 바꿨어 이번에는 지금 선택한 서식으로 한두페이지짜리 회의자료를 표와 함께 만들어보자')).toBe(true);
 });
 it('shares writing classification for imperative variants, not questions, quotations, history or non-document tasks',()=>{
  for(const t of ['서식을 바꿨어 이번에는 지금 선택한 서식으로 한두페이지짜리 회의자료를 표와 함께 만들어보자','회의 자료 만들어 줘','보고서를 작성하자','3줄 새 글을 써줘','한두 페이지 공문을 만들어주세요','보도자료 생성해줘'])expect(asksForDocumentWriting(t),t).toBe(true);
  for(const t of ['회의자료를 만들었어','보고서 작성 방법 알려줘','표와 테이블의 차이를 설명해줘','"회의자료를 표와 함께 만들어보자"라는 문장의 뜻은?','회의자료 만들지 말고 설명해줘','문서 생성하지 말아줘','프로그램을 만들어줘','서식을 바꿨어','회의자료 수정해줘'])expect(asksForDocumentWriting(t),t).toBe(false);
  for(const t of ['표와 테이블의 차이를 설명해줘','글꼴을 바꾸는 방법 알려줘','"표를 추가해"라는 문장의 뜻은?'])expect(shouldUseStructuredEdit(t),t).toBe(false);
  for(const t of ['표와 함께 보고서를 만들어줘','표랑 본문을 추가해','표까지 넣어줘','표하고 소제목 추가'])expect(shouldUseStructuredEdit(t),t).toBe(true);
 });
 it('inserts the exact meeting request at nonempty caret and carries the same selected template through decode',()=>{
  const f=fixture(['원래 내용','뒤 문단']),request='서식을 바꿨어 이번에는 지금 선택한 서식으로 한두페이지짜리 회의자료를 표와 함께 만들어보자';
  const template=roleTemplateFixture();template.roles.body.lineSpacingPercent=190;template.roles.tableCell.fontSizePt=12;
  const original=JSON.stringify(template),result=prepareStructuredEdit(f.doc,f.deps,request,{template});
  expect(f.insertion).toHaveBeenCalledOnce();expect(result.capture.range.paragraphCount).toBe(0);expect(result.prompt).toContain('커서 위치에 새 내용을 삽입');expect(result.prompt).toContain(request);
  expect(result.styleContext).toEqual(template);expect(result.styleContext).not.toBe(template);expect(JSON.stringify(template)).toBe(original);
  template.roles.body.lineSpacingPercent=500;
  const decoded=decodeStructuredResponse(JSON.stringify(v2()),{template:result.styleContext});
  expect(decoded.paragraphs[0].paragraphFormat?.lineSpacingPercent).toBe(190);expect(decoded.paragraphs[1].table?.[0][0].runs[0].fontSizePt).toBe(12);
 });
 it('does not convert an insertion capture error into replacement or a chat request',()=>{
  const f=fixture(['기존 표 문맥']);f.insertion.mockImplementation(()=>{throw Error('셀 안에서는 생성할 수 없습니다.');});
  expect(()=>prepareStructuredEdit(f.doc,f.deps,'표와 함께 회의자료를 만들어보자')).toThrow('셀 안');expect(f.capture).not.toHaveBeenCalled();
 });
 it('routes explicit font, heading and expansion, leaving ordinary chat alone',()=>{
  for(const t of ['소제목을 추가해','다섯 줄로 확장해','글꼴은 신명조 11pt','자간 -5로 바꿔'])expect(shouldUseStructuredEdit(t)).toBe(true);
  expect(shouldUseStructuredEdit('오늘 날씨가 어때?')).toBe(false);
  expect(shouldUseStructuredEdit('3줄 새 글을 써줘')).toBe(false);
  expect(shouldUseStructuredEdit('3줄 작성해')).toBe(false);
  expect(shouldUseStructuredEdit('3문단으로 써줘')).toBe(true);
 });
 it('selected scope has priority over whole-document wording',()=>{
  const f=fixture(['첫째','둘째'],{start:{sectionIndex:0,paragraphIndex:0,charOffset:0},end:{sectionIndex:0,paragraphIndex:0,charOffset:2}});
  prepareStructuredEdit(f.doc,f.deps,'문서 전체 글꼴 수정');expect(f.capture).toHaveBeenCalledWith();
 });
 it('keeps partial selection rejection from the document engine',()=>{
  const f=fixture(['원문'],{});f.deps.input.getSelection=()=>({start:{sectionIndex:0,paragraphIndex:0,charOffset:1},end:{sectionIndex:0,paragraphIndex:0,charOffset:2}} as ReturnType<IntentDeps['input']['getSelection']>);
  f.capture.mockImplementation(()=>{throw Error('문단 전체');});expect(()=>prepareStructuredEdit(f.doc,f.deps,'굵게')).toThrow('전체');
 });
 it('allows empty caret and quotes original styles in prompt',()=>{
  const f=fixture(['']);const r=prepareStructuredEdit(f.doc,f.deps,'다섯 줄로 써줘');
  expect(r.prompt).toContain('fontSize');expect(r.prompt).toContain('replace_paragraphs');expect(f.insertion).toHaveBeenCalledOnce();
 });
 it('requires explicit whole-document scope and never implicitly overwrites nonempty caret',()=>{
  const f=fixture(['원문','다음']);expect(()=>prepareStructuredEdit(f.doc,f.deps,'굵게 바꿔')).toThrow('선택');
  prepareStructuredEdit(f.doc,f.deps,'문서 전체를 굵게');expect(f.capture).toHaveBeenLastCalledWith({section:0,startParagraph:0,paragraphCount:2});
 });
 it('matches a literal unique previous response across complete paragraphs',()=>{
  const f=fixture(['앞','이전 글','두 번째','뒤']);
  const r=prepareStructuredEdit(f.doc,f.deps,'방금 쓴 소설을 확장해',{priorAssistantTexts:['이전 글\n두 번째']});
  expect(r.capture.range).toEqual({section:0,startParagraph:1,paragraphCount:2});
 });
 it('rejects duplicate, partial or differently spaced prior text',()=>{
  for(const [texts,prior] of [[['같은 글','같은 글'],'같은 글'],[['앞 같은 글 뒤'],'같은 글'],[['같은 글'],'같은  글']] as [string[],string][]){
   const f=fixture(texts);expect(()=>prepareStructuredEdit(f.doc,f.deps,'방금 쓴 글 굵게',{priorAssistantTexts:[prior]})).toThrow('선택');
  }
 });
 it('uses only last ten responses and rejects contradictory matched ranges',()=>{
  const f=fixture(['오래된 글','최신 글']);
  expect(()=>prepareStructuredEdit(f.doc,f.deps,'방금 쓴 글 굵게',{priorAssistantTexts:['오래된 글',...Array(10).fill('없음')]})).toThrow();
  expect(()=>prepareStructuredEdit(f.doc,f.deps,'방금 쓴 글 굵게',{priorAssistantTexts:['오래된 글','최신 글']})).toThrow('여러');
 });
 it('uses last-applied text only when current text uniquely matches, never stale numeric coordinates',()=>{
  const f=fixture(['앞','대상']);
  const r=prepareStructuredEdit(f.doc,f.deps,'방금 쓴 글 굵게',{lastAppliedRange:{range:{section:0,startParagraph:0,paragraphCount:1},paragraphs:['대상']}});
  expect(r.capture.range.startParagraph).toBe(1);
 });
 it('extracts previous typed plans and annotated drafts as literal text without execution',()=>{
  const f=fixture(['앞','본문']);
  const r=prepareStructuredEdit(f.doc,f.deps,'방금 쓴 글 굵게',{priorAssistantTexts:[JSON.stringify(plan)]});expect(r.capture.range.startParagraph).toBe(1);
  expect(decodeStructuredResponse('[본문 | 신명조, 11pt, 보통, 자간 0%]\n본문')).toEqual(plan);
 });
 it('reports requested font alias only when canonical local font exists',()=>{
  const f=fixture(['']);const r=prepareStructuredEdit(f.doc,f.deps,'함초롱바탕으로 써줘');expect(r.notices[0]).toContain('함초롬바탕');expect(r.prompt).toContain('함초롬바탕으로');
  f.deps.availableFonts=['신명조'];expect(()=>prepareStructuredEdit(f.doc,f.deps,'함초롱바탕으로')).toThrow('확인');
 });
 it('accepts strict JSON and json fence, rejects surrounding prose, keys, controls and unavailable font',()=>{
  expect(decodeStructuredResponse(JSON.stringify(plan))).toEqual(plan);
  expect(decodeStructuredResponse('\x60\x60\x60json\n'+JSON.stringify(plan)+'\n\x60\x60\x60')).toEqual(plan);
  for(const t of ['설명 '+JSON.stringify(plan),JSON.stringify({...plan,command:'execute'}),JSON.stringify({...plan,paragraphs:[{runs:[{...run,fontFamily:'미설치'}]}]}),JSON.stringify({...plan,paragraphs:[{runs:[{...run,text:'a\nb'}]}]})])expect(()=>decodeStructuredResponse(t)).toThrow();
 });
 it('long instructions pass while structured output and font validation remain',()=>{
  const f=fixture(['']);const text='가'.repeat(140000)+'끝표식';expect(prepareStructuredEdit(f.doc,f.deps,text).prompt).toContain(text);
  expect(()=>decodeStructuredResponse('x'.repeat(8*1024*1024+1))).toThrow('8MiB');
  f.deps.availableFonts=[];expect(()=>prepareStructuredEdit(f.doc,f.deps,'소제목')).toThrow('글꼴');
 });
 it('rejects duplicate JSON keys including escaped equivalents',()=>{
  const text=JSON.stringify(plan).replace('"bold":false','"bold":true,"bold":false');
  expect(()=>decodeStructuredResponse(text)).toThrow('중복');
  expect(()=>decodeStructuredResponse(text.replace('"bold":true','"b\\u006fld":true'))).toThrow('중복');
 });
 it('does not treat a negated whole-document mention as permission',()=>{
  const f=fixture(['원문','다음']);expect(()=>prepareStructuredEdit(f.doc,f.deps,'문서 전체는 바꾸지 말고 글꼴 수정')).toThrow('선택');
  expect(f.capture).not.toHaveBeenCalled();
 });
 it('treats css fenced historical annotations as data, never styles or executable content',()=>{
  expect(decodeStructuredResponse('\x60\x60\x60css\n[본문 | 신명조, 11pt, 보통, 자간 0%]\n본문\n\x60\x60\x60')).toEqual(plan);
  expect(()=>decodeStructuredResponse('\x60\x60\x60css\nbody { color:red; }\n\x60\x60\x60')).toThrow();
  expect(()=>decodeStructuredResponse('\x60\x60\x60css\n'+JSON.stringify(plan)+'\n\x60\x60\x60')).toThrow();
 });
 it('reuses annotated font typo without another model call only with a visible notice sink and actual canonical font',()=>{
  const text='[본문 | 함초롱바탕, 11pt, 보통, 자간 0%]\n본문',notices:string[]=[];
  const p=decodeStructuredResponse(text,{notices});expect(p.paragraphs[0].runs[0].fontFamily).toBe('함초롬바탕');expect(notices).toHaveLength(1);
  expect(()=>decodeStructuredResponse(text)).toThrow('글꼴');
  expect(()=>decodeStructuredResponse(text,{notices:[],availableFonts:['신명조']})).toThrow('글꼴');
 });
 it('projects repeated styles once and limits font catalog without weakening exact capture',()=>{
  const f=fixture(['']);const c=f.capture();c.beforeParagraphs[0].text='가'.repeat(4000);c.beforeParagraphs[0].charFormats=Array.from({length:4000},()=>({fontFamilies:Array(7).fill('신명조'),fontSize:1100,bold:false,spacings:Array(7).fill(0)}));f.capture.mockReturnValue(c);
  f.deps.availableFonts=['함초롬바탕','신명조',...Array.from({length:2000},(_,i)=>'UnrelatedFamily'+i)];
  const before=JSON.stringify(c),r=prepareStructuredEdit(f.doc,f.deps,'함초롬바탕으로 바꿔');expect(JSON.stringify(c)).toBe(before);expect(r.prompt).not.toContain('UnrelatedFamily');expect(r.prompt.length).toBeLessThan(6500);expect(r.prompt).toContain('"end":4000');expect(r.prompt.match(/"fontSize":1100/g)).toHaveLength(1);
 });
 it('routes actual table and line spacing requests and validates fonts inside cells',()=>{
  expect(shouldUseStructuredEdit('표를 추가해')).toBe(true);expect(shouldUseStructuredEdit('줄 간격 180%')).toBe(true);
  const p=decodeStructuredResponse(JSON.stringify(v2()));expect(p.paragraphs[1].table?.[0][0].paragraphFormat?.lineSpacingPercent).toBe(130);
  const bad=v2();bad.styles.tableCell.fontFamily='없는폰트';expect(()=>decodeStructuredResponse(JSON.stringify(bad))).toThrow('글꼴');
 });
 it('keeps selected template styles local, and freezes explicit role overrides before the response',()=>{
  const f=fixture(['']),template=roleTemplateFixture(),before=JSON.stringify(template);
  const prepared=prepareStructuredEdit(f.doc,f.deps,'본문은 신명조 11pt 자간 -5 줄간격 180% 왼쪽 정렬, 표 본문은 줄간격 140%',{template});
  expect(JSON.stringify(template)).toBe(before);expect(prepared.styleContext?.roles.body).toMatchObject({fontFamily:'신명조',fontSizePt:11,spacingPercent:-5,lineSpacingPercent:180,alignment:'left'});
  template.roles.body.fontSizePt=50;
  const raw=v2();raw.styles.body.fontSizePt=70;raw.blocks[0].paragraphFormat!.lineSpacingPercent=400;
  const result=decodeStructuredResponse(JSON.stringify(raw),{template:prepared.styleContext});
  expect(result.paragraphs[0].runs[0].fontSizePt).toBe(11);expect(result.paragraphs[0].paragraphFormat).toEqual({alignment:'left',lineSpacingPercent:180});expect(result.paragraphs[1].table?.[0][0].paragraphFormat?.lineSpacingPercent).toBe(140);
 });
 it('keeps agency defaults untouched until a role override is explicitly requested',()=>{
  const t=roleTemplateFixture();t.layout={...templateLayout(t),agency:'공통'};
  t.roles.title.fontFamily='UNUSED_ROLE_FONT';
  const original=JSON.stringify(t);
  const resolved=resolveDocumentTemplate(t,'본문은 신명조 11pt로 회의자료를 만들어보자',['신명조']);
  expect(resolved.template.layout?.agencyRoleOverrides).toEqual(['body']);
  expect(resolved.template.roles.body.fontFamily).toBe('신명조');
  expect(resolved.template.roles.title.fontFamily).toBe('UNUSED_ROLE_FONT');
  expect(JSON.stringify(t)).toBe(original);
  const f=fixture(['원문']);
  expect(()=>prepareStructuredEdit(f.doc,f.deps,'본문 수정',{template:t})).toThrow('새 문서');
  expect(f.capture).not.toHaveBeenCalled();
 });
 it('rejects unsupported roles and invalid explicit local template metrics',()=>{
  const f=fixture(['']),template=roleTemplateFixture();
  expect(()=>prepareStructuredEdit(f.doc,f.deps,'본문 줄간격 800%',{template})).toThrow('줄간격');
  const unknown={...v2(),styles:{...v2().styles,custom:{...v2().styles.body}}};expect(()=>decodeStructuredResponse(JSON.stringify(unknown),{template})).toThrow('역할');
  expect(()=>decodeStructuredResponse(JSON.stringify(plan),{template})).toThrow('v2');
 });
 it('canonicalizes v2 font aliases in source styles as well as derived paragraphs',()=>{
  const raw=v2();raw.styles.body.fontFamily='함초롱바탕';raw.styles.tableCell.fontFamily='함초롱바탕';
  const notices:string[]=[],p=decodeStructuredResponse(JSON.stringify(raw),{notices});expect(notices).toHaveLength(1);expect(structuredParagraphs(p).every(p=>p.runs.every(r=>r.fontFamily==='함초롬바탕'))).toBe(true);expect(parseStructuredPlan(p)).toEqual(p);
 });
 it('never flattens a previous table response to infer a body replacement range',()=>{
  const f=fixture(['본문']);expect(()=>prepareStructuredEdit(f.doc,f.deps,'방금 쓴 글 줄간격 수정',{priorAssistantTexts:[JSON.stringify(v2())]})).toThrow('선택');
 });
 it('includes every selected template font in prompt candidates even when absent from original and instruction',()=>{
  const f=fixture(['']),template=roleTemplateFixture();template.roles.title.fontFamily='ActualHeading';f.deps.availableFonts=['함초롬바탕','신명조','ActualHeading'];
  const p=prepareStructuredEdit(f.doc,f.deps,'표를 포함한 보고서를 작성해',{template}).prompt;
  const candidates=p.split('\n').find(s=>s.startsWith('이번 요청과 원문'))!;expect(candidates).toContain('ActualHeading');
 });
});
it('distinguishes document creation from scoped prohibitions on personal content',()=>{
 for(const t of ['선택한 서식으로 두 페이지 회의자료를 표와 함께 만들어줘. 개인정보와 날짜는 쓰지 말아줘','개인정보 쓰지 말고 문서 써줘','보고서를 작성해줘. 이름과 연락처를 절대 쓰지 말아주세요','문서에는 날짜는 쓰지 말고 회의자료를 만들어줘','날짜를 쓰지 않고 보고서를 작성해줘'])expect(asksForDocumentWriting(t),t).toBe(true);
 for(const t of ['보고서를 써줘. 아니, 문서는 만들지 말아줘','문서 작성하지 말고 개인정보 안내문 작성 방법 알려줘','개인정보는 쓰지 말아줘','보고서 써줘. 지금은 만들지 말아줘','문서를 만들지 말고 소설을 써줘','"개인정보 쓰지 말고 보고서를 작성해줘"라는 말의 뜻은?','보고서를 쓰지 말아줘. 개인정보는 제외해줘'])expect(asksForDocumentWriting(t),t).toBe(false);
});
it('reads a Markdown reply that broke the JSON contract as an outline with the template roles, but not a bare claim',()=>{
  const template=roleTemplateFixture();
  const plan=decodeStructuredResponse('# 회의 결과\n- 개편안 확정\n- 일정 협의\n| 구분 | 인원 |\n|---|---|\n| 교수 | 12 |',{template,validateFonts:false});
  expect(plan.paragraphs.map(p=>p.table?'table':p.runs[0].text)).toEqual(['회의 결과','□ 개편안 확정','□ 일정 협의','table']);
  expect(plan.paragraphs[0].runs[0].fontFamily).toBe(template.roles.title.fontFamily);
  expect(()=>decodeStructuredResponse('서식을 적용했습니다.',{template,validateFonts:false})).toThrow('v2');
});

describe('source text is not a font instruction',()=>{
 const installed=['바탕','바탕체','함초롬바탕','신명조','HY신명조','Arial'];
 it('keeps selected styles when pasted Markdown mentions several fonts and sizes',()=>{
  const template=roleTemplateFixture();
  const text='아래 내용을 이 보고서 형식으로 작성해봐: (노트 링크들은 다 빼고 본문 흐름상 상관없는거)\n\n# 긴 보고서 재현용 자료\n본문은 지식을 바탕으로 한다. 함초롬바탕 신명조 Arial 11pt 20pt\n'+('## 본문\n바탕 신명조 12pt 18pt\n'.repeat(3000));
  expect(resolveDocumentTemplate(template,text,installed).template).toEqual(template);
 });
 it('matches a full family once even when shorter families are installed',()=>{
  const result=resolveDocumentTemplate(roleTemplateFixture(),'본문 함초롬바탕 11pt, 제목 HY신명조 20pt',installed).template;
  expect(result.roles.body.fontFamily).toBe('함초롬바탕');expect(result.roles.title.fontFamily).toBe('HY신명조');
 });
 it('does not find font names inside prose words',()=>{
  const template=roleTemplateFixture();
  expect(resolveDocumentTemplate(template,'도메인 지식을 바탕으로 보고서를 작성해줘',installed).template).toEqual(template);
 });
 it('retains explicit overrides before the source and rejects real conflicting fonts',()=>{
  expect(resolveDocumentTemplate(roleTemplateFixture(),'본문 신명조 11pt로 작성해줘\n# 자료\nArial 바탕 20pt',installed).template.roles.body.fontFamily).toBe('신명조');
  expect(()=>resolveDocumentTemplate(roleTemplateFixture(),'본문 신명조 Arial 11pt',installed)).toThrow('여러 글꼴');
 });
});
