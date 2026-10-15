import {test} from 'node:test';import assert from 'node:assert/strict';import JSZip from 'jszip';
import {generateDocument} from '../engine.mjs';
import {prepareGongmunMarkdown,markerClass,normalizeLook} from '../hanmark-styles.mjs';
// Same values as apps/studio-host/src/achmage-ai/template-look.ts (HanMark 2.7.0 measurements).
const r=(size=11)=>({fontFamily:'함초롬바탕',fontSizePt:size,bold:false,spacingPercent:0,alignment:'left',lineSpacingPercent:160});
const roles={title:r(20),heading:r(14),body:r(),tableHeader:r(),tableCell:r()};
const HG='한림고딕체 Regular',HM='휴먼명조';
const ILSONG={kind:'gongmun',preset:'minutes',options:{bodyPt:11,lineSpacing:160,numbering:'standard',fonts:{body:HG,heading:HG,ref:HG,table:HG},levels:{'0':{bold:true}},margins:{top:20,bottom:15,left:20,right:20},pageNumbers:true,endMark:false},finish:{markers:{legal1:'•',legal2:'-',legal3:'·',legal4:'·',legal5:'·',legal6:'·',legal7:'·'},tableHeader:{fill:'#203864',textColor:'#FFFFFF'},title:{pt:15,bold:true,font:'body'},chapter:{blankLineBefore:true}},outline:{boldSubHeadings:true}};
const AICR={kind:'gongmun',preset:'report',options:{bodyPt:11,lineSpacing:160,numbering:'report',h2Marker:'number',bullet2:'○',fonts:{body:HM,heading:HM,ref:HM,table:HM},levels:{'0':{font:HM,pt:13,bold:false},'1':{font:HM,pt:11},'2':{font:HM,pt:11},'3':{font:HM,pt:11}},pageNumbers:true},finish:{markers:{box0:'{n})'},chapter:{pt:13,bold:true},cover:{removeInfoBox:true,removeBodyTitle:true,barColors:['#0066B3','#00B6AD'],linePt:15,lineBold:false}},quietEngineNotes:['보고서 요약박스가 없습니다'],coverDate:'day',outline:{nestChapterLists:true}};
const ch=(f,s,b,w,l)=>({fontFamily:f,latinFontFamily:f,fontSizePt:s,bold:b,italic:false,underline:false,color:'#000000',widthPercent:w,letterSpacingPercent:l});
const pa=(a,l,i=0,sb=0,k=true)=>({alignment:a,lineSpacingPercent:l,firstLineIndentHu:i,marginLeftHu:0,marginRightHu:0,spaceBeforeHu:sb,spaceAfterHu:0,keepWithNext:k});
const KCA={kind:'document',profile:{page:{widthHu:59530,heightHu:84190,landscape:'WIDELY',gutterType:'LEFT_ONLY',margins:{top:4255,bottom:4960,left:7200,right:7200,header:4250,footer:2240,gutter:0}},roles:{body:{styleName:'바탕글',character:ch('신명조',10,false,95,-10),paragraph:pa('JUSTIFY',160,1000,0,false)},h1:{styleName:'제목 1',character:ch('맑은 고딕',14,true,95,-10),paragraph:pa('CENTER',160)},h2:{styleName:'제목 2',character:ch('HY견고딕',10,false,95,-10),paragraph:pa('JUSTIFY',160)},h5:{styleName:'제목 5',character:ch('휴먼명조',13,true,100,0),paragraph:pa('LEFT',180)}}}};
const tpl=(look,layout)=>({schemaVersion:1,id:'look-test',name:'서식 시험',category:'education',provenance:'sample',description:'시험',roles,look,layout:{cover:false,toc:false,paper:'A4',orientation:'portrait',sampleMarkdown:'# 시험',...layout}});
const MINUTES='# 제1차 운영위원회 회의록\n\n## 회의 개요\n\n- 일시: 3월 5일\n- 장소: 회의실\n\n## 논의 사항\n\n### 추진 방향\n\n- 교과 운영 개선 방향을 논의함\n  - 세부 일정은 다음 회의에서 확정\n\n| 안건 | 결정 |\n| --- | --- |\n| 교과 개편 | 원안 의결 |\n\n## 후속 조치\n\n- 결과를 안내함';
const REPORT='# 하반기 추진 계획\n\n> 하반기 과제를 정리하고자 함\n\n## 추진 배경\n\n- 상반기 성과를 점검함\n  - 일정 조정이 필요함\n\n## 주요 내용\n\n### 과제별 계획\n\n| 구분 | 일정 |\n| --- | --- |\n| 과제 1 | 7월 |';
const PAPER='# 디지털 미디어와 관계\n\n## 1. 서론\n\n본문 문단입니다. 선행 연구를 검토한다.\n\n##### 다섯째 제목\n\n마지막 문단입니다.';
const parts=async r=>{const z=await JSZip.loadAsync(Buffer.from(r.hwpxBase64,'base64'));return {h:await z.file('Contents/header.xml').async('string'),s:await z.file('Contents/section0.xml').async('string')};};
const charPr=(h,id)=>new RegExp(`<hh:charPr id="${id}"[\\s\\S]*?<\\/hh:charPr>`).exec(h)?.[0]??'';
const faceOf=(h,id)=>{const fid=/<hh:fontRef hangul="(\d+)"/.exec(charPr(h,id))?.[1];return new RegExp(`<hh:font id="${fid}" face="([^"]*)"`).exec(/<hh:fontface lang="HANGUL"[\s\S]*?<\/hh:fontface>/.exec(h)[0])?.[1];};
const runOf=(s,text)=>{const at=s.indexOf(text);assert.ok(at>0,text);return [...s.slice(0,at).matchAll(/<hp:run charPrIDRef="(\d+)"/g)].pop()[1];};
test('Hallym Ilsong form keeps the minutes layout with its own font, markers, navy header and title',async()=>{
 const r=await generateDocument(tpl(ILSONG,{enginePreset:'minutes'}),MINUTES),{h,s}=await parts(r);
 assert.ok(r.validation.ok);assert.ok(r.fontFamilies.includes(HG));
 assert.match(s,/<hp:t>•<hp:tab/);assert.match(s,/<hp:t>-<hp:tab/);assert.doesNotMatch(s,/<hp:t>가\.<hp:tab/);
 assert.match(h,/faceColor="#203864"/);
 const title=runOf(s,'제1차 운영위원회');assert.match(charPr(h,title),/height="1500"/);assert.match(charPr(h,title),/<hh:bold\/>/);assert.equal(faceOf(h,title),HG);
 assert.equal(faceOf(h,runOf(s,'교과 운영 개선')),HG);
 assert.ok(!s.includes('### '),'sub-heading numbers dropped and bolded');
});
test('AICR report draws its own cover bars and drops the Seoul information box and repeated title box',async()=>{
 const r=await generateDocument(tpl(AICR,{enginePreset:'report',cover:true}),REPORT),{h,s}=await parts(r);
 assert.ok(r.validation.ok);assert.ok(r.pages.length>=2);
 assert.match(h,/faceColor="#0066B3"/);assert.match(h,/faceColor="#00B6AD"/);
 assert.ok(!s.includes('<hp:t>문서번호</hp:t>'));assert.ok(!s.includes('__kordoc_h1'));
 assert.ok(!r.warnings.some(w=>w.startsWith('보고서 요약박스')));assert.ok(!r.warnings.some(w=>w.includes('기관 서식 일부')));
 assert.match(s,/<hp:t>1\)<hp:tab/);
});
test('the plain report and the Ilsong form produce different documents from the same text',async()=>{
 const a=await generateDocument(tpl({kind:'gongmun',preset:'report',options:{}},{enginePreset:'report',cover:true,toc:true}),MINUTES),b=await generateDocument(tpl(ILSONG,{enginePreset:'minutes'}),MINUTES);
 assert.notDeepEqual(a.fontFamilies,b.fontFamilies);assert.ok(a.fontFamilies.includes('HY헤드라인M'));assert.ok(!b.fontFamilies.includes('HY헤드라인M')||b.fontFamilies.includes(HG));
 const {s}=await parts(a);assert.ok(s.includes('목  차'));assert.ok(a.pages.length>b.pages.length);
});
test('Korean Communication style applies width, letter spacing, indent, page and extended headings',async()=>{
 const r=await generateDocument(tpl(KCA,{enginePreset:'report'}),PAPER),{h,s}=await parts(r);
 assert.ok(r.validation.ok);
 const body=charPr(h,0);assert.match(body,/height="1000"/);assert.match(body,/<hh:ratio hangul="95"/);assert.match(body,/<hh:spacing hangul="-10"/);
 assert.equal(faceOf(h,0),'한양신명조');assert.equal(faceOf(h,6),'HY견고딕');
 assert.match(/<hh:paraPr id="0"[\s\S]*?<\/hh:paraPr>/.exec(h)[0],/<hc:intent value="1000"/);
 assert.match(s,/<hp:margin [^>]*left="7200"/);
 const h5=runOf(s,'다섯째 제목');assert.match(charPr(h,h5),/height="1300"/);assert.equal(faceOf(h,h5),'휴먼명조');
 assert.match(h,/name="제목 2"/);assert.ok(!/HOP_EXTENDED_HEADING/.test(s));
});
test('looks fail closed on unsupported combinations and inputs',async()=>{
 await assert.rejects(generateDocument(tpl(ILSONG,{enginePreset:'report'}),MINUTES),/종류/);
 await assert.rejects(generateDocument(tpl(KCA,{enginePreset:'report',cover:true}),PAPER),/표지/);
 await assert.rejects(generateDocument(tpl({...ILSONG,run:'x'},{enginePreset:'minutes'}),MINUTES));
 await assert.rejects(generateDocument(tpl(ILSONG,{enginePreset:'minutes',agency:'공통'}),MINUTES),/기관/);
 await assert.rejects(generateDocument(tpl(AICR,{enginePreset:'report',agency:'공통'}),REPORT),/함께/);
 await assert.rejects(generateDocument(tpl(ILSONG,{enginePreset:'minutes'}),'# 제목\n\n<script>x</script>'),/HTML/);
 await assert.rejects(generateDocument(tpl(ILSONG,{enginePreset:'minutes'}),'# 제목\n\n![a](https://example.com/a.png)'),/이미지/);
 assert.throws(()=>normalizeLook({...ILSONG,finish:{tableHeader:{fill:'red',textColor:'#FFFFFF'}}}));
});
test('packages declare physical paragraph units and redrawn markers keep the Hancom hanging-indent distance',async()=>{
 const r=await generateDocument(tpl(ILSONG,{enginePreset:'minutes'}),MINUTES),z=await JSZip.loadAsync(Buffer.from(r.hwpxBase64,'base64'));
 const v=await z.file('version.xml').async('string');assert.match(v,/xmlVersion="1\.5"/);assert.match(v,/application="Achmage HOP/);assert.doesNotMatch(v,/Hancom Office/);
 const h=await z.file('Contents/header.xml').async('string'),s=await z.file('Contents/section0.xml').async('string');
 for(const m of s.matchAll(/<hp:p\b[^>]*paraPrIDRef="(\d+)"[^>]*><hp:run charPrIDRef="\d+"><hp:t>([•·-])<hp:tab width="(\d+)"/g)){
  const hang=-Number(/<hc:intent value="(-?\d+)"/.exec(new RegExp(`<hh:paraPr id="${m[1]}"[\\s\\S]*?</hh:paraPr>`).exec(h)[0])[1]);
  const em={'•':0.4,'-':0.438,'·':0.524}[m[2]];assert.ok(Math.abs(Number(m[3])-(hang-em*1100))<=1,m[2]);
 }
 const bullet=/<hp:run charPrIDRef="(\d+)"><hp:t>•<hp:tab/.exec(s)[1];assert.equal(faceOf(h,bullet),'함초롬바탕','• is drawn with the face Hancom falls back to');
 const dash=/<hp:run charPrIDRef="(\d+)"><hp:t>-<hp:tab/.exec(s)[1];assert.equal(faceOf(h,dash),HG);
 const role=await generateDocument({...tpl(ILSONG,{enginePreset:'report'}),look:undefined},REPORT),rz=await JSZip.loadAsync(Buffer.from(role.hwpxBase64,'base64'));assert.ok(rz.file('version.xml'));
});
test('outline preparation follows HanMark: legal numbering nests sub-headings and keeps the report summary quote',()=>{
 const m=prepareGongmunMarkdown('# 제목\n\n## 장\n\n### 1. 절\n\n본문 문단입니다',{preset:'minutes',boldSubHeadings:true});
 assert.match(m.markdown,/^#### \*\*절\*\*$/m);assert.deepEqual(m.paragraphs,[{key:'본문문단입니다',depth:2}]);
 const r=prepareGongmunMarkdown('# 제목\n\n> **요약**하고자 함\n\n## 장',{preset:'report'});assert.match(r.markdown,/^> 요약하고자 함$/m);assert.deepEqual(r.chapters,['장']);
 assert.equal(markerClass('가.'),'legal1');assert.equal(markerClass('□'),'box0');assert.equal(markerClass('x'),null);
});
