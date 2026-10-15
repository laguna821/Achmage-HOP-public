import {describe,it,expect} from 'vitest';
import {BUILTIN_DOCUMENT_TEMPLATES,parseDocumentTemplate,templateGroup,DocumentTemplateStore,type DocumentTemplate} from './document-templates';
import {resolveDocumentTemplate} from './document-intent';
import {parseTemplateLook,applyRolePatchToLook,describeTemplateLook,editableLookFields,lookFontFamilies,HALLYM_ILSONG_LOOK,KOREAN_COMMUNICATION_LOOK,type GongmunLook,type DocumentLook} from './template-look';
const byId=(id:string)=>structuredClone(BUILTIN_DOCUMENT_TEMPLATES.find(t=>t.id===id)!) as DocumentTemplate;
function memory(){const values=new Map<string,string>();return {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};}
describe('HanMark template looks',()=>{
 it('ships every HanMark 2.7.0 template and keeps the former built-in ids',()=>{
  const ids=BUILTIN_DOCUMENT_TEMPLATES.map(t=>t.id);
  for(const id of ['builtin-report','builtin-government','builtin-hallym-ilsong','builtin-press','builtin-hallym-aicr','builtin-plan','builtin-notice','builtin-minutes','builtin-gaejosik','builtin-ministry','builtin-bangchim','builtin-kordoc-default','builtin-korean-communication','builtin-youth-studies'])expect(ids).toContain(id);
  expect(new Set(ids).size).toBe(ids.length);
  for(const t of BUILTIN_DOCUMENT_TEMPLATES){expect(t.look).toBeDefined();expect(parseDocumentTemplate(t)).toEqual(t);expect(describeTemplateLook(t.look!).length).toBeGreaterThan(0);}
 });
 it('gives the report and the Hallym Ilsong form different document types, fonts and finishing',()=>{
  const report=byId('builtin-report'),ilsong=byId('builtin-hallym-ilsong');
  expect(JSON.stringify(report.look)).not.toBe(JSON.stringify(ilsong.look));
  expect(report.roles.body).not.toEqual(ilsong.roles.body);
  expect((ilsong.look as GongmunLook).preset).toBe('minutes');
  expect((ilsong.look as GongmunLook).finish?.tableHeader?.fill).toBe('#203864');
  expect(lookFontFamilies(ilsong.look!)).toEqual(['한림고딕체 Regular']);
  expect(lookFontFamilies(byId('builtin-korean-communication').look!)).toContain('한양신명조');
 });
 it('groups the list by origin',()=>{
  expect(templateGroup(byId('builtin-hallym-aicr'))).toBe('한림대 문서 모양(비공식)');
  expect(templateGroup(byId('builtin-minutes'))).toBe('공문서 양식');
  expect(templateGroup(byId('builtin-youth-studies'))).toBe('문서 스타일');
  expect(templateGroup({...byId('builtin-report'),provenance:'personal'})).toBe('내 템플릿');
 });
 it('rejects unknown keys, bad colors and out-of-range values',()=>{
  for(const bad of [{...HALLYM_ILSONG_LOOK,extra:1},{...HALLYM_ILSONG_LOOK,preset:'secret'},{...HALLYM_ILSONG_LOOK,finish:{tableHeader:{fill:'navy',textColor:'#FFFFFF'}}},{...HALLYM_ILSONG_LOOK,options:{bodyPt:99}},{...HALLYM_ILSONG_LOOK,finish:{markers:{legal1:'<b>'}}},{kind:'document',profile:{roles:{body:{character:{fontFamily:'a;b'}}}}},{kind:'document',profile:{roles:{h9:{}}}},{kind:'other'}])expect(()=>parseTemplateLook(bad)).toThrow();
  expect(parseTemplateLook(structuredClone(KOREAN_COMMUNICATION_LOOK))).toEqual(KOREAN_COMMUNICATION_LOOK);
 });
 it('keeps a look and its layout consistent',()=>{
  const ilsong=byId('builtin-hallym-ilsong');
  expect(()=>parseDocumentTemplate({...ilsong,layout:{...ilsong.layout!,enginePreset:'report'}})).toThrow('문서 종류');
  expect(()=>parseDocumentTemplate({...ilsong,layout:{...ilsong.layout!,agency:'공통'}})).toThrow();
  const paper=byId('builtin-korean-communication');
  expect(()=>parseDocumentTemplate({...paper,layout:{...paper.layout!,cover:true}})).toThrow('표지');
 });
 it('maps explicit role values onto the look and reports what the document type fixes',()=>{
  const g=structuredClone(HALLYM_ILSONG_LOOK);
  expect(applyRolePatchToLook(g,'body',{fontFamily:'맑은 고딕',fontSizePt:12,alignment:'center'})).toEqual(['alignment']);
  expect(g.options.fonts?.body).toBe('맑은 고딕');expect(g.options.bodyPt).toBe(12);
  expect(applyRolePatchToLook(g,'title',{fontSizePt:18,bold:false})).toEqual([]);expect(g.finish?.title).toMatchObject({pt:18,bold:false});
  const d=structuredClone(KOREAN_COMMUNICATION_LOOK) as DocumentLook;
  applyRolePatchToLook(d,'body',{spacingPercent:-5,alignment:'left',lineSpacingPercent:180});
  expect(d.profile?.roles.body?.character?.letterSpacingPercent).toBe(-5);expect(d.profile?.roles.body?.paragraph).toMatchObject({alignment:'LEFT',lineSpacingPercent:180});
  expect(editableLookFields(d,'tableCell')).toEqual([]);
  const plain:DocumentLook={kind:'document'};applyRolePatchToLook(plain,'title',{fontSizePt:20});expect(plain.profile?.roles.h1?.character?.fontSizePt).toBe(20);
  expect(HALLYM_ILSONG_LOOK.options.bodyPt).toBe(11);
 });
 it('resolves explicit requests into the look without requiring the look fonts locally',()=>{
  const {template,notices}=resolveDocumentTemplate(byId('builtin-hallym-ilsong'),'본문은 맑은 고딕 12pt 가운데 정렬로 회의록 써줘',['맑은 고딕','함초롬바탕','함초롬돋움']);
  const look=template.look as GongmunLook;expect(look.options.fonts?.body).toBe('맑은 고딕');expect(look.options.bodyPt).toBe(12);
  expect(notices.join(' ')).toContain('정렬');expect(template.roles.title.fontFamily).toBe('함초롬돋움');
  expect(()=>resolveDocumentTemplate(byId('builtin-hallym-ilsong'),'본문은 없는글꼴체로 써줘',['함초롬바탕'])).not.toThrow();
 });
 it('a personal copy keeps the look through save and reload',()=>{
  const m=memory(),s=new DocumentTemplateStore(m),copy=s.duplicate(byId('builtin-hallym-aicr'));s.save(copy);
  const loaded=new DocumentTemplateStore(m).list().find(t=>t.id===copy.id)!;expect(loaded.look).toEqual(byId('builtin-hallym-aicr').look);expect(loaded.provenance).toBe('personal');
 });
});
