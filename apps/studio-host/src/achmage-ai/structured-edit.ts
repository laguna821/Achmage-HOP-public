import type { WasmBridge } from '@/upstream/core';
import type { RhwpDocumentStateV1 } from '@/upstream/document-agent';

export interface StyledRun { text:string; fontFamily:string; fontSizePt:number; bold:boolean; spacingPercent:number }
export interface ParagraphFormat { alignment:'left'|'center'|'right'|'justify'; lineSpacingPercent:number }
export interface StyledParagraph { runs:StyledRun[]; paragraphFormat?:ParagraphFormat; table?:StyledParagraph[][] }
export interface StructuredPlan { schemaVersion:1|2; operation:'replace_paragraphs'; paragraphs:StyledParagraph[]; styles?:unknown; blocks?:unknown }
export function structuredParagraphs(plan:StructuredPlan):StyledParagraph[]{return plan.paragraphs.flatMap(p=>p.table?p.table.flat():[p]);}
export interface ParagraphRange { section:number; startParagraph:number; paragraphCount:number }
export interface ParagraphEvidence { text:string; paraFormat:unknown; charFormats:unknown[] }
export interface StructuredCapture {
  identity:RhwpDocumentStateV1; selection:string; range:ParagraphRange;
  beforeParagraphs:ParagraphEvidence[]; allParagraphs:ParagraphEvidence[]; controls:string;
  insertion?:{paragraph:number;charOffset:number;split:boolean;objects:{paragraph:number;controlIndex:number;kind:string;evidence:unknown}[]};
}
const fail=(message:string):never=>{throw new Error(message);};
/** The document holds objects (tables, fields, pictures) that paragraph-level structured editing cannot preserve. */
export class StructureUnsupportedError extends Error {}
const unsupported=(message:string):never=>{throw new StructureUnsupportedError(message);};
function wellFormed(text:string):boolean {
  for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}
  return true;
}
function object(value:unknown, keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))return fail('구조 편집 계획은 객체여야 합니다.');
  const o=value as Record<string,unknown>;
  if(Object.keys(o).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(o,k)))return fail('지원하지 않거나 빠진 구조 편집 속성이 있습니다.');
  return o;
}
export function parseStructuredPlan(value:unknown):StructuredPlan{
  if(value&&typeof value==='object'&&(value as {schemaVersion?:unknown}).schemaVersion===2)return parseV2(value);
  const p=object(value,['schemaVersion','operation','paragraphs']);
  if(p.schemaVersion!==1||p.operation!=='replace_paragraphs'||!Array.isArray(p.paragraphs)||!p.paragraphs.length||p.paragraphs.length>4000)fail('구조 편집 계획의 종류나 문단 수가 올바르지 않습니다.');
  let total=0,runs=0;
  const paragraphs=(p.paragraphs as unknown[]).map(value=>{
    const q=object(value,['runs']);
    if(!Array.isArray(q.runs)||!q.runs.length)fail('각 문단에 글자 서식 구간이 필요합니다.');
    const parsed=(q.runs as unknown[]).map(value=>{
      const r=object(value,['text','fontFamily','fontSizePt','bold','spacingPercent']);
      if(typeof r.text!=='string'||!r.text.length||/[\u0000-\u001f\u007f\u2028\u2029]/.test(r.text)||!wellFormed(r.text))fail('문단 본문에 빈 구간·제어 문자·잘못된 Unicode가 있습니다.');
      if(typeof r.fontFamily!=='string'||r.fontFamily!==r.fontFamily.trim()||!r.fontFamily.length||r.fontFamily.length>80||/[\u0000-\u001f"'<>;,\\]/.test(r.fontFamily))fail('글꼴 이름이 올바르지 않습니다.');
      if(typeof r.fontSizePt!=='number'||!Number.isFinite(r.fontSizePt)||r.fontSizePt<5||r.fontSizePt>72||!Number.isInteger(r.fontSizePt*100))fail('글자 크기는 5–72pt 범위의 0.01pt 단위여야 합니다.');
      if(typeof r.bold!=='boolean'||typeof r.spacingPercent!=='number'||!Number.isInteger(r.spacingPercent)||r.spacingPercent< -50||r.spacingPercent>50)fail('굵기 또는 자간 범위가 올바르지 않습니다.');
      total+=Array.from(r.text as string).length;runs++;
      return {...r} as unknown as StyledRun;
    });
    const text=parsed.map(r=>r.text).join('');
    if(typeof Intl.Segmenter!=='function')fail('안전한 Unicode 경계 검사를 지원하지 않는 환경입니다.');
    const boundaries=new Set([...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(text)].map(s=>s.index));
    boundaries.add(text.length);let offset=0;
    for(const r of parsed){offset+=r.text.length;if(!boundaries.has(offset))fail('글자 서식 경계가 결합 문자나 이모지를 나눕니다.');}
    return {runs:parsed};
  });
  if(total>MAX_PLAN_CHARS||runs>MAX_PLAN_RUNS)fail('구조 편집은 50만 자와 5만 개 서식 구간 이내로 제한됩니다.');
  return {schemaVersion:1,operation:'replace_paragraphs',paragraphs};
}
function parseV2(value:unknown):StructuredPlan{
  const raw=value as Record<string,unknown>,keys=['schemaVersion','operation','styles','blocks'];
  if(Object.hasOwn(raw,'paragraphs'))keys.push('paragraphs');
  const p=object(raw,keys);if(p.operation!=='replace_paragraphs')fail('지원하지 않는 편집 작업입니다.');
  if(!p.styles||typeof p.styles!=='object'||Array.isArray(p.styles))fail('styles가 필요합니다.');
  const styles=p.styles as Record<string,unknown>;
  if(!Object.keys(styles).length||Object.keys(styles).length>32||Object.keys(styles).some(k=>!/^[_a-zA-Z][\w-]{0,31}$/.test(k)))fail('스타일 ID 범위가 올바르지 않습니다.');
  for(const s of Object.values(styles)){object(s,['fontFamily','fontSizePt','bold','spacingPercent']);parseStructuredPlan({schemaVersion:1,operation:'replace_paragraphs',paragraphs:[{runs:[{...s as object,text:'x'}]}]});}
  const parseParagraph=(v:unknown):StyledParagraph=>{
    const q=object(v,['runs','paragraphFormat']);if(!Array.isArray(q.runs)||!q.runs.length)fail('문단 runs가 필요합니다.');
    const expanded=(q.runs as unknown[]).map(v=>{const r=object(v,['text','style']);if(typeof r.style!=='string'||!Object.hasOwn(styles,r.style))fail('없는 스타일 ID입니다.');return {...styles[r.style as string] as object,text:r.text};});
    const result=parseStructuredPlan({schemaVersion:1,operation:'replace_paragraphs',paragraphs:[{runs:expanded}]}).paragraphs[0];
    const f=object(q.paragraphFormat,['alignment','lineSpacingPercent']);
    if(!['left','center','right','justify'].includes(String(f.alignment))||!Number.isInteger(f.lineSpacingPercent)||Number(f.lineSpacingPercent)<50||Number(f.lineSpacingPercent)>500)fail('문단 정렬/줄간격 범위가 올바르지 않습니다.');
    return {...result,paragraphFormat:f as unknown as ParagraphFormat};
  };
  if(!Array.isArray(p.blocks)||!p.blocks.length||p.blocks.length>4000)fail('블록은 1–4,000개여야 합니다.');
  let cells=0;
  const paragraphs=(p.blocks as unknown[]).map(v=>{
    if(!v||typeof v!=='object')return fail('블록이 올바르지 않습니다.');
    if((v as {type?:unknown}).type==='paragraph'){const b=object(v,['type','runs','paragraphFormat']);return parseParagraph({runs:b.runs,paragraphFormat:b.paragraphFormat});}
    const b=object(v,['type','rows']);if(b.type!=='table'||!Array.isArray(b.rows)||!b.rows.length||b.rows.length>1000)fail('표 행 범위가 올바르지 않습니다.');
    const rows=(b.rows as unknown[]).map(row=>{if(!Array.isArray(row)||!row.length||row.length>50)fail('표 열 범위가 올바르지 않습니다.');cells+=(row as unknown[]).length;return (row as unknown[]).map(parseParagraph);});
    if(cells>20_000||rows.some(r=>r.length!==rows[0].length))fail('표는 직사각형이며 전체 2만 셀 이내여야 합니다.');
    return {runs:[],table:rows};
  });
  const plan:StructuredPlan={schemaVersion:2,operation:'replace_paragraphs',styles:p.styles,blocks:p.blocks,paragraphs};
  const all=structuredParagraphs(plan);if(all.reduce((n,p)=>n+p.runs.length,0)>MAX_PLAN_RUNS||all.reduce((n,p)=>n+Array.from(p.runs.map(r=>r.text).join('')).length,0)>MAX_PLAN_CHARS)fail('전체 편집 크기 제한을 넘었습니다.');
  if(Object.hasOwn(p,'paragraphs')&&!same(p.paragraphs,paragraphs))fail('정규화된 계획이 원래 블록과 다릅니다.');
  return plan;
}
export function paragraphEvidence(wasm:WasmBridge,section:number,paragraph:number):ParagraphEvidence{
  const length=wasm.getParagraphLength(section,paragraph);
  if(length>MAX_PARAGRAPH_CHARS)fail('안전한 편집 검증 범위를 넘는 문단입니다.');
  const text=length?wasm.getTextRange(section,paragraph,0,length):'';
  const charFormats=Array.from({length:Math.max(1,length)},(_,i)=>wasm.getCharPropertiesAt(section,paragraph,i));
  return {text,paraFormat:wasm.getParaPropertiesAt(section,paragraph),charFormats};
}
export function captureStructuredRange(wasm:WasmBridge,identity:RhwpDocumentStateV1,selection:string,range:ParagraphRange):StructuredCapture{
  if(wasm.getSectionCount()!==1||range.section!==0)fail('현재 구조 편집은 한 구역 본문만 지원합니다.');
  const count=wasm.getParagraphCount(0);
  if(!Number.isInteger(range.startParagraph)||!Number.isInteger(range.paragraphCount)||range.startParagraph<0||range.paragraphCount<1||range.startParagraph+range.paragraphCount>count||count>MAX_BODY_PARAGRAPHS)fail('명시한 문단 범위가 올바르지 않습니다.');
  const controls=wasm.getControls();
  if(controls.some(c=>c.list!==0||c.para!==0||!['secd','cold'].includes(c.ctrlId))||controls.length>2||new Set(controls.map(c=>c.ctrlId)).size!==controls.length)unsupported('표·필드·그림 등 개체가 있는 문서는 구조 편집을 지원하지 않습니다.');
  const allParagraphs:ParagraphEvidence[]=[];let total=0;
  for(let i=0;i<count;i++){
    if(wasm.getControlTextPositions(0,i).some(n=>n!==0))unsupported('문단 중간 개체는 보존을 확인할 수 없습니다.');
    const e=paragraphEvidence(wasm,0,i),scalarLength=Array.from(e.text).length;total+=scalarLength;
    if(total>MAX_CHECKED_CHARS)fail('안전한 문서 검증 범위 30만 자를 넘었습니다.');
    for(let j=0;j<=scalarLength;j++)if(wasm.getFieldInfoAt({sectionIndex:0,paragraphIndex:i,charOffset:j}).inField)unsupported('필드가 있는 문서는 구조 편집을 지원하지 않습니다.');
    allParagraphs.push(e);
  }
  return {identity:{...identity},selection,range:{...range},allParagraphs,beforeParagraphs:allParagraphs.slice(range.startParagraph,range.startParagraph+range.paragraphCount),controls:JSON.stringify(controls)};
}
function ok(raw:string):void{
  const value=JSON.parse(raw) as {ok?:boolean};
  if(value.ok!==true)fail('문서 엔진이 구조 편집을 거부했습니다.');
}
function same(a:unknown,b:unknown):boolean{return JSON.stringify(a)===JSON.stringify(b);}
/**
 * Edits read the whole body back to prove nothing else changed. These bound the cost of that check (every
 * character's formatting is compared), not the document: a long report with tables fits well inside them.
 */
const MAX_BODY_PARAGRAPHS=20_000,MAX_CHECKED_CHARS=300_000,MAX_PARAGRAPH_CHARS=200_000,MAX_PLAN_CHARS=500_000,MAX_PLAN_RUNS=50_000;
/** A picture's bytes as a short fingerprint for the before/after equality check (nothing adversarial here). */
function fingerprint(bytes:Uint8Array):string{let a=0x811c9dc5,b=0x9e3779b9;for(let i=0;i<bytes.length;i++){a=Math.imul(a^bytes[i],16777619);b=Math.imul(b^bytes[i],2246822507)^(b>>>13);}return `${bytes.length}:${(a>>>0).toString(16)}:${(b>>>0).toString(16)}`;}
function objectEvidence(wasm:WasmBridge,paragraph:number,controlIndex:number,kind:string):unknown{
  if(kind==='gso'){
    const handle=wasm.borrowDocumentHandle();if(!handle)fail('문서 엔진이 없습니다.');
    const bytes=handle!.getControlImageData(0,paragraph,'[]',controlIndex);if(bytes.length>64*1024*1024)fail('64MiB를 넘는 그림은 아직 삽입 보존 검증을 지원하지 않습니다.');
    return {properties:wasm.getPictureProperties(0,paragraph,controlIndex),bytes:fingerprint(bytes)};
  }
  const dimensions=wasm.getTableDimensions(0,paragraph,controlIndex);if(dimensions.cellCount>100_000)fail('기존 표가 보존 검증 범위를 넘었습니다.');
  let chars=0;
  const cells=Array.from({length:dimensions.cellCount},(_,cell)=>{
    const count=wasm.getCellParagraphCount(0,paragraph,controlIndex,cell);if(count>4096)fail('표 셀 문단이 너무 많습니다.');
    return {properties:wasm.getCellOwnProperties(0,paragraph,controlIndex,cell),paragraphs:Array.from({length:count},(_,p)=>{
      const args=[0,paragraph,controlIndex,cell,p] as const,length=wasm.getCellParagraphLength(...args);chars+=length;if(chars>MAX_CHECKED_CHARS)fail('기존 표 본문이 검증 범위를 넘었습니다.');
      return {text:wasm.getTextInCell(...args,0,length),para:wasm.getCellParaPropertiesAt(...args),chars:Array.from({length:Math.max(1,length)},(_,i)=>wasm.getCellCharPropertiesAt(...args,i))};
    })};
  });
  return {dimensions,properties:wasm.getTableProperties(0,paragraph,controlIndex),cells};
}
export function captureStructuredInsertion(wasm:WasmBridge,identity:RhwpDocumentStateV1,selection:string,paragraph:number,charOffset:number):StructuredCapture{
  if(wasm.getSectionCount()!==1)fail('새 구조 작성은 현재 한 구역 본문에서 지원합니다.');
  const count=wasm.getParagraphCount(0);if(count>MAX_BODY_PARAGRAPHS||!Number.isInteger(paragraph)||paragraph<0||paragraph>=count)fail('커서 문단을 확인하지 못했습니다.');
  const controls=wasm.getControls();if(controls.length>4096||controls.some(c=>c.list!==0||!['secd','cold','tbl','gso'].includes(c.ctrlId)||c.ctrlId==='gso'&&(c as typeof c & {userDesc?:string}).userDesc!=='그림'))fail('중첩 개체·필드 등 보존을 검증하지 못한 문서입니다.');
  const allParagraphs:ParagraphEvidence[]=[];let total=0;
  for(let i=0;i<count;i++){const e=paragraphEvidence(wasm,0,i),n=Array.from(e.text).length;total+=n;if(total>MAX_CHECKED_CHARS)fail('본문이 검증 범위를 넘었습니다.');for(let j=0;j<=n;j++)if(wasm.getFieldInfoAt({sectionIndex:0,paragraphIndex:i,charOffset:j}).inField)fail('필드가 있는 문서는 아직 삽입할 수 없습니다.');allParagraphs.push(e);}
  const target=allParagraphs[paragraph],scalars=Array.from(target.text);
  if(!Number.isInteger(charOffset)||charOffset<0||charOffset>scalars.length)fail('커서 문자 위치가 올바르지 않습니다.');
  const prefix=scalars.slice(0,charOffset).join(''),boundaries=new Set([...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(target.text)].map(s=>s.index));boundaries.add(target.text.length);
  if(!boundaries.has(prefix.length))fail('결합 문자 중간에는 삽입할 수 없습니다.');
  const split=charOffset<scalars.length;
  if(split&&controls.some(c=>c.para===paragraph&&!['secd','cold'].includes(c.ctrlId)))fail('개체가 있는 문단 중간은 나눌 수 없습니다. 개체 뒤 본문에 커서를 놓으세요.');
  const objects=controls.filter(c=>c.ctrlId==='tbl'||c.ctrlId==='gso').map(c=>({paragraph:c.para,controlIndex:c.controlIndex,kind:c.ctrlId,evidence:objectEvidence(wasm,c.para,c.controlIndex,c.ctrlId)}));
  return {identity:{...identity},selection,range:{section:0,startParagraph:paragraph+1,paragraphCount:0},beforeParagraphs:[target],allParagraphs,controls:JSON.stringify(controls),insertion:{paragraph,charOffset,split,objects}};
}
export function beginStructuredInsertion(wasm:WasmBridge,capture:StructuredCapture):number{
  const insertion=capture.insertion;if(!insertion)fail('삽입 위치가 없습니다.');const {paragraph,charOffset,split}=insertion!;
  if(split){
    ok(wasm.splitParagraph(0,paragraph,charOffset));
    const original=capture.allParagraphs[paragraph],left=paragraphEvidence(wasm,0,paragraph),right=paragraphEvidence(wasm,0,paragraph+1);
    if(left.text+right.text!==original.text||!same(left.paraFormat,original.paraFormat)||!same(right.paraFormat,original.paraFormat)||!same([...left.charFormats.slice(0,charOffset),...right.charFormats.slice(0,Array.from(right.text).length)],original.charFormats))fail('커서 양쪽 본문/서식 보존 검사가 실패했습니다.');
  }
  return paragraph+1;
}
export function verifyStructuredInsertion(wasm:WasmBridge,capture:StructuredCapture,addedParagraphs:number):void{
  const {paragraph,split,objects}=capture.insertion!;const delta=addedParagraphs+Number(split);
  if(wasm.getParagraphCount(0)!==capture.allParagraphs.length+delta)fail('삽입 후 문단 수가 다릅니다.');
  const oldControls=(JSON.parse(capture.controls) as ReturnType<WasmBridge['getControls']>).map(c=>({...c,para:c.para>paragraph?c.para+delta:c.para}));
  const retained=wasm.getControls().filter(c=>c.list===0&&(c.para<=paragraph||c.para>paragraph+addedParagraphs));
  if(!same(oldControls,retained))fail('기존 구역/개체 제어가 바뀌었습니다.');
  for(let i=0;i<capture.allParagraphs.length;i++){
    if(split&&i===paragraph)continue;const mapped=i<=paragraph?i:i+delta;
    if(!same(paragraphEvidence(wasm,0,mapped),capture.allParagraphs[i]))fail('기존 본문/서식이 바뀌어 삽입을 취소했습니다.');
  }
  for(const o of objects){const mapped=o.paragraph<=paragraph?o.paragraph:o.paragraph+delta;if(!same(objectEvidence(wasm,mapped,o.controlIndex,o.kind),o.evidence))fail('기존 표/그림 보존 검사가 실패했습니다.');}
}
export function executeStructuredInsertion(wasm:WasmBridge,capture:StructuredCapture,plan:StructuredPlan):void{
  const index=beginStructuredInsertion(wasm,capture),handle=wasm.borrowDocumentHandle();if(!handle)fail('문서 엔진이 없습니다.');ok(handle!.insertParagraph(0,index));
  const allParagraphs=Array.from({length:wasm.getParagraphCount(0)},(_,p)=>paragraphEvidence(wasm,0,p));
  const synthetic:StructuredCapture={identity:capture.identity,selection:capture.selection,range:{section:0,startParagraph:index,paragraphCount:1},allParagraphs,beforeParagraphs:[allParagraphs[index]],controls:JSON.stringify(wasm.getControls())};
  executeStructuredPlan(wasm,synthetic,plan);verifyStructuredInsertion(wasm,capture,plan.paragraphs.length);
}
export function executeStructuredPlan(wasm:WasmBridge,capture:StructuredCapture,plan:StructuredPlan):void{
  const {section,startParagraph:start,paragraphCount:count}=capture.range;
  // Caller owns a shared SnapshotCommand; every operation below is inside it.
  for(let i=start+count-1;i>=start;i--){const length=wasm.getParagraphLength(section,i);if(length)ok(wasm.deleteText(section,i,0,length));}
  for(let i=1;i<count;i++)ok(wasm.mergeParagraph(section,start+1));
  const fontIds=new Map<string,number[]>();
  const mods=(r:StyledRun)=>{let ids=fontIds.get(r.fontFamily);if(!ids){ids=Array.from({length:7},(_,lang)=>wasm.findOrCreateFontIdForLang(lang,r.fontFamily));fontIds.set(r.fontFamily,ids);}return JSON.stringify({fontIds:ids,fontSize:Math.round(r.fontSizePt*100),bold:r.bold,spacings:Array(7).fill(r.spacingPercent)});};
  const paraMods=(f:ParagraphFormat)=>JSON.stringify({alignment:f.alignment,lineSpacing:f.lineSpacingPercent,lineSpacingType:'Percent'});
  for(let i=0;i<plan.paragraphs.length;i++){
    const index=start+i,p=plan.paragraphs[i],text=p.runs.map(r=>r.text).join('');
    if(i)ok(wasm.splitParagraph(section,index-1,wasm.getParagraphLength(section,index-1)));
    if(text)ok(wasm.insertText(section,index,0,text));let offset=0;
    for(const r of p.runs){
      const end=offset+Array.from(r.text).length;
      ok(wasm.applyCharFormat(section,index,offset,end,mods(r)));
      offset=end;
    }
    if(p.paragraphFormat)ok(wasm.applyParaFormat(section,index,paraMods(p.paragraphFormat)));
  }
  const checkPara=(actual:ReturnType<WasmBridge['getParaPropertiesAt']>,f:ParagraphFormat)=>{if(actual.alignment!==f.alignment||actual.lineSpacing!==f.lineSpacingPercent||actual.lineSpacingType!=='Percent')fail('문단 정렬/줄간격 적용 검사가 실패했습니다.');};
  const checkChar=(actual:ReturnType<WasmBridge['getCharPropertiesAt']>,r:StyledRun)=>{if(actual.fontSize!==Math.round(r.fontSizePt*100)||actual.bold!==r.bold||!Array.isArray(actual.spacings)||actual.spacings.length!==7||actual.spacings.some(v=>v!==r.spacingPercent)||!Array.isArray(actual.fontFamilies)||actual.fontFamilies.length!==7||actual.fontFamilies.some(v=>v!==r.fontFamily))fail('글꼴·크기·굵기·자간 적용 검사가 실패했습니다.');};
  const tables=new Map<number,number>();
  // All body paragraph slots exist before creating objects, so splitParagraph never copies a table.
  for(let i=0;i<plan.paragraphs.length;i++){
    const rows=plan.paragraphs[i].table;if(!rows)continue;const index=start+i;
    const result=wasm.createTable(section,index,0,rows.length,rows[0].length);
    if(!result.ok||result.paraIdx!==index)fail('표 삽입 위치 검사가 실패했습니다.');
    // createTable adds a fresh empty following paragraph. Remove only that verified
    // new slot, inside this same SnapshotCommand; never merge it into an old neighbor.
    if(wasm.getParagraphLength(section,index+1)!==0||wasm.getControlTextPositions(section,index+1).length!==0)fail('표 엔진의 새 빈 문단이 예상과 다릅니다.');
    const handle=wasm.borrowDocumentHandle();if(!handle)fail('문서 엔진이 없습니다.');ok(handle!.deleteParagraph(section,index+1));
    tables.set(index,result.controlIdx);
    const dims=wasm.getTableDimensions(section,index,result.controlIdx);
    if(dims.rowCount!==rows.length||dims.colCount!==rows[0].length)fail('표 행/열 검사가 실패했습니다.');
    for(let row=0;row<rows.length;row++)for(let col=0;col<rows[row].length;col++){
      const cell=row*rows[0].length+col,p=rows[row][col],args=[section,index,result.controlIdx,cell,0] as const,text=p.runs.map(r=>r.text).join('');
      ok(wasm.insertTextInCell(...args,0,text));let offset=0;
      for(const r of p.runs){const end=offset+Array.from(r.text).length;ok(wasm.applyCharFormatInCell(...args,offset,end,mods(r)));offset=end;}
      ok(wasm.applyParaFormatInCell(...args,paraMods(p.paragraphFormat!)));
      if(wasm.getCellParagraphCount(section,index,result.controlIdx,cell)!==1||wasm.getTextInCell(...args,0,wasm.getCellParagraphLength(...args))!==text)fail('표 셀 본문 검사가 실패했습니다.');
      checkPara(wasm.getCellParaPropertiesAt(...args),p.paragraphFormat!);offset=0;
      for(const r of p.runs)for(const _ of Array.from(r.text))checkChar(wasm.getCellCharPropertiesAt(...args,offset++),r);
    }
  }
  const controls=wasm.getControls(),retained=controls.filter(c=>!(c.ctrlId==='tbl'&&c.list===0&&tables.get(c.para)===c.controlIndex));
  const expectedControls=(JSON.parse(capture.controls) as ReturnType<WasmBridge['getControls']>).map(c=>({...c,para:c.list===0&&c.para>=start+count?c.para-count+plan.paragraphs.length:c.para}));
  if(wasm.getParagraphCount(section)!==capture.allParagraphs.length-count+plan.paragraphs.length||!same(retained,expectedControls)||controls.length-retained.length!==tables.size)fail('문단 수 또는 구역/단 설정 보존 검사가 실패했습니다.');
  for(let i=0;i<plan.paragraphs.length;i++){
    const index=start+i,p=plan.paragraphs[i],expected=p.runs.map(r=>r.text).join('');
    if(p.table)continue;
    if(wasm.getTextRange(section,index,0,wasm.getParagraphLength(section,index))!==expected)fail('구조 편집 후 본문이 계획과 다릅니다.');
    if(p.paragraphFormat)checkPara(wasm.getParaPropertiesAt(section,index),p.paragraphFormat);
    else if(!same(wasm.getParaPropertiesAt(section,index),capture.beforeParagraphs[0].paraFormat))fail('문단 속성 보존 검사가 실패했습니다.');
    let offset=0;for(const r of p.runs)for(const _ of Array.from(r.text)){
      checkChar(wasm.getCharPropertiesAt(section,index,offset++),r);
    }
  }
  for(let i=0;i<capture.allParagraphs.length;i++){
    if(i>=start&&i<start+count)continue;
    const index=i<start?i:i-count+plan.paragraphs.length;
    if(!same(paragraphEvidence(wasm,section,index),capture.allParagraphs[i]))fail('선택 범위 밖 본문/서식이 바뀌어 전체 편집을 취소했습니다.');
  }
}
/** A bounded reuse parser for the user's already-generated annotated draft.
 * No aliases, Markdown interpretation, CSS, HTML or evaluation. */
export function parseAnnotatedDraft(text:string):StructuredPlan{
  if(text.length>MAX_PLAN_CHARS)fail('주석 초안이 너무 큽니다.');
  const source=text.trim().replace(/^\x60\x60\x60(?:text|plaintext)?\s*\n([\s\S]*?)\n\x60\x60\x60$/,'$1');
  const lines=source.split(/\r?\n/);const paragraphs:StructuredPlan['paragraphs']=[];
  const header=/^\[(?:[^|\]\n]+\s*\|\s*)?([^,\]\n]+),\s*(\d+(?:\.\d{1,2})?)\s*pt,\s*(굵게|보통),\s*자간\s*([+-]?\d+)\s*%\]$/;
  for(let i=0;i<lines.length;){
    if(!lines[i].trim()){i++;continue;}
    const m=header.exec(lines[i++].trim());if(!m)fail('주석 초안의 서식 머리글을 해석할 수 없습니다.');
    const parts:string[]=[];while(i<lines.length&&!lines[i].trim().startsWith('[')){if(lines[i].trim())parts.push(lines[i]);i++;}
    if(parts.length!==1)fail('서식 머리글 뒤에는 한 문단을 한 줄로 적어 주세요.');
    paragraphs.push({runs:[{text:parts[0],fontFamily:m![1].trim(),fontSizePt:Number(m![2]),bold:m![3]==='굵게',spacingPercent:Number(m![4])}]});
  }
  return parseStructuredPlan({schemaVersion:1,operation:'replace_paragraphs',paragraphs});
}
