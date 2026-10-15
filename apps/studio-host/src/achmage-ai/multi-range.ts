import type { WasmBridge } from '@/upstream/core';
import type { RhwpDocumentStateV1 } from '@/upstream/document-agent';
import { diffText, MarkerMismatch, type Hunk } from './minimal-diff';

type Position = { sectionIndex:number; paragraphIndex:number; charOffset:number };
type Run = { startOffset:number; endOffset:number; charShapeId:number };
type Paragraph = { text:string; runs:Run[]; format:string };
type Control = { ctrlId:string; list:number; para:number; controlIndex:number };
/** An object inside the selection: shown to the model as a fixed marker, never edited. */
export interface SelectedObject { paragraph:number; offset:number; marker:string; ctrlId:string }
/** An object in an edge paragraph but outside the selection: it must stay put. */
export interface EdgeObject { paragraph:number; offset:number; ctrlId:string }
export interface MultiRange { identity:RhwpDocumentStateV1; start:Position; end:Position; paragraphs:Paragraph[]; controls:string; count:number; before:string; objects:SelectedObject[]; edges:EdgeObject[]; cell?:CellRef }
const fail = (message:string):never => { throw Error(message); };
function handle(w:WasmBridge) { return w.borrowDocumentHandle() ?? fail('문서를 먼저 여세요.'); }
function ok(raw:string):Record<string,unknown> { const r=JSON.parse(raw); if(r.ok!==true)fail('문단 편집 결과를 확인하지 못했습니다.'); return r; }
function paragraph(w:WasmBridge,s:number,p:number):Paragraph {
  const d=handle(w),n=d.getParagraphLength(s,p),text=n?d.getTextRange(s,p,0,n):'';
  if(Array.from(text).length!==n)fail('본문 문자 위치를 확인하지 못했습니다.');
  return {text,runs:n?JSON.parse(d.getCharShapeRuns(s,p,0,n)):[],format:d.getParaPropertiesAt(s,p)};
}
function boundary(text:string,offset:number):void {
  const a=Array.from(text);if(!Number.isSafeInteger(offset)||offset<0||offset>a.length)fail('올바른 본문 선택 영역이 아닙니다.');
  const utf16=a.slice(0,offset).join('').length;
  if(typeof Intl.Segmenter!=='function'||utf16!==text.length&&![...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(text)].some(x=>x.index===utf16))fail('결합 문자나 이모지 중간에서는 나눌 수 없습니다.');
}
/** Section setup lives on the first paragraph and is not part of the text. */
const SECTION = new Set(['secd','cold']);
const KIND: Record<string,string> = { tbl:'표', gso:'그림', eqed:'수식' };
const globalBase=(w:WasmBridge,s:number)=>{let base=0;for(let i=0;i<s;i++)base+=w.getParagraphCount(i);return base;};

export function captureMultiRange(w:WasmBridge,identity:RhwpDocumentStateV1,a:Position,b:Position):MultiRange {
  let start={...a},end={...b};if(start.sectionIndex!==end.sectionIndex)fail('같은 구역의 본문을 선택하세요.');
  if(start.paragraphIndex>end.paragraphIndex||start.paragraphIndex===end.paragraphIndex&&start.charOffset>end.charOffset)[start,end]=[end,start];
  const s=start.sectionIndex,count=w.getParagraphCount(s);
  if(!Number.isSafeInteger(start.paragraphIndex)||!Number.isSafeInteger(end.paragraphIndex)||start.paragraphIndex<0||end.paragraphIndex>=count)fail('올바른 본문 선택 영역이 아닙니다.');
  if(end.paragraphIndex-start.paragraphIndex>63)fail('한 번에 64개 이내의 본문 문단을 선택하세요.');
  // Everything outside the selection is read back after the edit; these bounds keep that check affordable.
  if(count>4000)fail(`이 구역은 문단이 ${count}개라 선택 편집 뒤 전체 확인을 할 수 없습니다(4,000개까지).`);
  const paragraphs=Array.from({length:count},(_,p)=>paragraph(w,s,p));
  if(paragraphs.reduce((n,p)=>n+Array.from(p.text).length,0)>1_000_000)fail('이 구역의 글이 너무 길어 선택 편집 뒤 전체 확인을 할 수 없습니다.');
  // A selection ending at the next paragraph's start (Shift+Down, drag to a line start) or starting at a paragraph's end
  // covers only a paragraph break there. Keep that break outside so unselected neighbours never merge or split.
  const controls=w.getControls() as Control[],base=globalBase(w,s);
  const len=(p:number)=>Array.from(paragraphs[p].text).length,plain=(p:number)=>!controls.some(c=>c.list===0&&c.para===base+p&&!SECTION.has(c.ctrlId));
  while(end.paragraphIndex>start.paragraphIndex&&end.charOffset===0&&plain(end.paragraphIndex))end={...end,paragraphIndex:end.paragraphIndex-1,charOffset:len(end.paragraphIndex-1)};
  while(start.paragraphIndex<end.paragraphIndex&&start.charOffset===len(start.paragraphIndex)&&plain(start.paragraphIndex))start={...start,paragraphIndex:start.paragraphIndex+1,charOffset:0};
  boundary(paragraphs[start.paragraphIndex].text,start.charOffset);boundary(paragraphs[end.paragraphIndex].text,end.charOffset);
  // Objects (tables, pictures, shapes, page-number controls) stay where they are; the model sees a marker in their place.
  const objects:SelectedObject[]=[],edges:EdgeObject[]=[],numbers=new Map<string,number>(),parts:string[]=[];
  for(let p=start.paragraphIndex;p<=end.paragraphIndex;p++){
    const local=controls.filter(c=>c.list===0&&c.para===base+p),positions=w.getControlTextPositions(s,p);
    if(local.length!==positions.length)fail('선택한 문단의 개체 위치를 확인하지 못했습니다.');
    const chars=Array.from(paragraphs[p].text),lo=p===start.paragraphIndex?start.charOffset:0,hi=p===end.paragraphIndex?end.charOffset:chars.length;
    const placed=local.filter(c=>!SECTION.has(c.ctrlId)).map(c=>({c,offset:positions[c.controlIndex]})).sort((x,y)=>x.offset-y.offset||x.c.controlIndex-y.c.controlIndex);
    for(const x of placed)if(x.offset<lo||x.offset>hi)edges.push({paragraph:p,offset:x.offset,ctrlId:x.c.ctrlId});
    const objectsAt=(o:number)=>placed.filter(x=>x.offset===o).map(x=>{const kind=KIND[x.c.ctrlId]??'개체',n=(numbers.get(kind)??0)+1;numbers.set(kind,n);const marker=`⟦${kind}${n}⟧`;objects.push({paragraph:p,offset:o,marker,ctrlId:x.c.ctrlId});return marker;}).join('');
    let line='';for(let o=lo;o<=hi;o++){line+=objectsAt(o);if(o<hi)line+=chars[o];}
    parts.push(line);
    for(let i=lo;i<=hi;i++)if(w.getFieldInfoAt({sectionIndex:s,paragraphIndex:p,charOffset:i}).inField)fail('필드를 포함한 선택 영역은 아직 지원하지 않습니다.');
  }
  const before=parts.join('\n');
  if(!before.length)fail('수정할 본문을 먼저 선택하세요.');
  if(objects.length&&!before.replace(/⟦[^⟧]*⟧|\n/gu,'').trim())fail('선택 안에 바꿀 글이 없습니다. 표 안의 글은 셀을 선택해 고치세요.');
  return {identity,start,end,paragraphs,controls:JSON.stringify(controls),count,before,objects,edges};
}
/**
 * A model's leading or trailing blank lines are not paragraphs. Breaks the captured text itself starts
 * or ends with (empty paragraphs kept at the selection's edges) are restored exactly, so an unchanged
 * reply is unchanged and those paragraphs are never merged away.
 */
export function normalizeMultiReplacement(replacement:string,before=''):string{
  if(typeof replacement!=='string')return replacement;
  const core=replacement.replace(/\r\n/g,'\n').replace(/^\n+|\n+$/g,'');
  if(!/[^\n]/u.test(before))return core;
  return /^\n*/u.exec(before)![0]+core+/\n*$/u.exec(before)![0];
}

/** One position in the selected text: a character, a paragraph break or an object marker. */
type Unit = { kind:'char'; ch:string; p:number; o:number; id:number } | { kind:'break'; p:number } | { kind:'object'; p:number; o:number; object:SelectedObject };
/** Expected content of one paragraph after the edit; `format` names the original paragraph whose shape it keeps. */
interface Planned { chars:{ch:string;id:number}[]; objects:{ctrlId:string;offset:number}[]; format:number }
interface Edit { a:number; b:number; text:string }

function idsOf(p:Paragraph):number[]{const out:number[]=[];for(const r of p.runs)for(let i=r.startOffset;i<r.endOffset;i++)out[i]=r.charShapeId;return out;}
function runsOf(ids:readonly number[]):Run[]{const out:Run[]=[];ids.forEach((id,i)=>{const last=out.at(-1);if(last?.charShapeId===id)last.endOffset=i+1;else out.push({startOffset:i,endOffset:i+1,charShapeId:id});});return out;}

function unitsOf(c:MultiRange):Unit[]{
  const units:Unit[]=[],first=c.start.paragraphIndex,last=c.end.paragraphIndex;
  for(let p=first;p<=last;p++){
    const chars=Array.from(c.paragraphs[p].text),ids=idsOf(c.paragraphs[p]),lo=p===first?c.start.charOffset:0,hi=p===last?c.end.charOffset:chars.length;
    for(let o=lo;o<=hi;o++){
      for(const object of c.objects.filter(x=>x.paragraph===p&&x.offset===o))units.push({kind:'object',p,o,object});
      if(o<hi)units.push({kind:'char',ch:chars[o],p,o,id:ids[o]});
    }
    if(p<last)units.push({kind:'break',p});
  }
  return units;
}

/** Edits in unit indices. A new paragraph written just before a break is moved after it ("\nX" → "X\n"), where it means the same. */
function editsOf(c:MultiRange,units:readonly Unit[],replacement:string):Edit[]{
  let hunks:Hunk[];
  try{hunks=diffText(c.before,replacement);}catch(error){if(error instanceof MarkerMismatch)fail(error.message);throw error;}
  const unitAt=new Map<number,number>();{let at=0;units.forEach((u,i)=>{unitAt.set(at,i);at+=u.kind==='object'?Array.from(u.object.marker).length:1;});unitAt.set(at,units.length);}
  const edits=hunks.map(h=>{const a=unitAt.get(h.start),b=unitAt.get(h.end);if(a===undefined||b===undefined)fail('편집 위치를 확인하지 못했습니다.');return {a:a!,b:b!,text:h.text};}).sort((x,y)=>x.a-y.a);
  if(edits.some(e=>units.slice(e.a,e.b).some(u=>u.kind==='object')))fail('표·그림 같은 개체는 바꿀 수 없습니다.');
  edits.forEach((e,i)=>{
    while(e.a===e.b&&e.text.startsWith('\n')&&units[e.a]?.kind==='break'&&(edits[i+1]?.a??Infinity)>e.a+1){e.a++;e.b++;e.text=e.text.slice(1)+'\n';}
  });
  return edits;
}

/**
 * Shapes of the paragraphs an edit's line breaks create. When an edit rewrites k paragraph breaks
 * into j, the last min(j, k) new paragraphs take, in order, the shapes of the last paragraphs it
 * merged away (a rewritten closing line keeps its own shape); the rest take the shape of the
 * paragraph they are written in (undefined). This never depends on where the selection ends.
 */
function newParagraphFormats(units:readonly Unit[],e:Edit):(number|undefined)[]{
  const merged=units.slice(e.a,e.b).flatMap(u=>u.kind==='break'?[u.p+1]:[]),lines=e.text.split('\n').length-1;
  return Array.from({length:lines},(_,t)=>{const i=t-(lines-merged.length);return i>=0?merged[i]:undefined;});
}

/** Where the edited paragraphs live: the body of a section, or the paragraphs of one table cell. */
interface Surface {
  count():number;
  read(p:number):Paragraph;
  length(p:number):number;
  charAt(p:number,o:number):string;
  defaultId(p:number):number;
  insert(p:number,o:number,text:string):void;
  remove(p:number,o:number,n:number):void;
  split(p:number,o:number,meta?:unknown):void;
  /** Joins paragraph p onto p - 1 and returns p's own settings. */
  merge(p:number):unknown;
  setRuns(p:number,runs:readonly Run[]):void;
}
function bodySurface(w:WasmBridge,s:number):Surface{
  const d=handle(w);
  return {
    count:()=>w.getParagraphCount(s),read:p=>paragraph(w,s,p),length:p=>d.getParagraphLength(s,p),charAt:(p,o)=>d.getTextRange(s,p,o,1),
    defaultId:p=>{const id=JSON.parse(d.getCharPropertiesAt(s,p,0)).charShapeId;if(!Number.isInteger(id))fail('삽입 위치의 글자 서식을 확인하지 못했습니다.');return id;},
    insert:(p,o,text)=>{ok(d.insertText(s,p,o,text));},remove:(p,o,n)=>{ok(d.deleteText(s,p,o,n));},
    split:(p,o,meta)=>{ok(d.splitParagraph(s,p,o,meta===undefined?undefined:JSON.stringify(meta)));},
    merge:p=>{const r=ok(d.mergeParagraph(s,p));if(!r.removedParaMeta)fail('문단 설정을 보존할 수 없습니다.');return r.removedParaMeta;},
    setRuns:(p,runs)=>{ok(d.setCharShapeRuns(s,p,0,runs.at(-1)?.endOffset??0,JSON.stringify(runs)));},
  };
}
/** A table cell in the body (not nested): parent paragraph, control index and cell index. */
export interface CellRef { parent:number; control:number; cell:number }
function cellParagraph(w:WasmBridge,s:number,c:CellRef,p:number):Paragraph{
  const d=handle(w),n=d.getCellParagraphLength(s,c.parent,c.control,c.cell,p),text=n?d.getTextInCell(s,c.parent,c.control,c.cell,p,0,n):'';
  if(Array.from(text).length!==n)fail('셀 글자 위치를 확인하지 못했습니다.');
  const path=JSON.stringify([{controlIndex:c.control,cellIndex:c.cell,cellParaIndex:p}]);
  return {text,runs:n?JSON.parse(d.getCharShapeRunsInCellByPath(s,c.parent,path,0,n)):[],format:d.getCellParaPropertiesAt(s,c.parent,c.control,c.cell,p)};
}
function cellSurface(w:WasmBridge,s:number,c:CellRef):Surface{
  const d=handle(w),path=(p:number)=>JSON.stringify([{controlIndex:c.control,cellIndex:c.cell,cellParaIndex:p}]);
  return {
    count:()=>d.getCellParagraphCount(s,c.parent,c.control,c.cell),read:p=>cellParagraph(w,s,c,p),length:p=>d.getCellParagraphLength(s,c.parent,c.control,c.cell,p),
    charAt:(p,o)=>d.getTextInCell(s,c.parent,c.control,c.cell,p,o,1),
    defaultId:p=>{const id=JSON.parse(d.getCellCharPropertiesAt(s,c.parent,c.control,c.cell,p,0)).charShapeId;if(!Number.isInteger(id))fail('셀 글자 서식을 확인하지 못했습니다.');return id;},
    insert:(p,o,text)=>{ok(d.insertTextInCell(s,c.parent,c.control,c.cell,p,o,text));},remove:(p,o,n)=>{ok(d.deleteTextInCell(s,c.parent,c.control,c.cell,p,o,n));},
    split:(p,o,meta)=>{ok(d.splitParagraphInCell(s,c.parent,c.control,c.cell,p,o,meta===undefined?undefined:JSON.stringify(meta)));},
    merge:p=>{const r=ok(d.mergeParagraphInCell(s,c.parent,c.control,c.cell,p));if(!r.removedParaMeta)fail('셀 문단 설정을 보존할 수 없습니다.');return r.removedParaMeta;},
    setRuns:(p,runs)=>{ok(d.setCharShapeRunsInCellByPath(s,c.parent,path(p),0,runs.at(-1)?.endOffset??0,JSON.stringify(runs)));},
  };
}

/**
 * A selection inside one table cell (not a nested table). Objects inside a cell are not shown; an
 * edit that would move one is caught by the read-back and rolled back.
 */
export function captureCellRange(w:WasmBridge,identity:RhwpDocumentStateV1,cell:CellRef&{section:number},a:{paragraph:number;offset:number},b:{paragraph:number;offset:number}):MultiRange{
  const s=cell.section,d=handle(w);let [x,y]=a.paragraph<b.paragraph||a.paragraph===b.paragraph&&a.offset<=b.offset?[a,b]:[b,a];
  const dims=JSON.parse(d.getTableDimensions(s,cell.parent,cell.control)) as {cellCount:number};
  if(!Number.isSafeInteger(cell.cell)||cell.cell<0||cell.cell>=dims.cellCount)fail('표 셀을 확인하지 못했습니다.');
  const count=d.getCellParagraphCount(s,cell.parent,cell.control,cell.cell);
  if(x.paragraph<0||y.paragraph>=count||count>256||y.paragraph-x.paragraph>63)fail('셀 안에서 64개 이내의 문단을 선택하세요.');
  const paragraphs=Array.from({length:count},(_,p)=>cellParagraph(w,s,cell,p));
  if(paragraphs.reduce((n,p)=>n+Array.from(p.text).length,0)>32000)fail('셀 글이 너무 깁니다.');
  const len=(p:number)=>Array.from(paragraphs[p].text).length;
  if(y.paragraph>x.paragraph&&y.offset===0)y={paragraph:y.paragraph-1,offset:len(y.paragraph-1)};
  if(x.paragraph<y.paragraph&&x.offset===len(x.paragraph))x={paragraph:x.paragraph+1,offset:0};
  boundary(paragraphs[x.paragraph].text,x.offset);boundary(paragraphs[y.paragraph].text,y.offset);
  for(let p=x.paragraph;p<=y.paragraph;p++)for(let i=p===x.paragraph?x.offset:0;i<=(p===y.paragraph?y.offset:len(p));i++)
    if(JSON.parse(d.getFieldInfoAtInCell(s,cell.parent,cell.control,cell.cell,p,i,false)).inField)fail('필드를 포함한 셀 선택은 아직 지원하지 않습니다.');
  const before=paragraphs.slice(x.paragraph,y.paragraph+1).map((p,i,all)=>Array.from(p.text).slice(i===0?x.offset:0,i===all.length-1?y.offset:undefined).join('')).join('\n');
  if(!before.length)fail('수정할 셀 글을 먼저 선택하세요.');
  if(/⟦[^⟦⟧\n]{1,12}⟧/u.test(before))fail('셀 글에 개체 표시와 같은 ⟦ ⟧ 문자가 있어 고칠 수 없습니다.');
  return {identity,start:{sectionIndex:s,paragraphIndex:x.paragraph,charOffset:x.offset},end:{sectionIndex:s,paragraphIndex:y.paragraph,charOffset:y.offset},paragraphs,controls:JSON.stringify(w.getControls()),count,before,objects:[],edges:[],cell:{parent:cell.parent,control:cell.control,cell:cell.cell}};
}

/**
 * Applies the model's revision as a minimal edit: unchanged characters keep their exact character
 * shape (bold, colour, font, highlight), objects keep their place between their neighbours, and
 * paragraph shapes follow one rule — a kept paragraph keeps its shape, a merged paragraph keeps the
 * first one's, and a new paragraph takes the shape of the paragraph it is written in. LF makes a paragraph.
 */
export function executeMultiRange(w:WasmBridge,c:MultiRange,raw:string):Position&Partial<{parentParaIndex:number;controlIndex:number;cellIndex:number;cellParaIndex:number}> {
  const replacement=normalizeMultiReplacement(raw,c.before);
  if(typeof replacement!=='string'||Array.from(replacement).length>32000||replacement.split('\n').length>64||/[\u0000-\u0008\u000b-\u001f\u007f]/.test(replacement)||/[\uD800-\uDFFF]/u.test(replacement))fail('응답은 올바른 유니코드와 줄바꿈을 포함해 32,000자 이내여야 합니다.');
  const s=c.start.sectionIndex,first=c.start.paragraphIndex,last=c.end.paragraphIndex,surface=c.cell?cellSurface(w,s,c.cell):bodySurface(w,s);
  const units=unitsOf(c),edits=editsOf(c,units,replacement);
  // New text takes the shape of what it replaces, else its left neighbour in the paragraph, else its right one.
  const styleFor=(e:Edit)=>{
    const replaced=units.slice(e.a,e.b).find(u=>u.kind==='char');if(replaced?.kind==='char')return replaced.id;
    const left=units[e.a-1],right=units[e.b];
    if(left?.kind==='char')return left.id;if(right?.kind==='char')return right.id;
    return surface.defaultId(right&&right.kind!=='break'?right.p:left?.p??last);
  };

  // 1) The planned result, paragraph by paragraph, including the unselected head and tail of the edge paragraphs.
  const chars=(p:number)=>Array.from(c.paragraphs[p].text),firstIds=idsOf(c.paragraphs[first]),lastIds=idsOf(c.paragraphs[last]);
  const planned:Planned[]=[{chars:chars(first).slice(0,c.start.charOffset).map((ch,i)=>({ch,id:firstIds[i]})),objects:c.edges.filter(x=>x.paragraph===first&&x.offset<c.start.charOffset).map(x=>({ctrlId:x.ctrlId,offset:x.offset})),format:first}];
  const push=(u:Unit|{kind:'insert';ch:string;id:number}|{kind:'newline';format?:number})=>{
    const cur=planned.at(-1)!;
    if(u.kind==='char'||u.kind==='insert')cur.chars.push({ch:u.ch,id:u.id});
    else if(u.kind==='object')cur.objects.push({ctrlId:u.object.ctrlId,offset:cur.chars.length});
    else planned.push({chars:[],objects:[],format:u.kind==='break'?u.p+1:u.format??cur.format});
  };
  let at=0;
  for(const e of edits){
    for(;at<e.a;at++)push(units[at]);
    const id=styleFor(e),formats=newParagraphFormats(units,e);let line=0;
    for(const ch of Array.from(e.text))push(ch==='\n'?{kind:'newline',format:formats[line++]}:{kind:'insert',ch,id});
    at=e.b;
  }
  for(;at<units.length;at++)push(units[at]);
  {const cur=planned.at(-1)!,start=cur.chars.length;chars(last).slice(c.end.charOffset).forEach((ch,i)=>cur.chars.push({ch,id:lastIds[c.end.charOffset+i]}));
   for(const x of c.edges.filter(x=>x.paragraph===last&&x.offset>c.end.charOffset))cur.objects.push({ctrlId:x.ctrlId,offset:start+x.offset-c.end.charOffset});}
  if(planned.length>64)fail('응답의 문단이 너무 많습니다.');

  // 2) The edits, last first so earlier positions stay valid. rhwp puts text inserted at an object's
  //    offset in front of the object, so new text goes in at the end of what it replaces and the old
  //    text is removed after; a pure insertion right after an object rewrites the next character with it.
  const posOf=(u:number)=>{const x=units[u];if(!x)return {p:last,o:c.end.charOffset};if(x.kind==='break')return {p:x.p,o:chars(x.p).length};return {p:x.p,o:x.o};};
  const write=(p:number,o:number,text:string,metas:readonly unknown[]=[])=>{
    text.split('\n').forEach((chunk,i)=>{if(i){surface.split(p,o,metas[i-1]);p++;o=0;}if(chunk){surface.insert(p,o,chunk);o+=Array.from(chunk).length;}});
  };
  for(const e of [...edits].reverse()){
    const from=posOf(e.a);let to=posOf(e.b),text=e.text;
    const object=units[e.a-1]?.kind==='object'&&units[e.a-1].p===from.p&&(units[e.a-1] as {o:number}).o===from.o;
    if(object&&e.a===e.b&&text){
      const next=units[e.b];if(next?.kind!=='char')fail('표·그림 바로 뒤의 문단 끝에는 아직 글을 넣지 못합니다. 앞에 넣도록 다시 요청해 주세요.');
      to={p:from.p,o:from.o+1};text+=(next as {ch:string}).ch;
    }
    if(from.p===to.p){
      write(to.p,to.o,text);
      if(to.o>from.o)surface.remove(from.p,from.o,to.o-from.o);
      continue;
    }
    const tail=surface.length(from.p)-from.o;if(tail>0)surface.remove(from.p,from.o,tail);
    if(to.o>0)surface.remove(to.p,0,to.o);
    for(let p=to.p-1;p>from.p;p--){const n=surface.length(p);if(n)surface.remove(p,0,n);}
    const removed=new Map<number,unknown>();
    for(let p=to.p;p>from.p;p--)removed.set(p,surface.merge(p));
    if(!text)continue;
    const metas=newParagraphFormats(units,e).map(f=>f===undefined?undefined:removed.get(f));
    if(object){
      // After the merge the object sits at from.o right before the joined tail; write in front of the tail's first character.
      if(surface.length(from.p)<=from.o)fail('표·그림 바로 뒤의 문단 끝에는 아직 글을 넣지 못합니다. 앞에 넣도록 다시 요청해 주세요.');
      const next=surface.charAt(from.p,from.o);write(from.p,from.o+1,text+next,metas);surface.remove(from.p,from.o,1);
    }else write(from.p,from.o,text,metas);
  }

  // 3) Character shapes as planned, then a full read-back of text, shapes, paragraph shapes and objects.
  const delta=planned.length-(last-first+1);
  if(surface.count()!==c.count+delta)fail('문단 수 검사가 실패했습니다.');
  const now=w.getControls() as Control[],old=JSON.parse(c.controls) as Control[],base=globalBase(w,s);
  planned.forEach((plan,i)=>{
    const p=first+i,text=plan.chars.map(x=>x.ch).join(''),ids=plan.chars.map(x=>x.id);
    if(ids.some(id=>!Number.isInteger(id)))fail('글자 서식을 확인하지 못했습니다.');
    if(text&&JSON.stringify(surface.read(p).runs)!==JSON.stringify(runsOf(ids)))surface.setRuns(p,runsOf(ids));
    const actual=surface.read(p);
    if(actual.text!==text||JSON.stringify(actual.runs)!==JSON.stringify(runsOf(ids)))fail('교체 후 본문·글자 서식 검사가 실패했습니다.');
    if(actual.format!==c.paragraphs[plan.format].format)fail('교체 후 문단 서식 검사가 실패했습니다.');
    if(c.cell)return;
    const positions=w.getControlTextPositions(s,p);
    const objects=now.filter(x=>x.list===0&&x.para===base+p&&!SECTION.has(x.ctrlId)).sort((x,y)=>x.controlIndex-y.controlIndex).map(x=>({ctrlId:x.ctrlId,offset:positions[x.controlIndex]}));
    if(JSON.stringify(objects)!==JSON.stringify(plan.objects))fail('표·그림 위치가 바뀌어 적용을 취소했습니다.');
  });
  for(let p=0;p<c.count;p++)if(p<first||p>last){if(JSON.stringify(surface.read(p<first?p:p+delta))!==JSON.stringify(c.paragraphs[p]))fail('선택 밖 글이나 서식이 바뀌었습니다.');}
  const tail=planned.at(-1)!,offset=tail.chars.length-(chars(last).length-c.end.charOffset);
  if(c.cell){
    // Every object in the document, including any inside this cell, is exactly where it was.
    if(JSON.stringify(now)!==JSON.stringify(old))fail('셀 안이나 밖의 개체가 바뀌어 적용을 취소했습니다.');
    return {sectionIndex:s,paragraphIndex:c.cell.parent,charOffset:offset,parentParaIndex:c.cell.parent,controlIndex:c.cell.control,cellIndex:c.cell.cell,cellParaIndex:first+planned.length-1};
  }
  const outside=(list:Control[],shift:number)=>list.filter(x=>x.list!==0||x.para<base+first||x.para>base+last+shift).map(x=>x.list===0&&x.para>base+last+shift?{...x,para:x.para-shift}:x);
  if(now.length!==old.length||JSON.stringify(outside(now,delta))!==JSON.stringify(outside(old,0)))fail('선택 밖 개체나 구역 설정이 바뀌었습니다.');
  return {sectionIndex:s,paragraphIndex:first+planned.length-1,charOffset:offset};
}
