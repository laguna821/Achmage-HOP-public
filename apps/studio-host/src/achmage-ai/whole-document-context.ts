import type {WasmBridge} from '@/upstream/core';
export interface WholeDocumentCell {index:number;row:number;col:number;rowSpan:number;colSpan:number;paragraphs:{index:number;text:string}[]}
export interface WholeDocumentTable {controlIndex:number;charOffset:number;rowCount:number;colCount:number;cells:WholeDocumentCell[]}
export interface WholeDocumentParagraph {index:number;text:string;tables:WholeDocumentTable[]}
export interface WholeDocumentSection {index:number;paragraphs:WholeDocumentParagraph[]}
export interface WholeDocumentContext {sections:WholeDocumentSection[];paragraphs:number;tables:number;chars:number}
/**
 * Safety bounds, not content limits: a long report with dozens of tables reads whole. The text stays in
 * memory and is typeset by the local engine, whose input limit (16 MiB) is the ceiling; table sizes follow Kordoc's.
 */
const MAX_BYTES=16*1024*1024,MAX_PARAGRAPHS=1_000_000,MAX_CONTROLS=1_000_000,MAX_SECTIONS=4096,MAX_ROWS=5000,MAX_COLS=500,MAX_TABLE_CELLS=200_000;
const LAYOUT_CONTROLS=new Set(['secd','cold','pgnp','pghd','nwno','head','foot']);
const fail=(s:string):never=>{throw Error(s);};
function count(n:number,max:number,label:string,min=0):number{if(!Number.isSafeInteger(n)||n<min||n>max)fail(label+'이 전체 문서 읽기 범위를 넘었습니다.');return n;}
/** Read-only content snapshot. Not a formatting/object-preserving document serialization. */
export function captureWholeDocumentContext(wasm:WasmBridge):WholeDocumentContext{
 if(wasm.pageCount===0)fail('전체 내용을 사용할 문서를 먼저 여세요.');
 const sectionCount=count(wasm.getSectionCount(),MAX_SECTIONS,'구역 수',1),counts:number[]=[];let bodyCount=0;
 for(let s=0;s<sectionCount;s++){const n=count(wasm.getParagraphCount(s),MAX_PARAGRAPHS,'본문 문단 수');bodyCount+=n;if(bodyCount>MAX_PARAGRAPHS)fail('본문 문단 수가 전체 문서 읽기 범위를 넘었습니다.');counts.push(n);}
 const controls=wasm.getControls();if(!Array.isArray(controls)||controls.length>MAX_CONTROLS)fail('개체 목록이 읽기 범위를 넘었습니다.');
 const byParagraph=new Map<number,typeof controls>(),seen=new Set<string>();
 for(const c of controls){
  // Page/section layout carries no body text; the selected template re-creates it and the result discloses the change.
  // Nested controls (inside table cells, e.g. auto numbers) are content the text projection would drop, so they still fail.
  if(c.list!==0)fail('중첩 표·셀 안 개체·필드의 전체 내용을 안전하게 가져올 수 없습니다.');
  if(c.ctrlId!=='tbl'&&!LAYOUT_CONTROLS.has(c.ctrlId))fail('표 이외의 개체(그림·도형·필드 등)가 있어 전체 내용을 빠짐없이 가져올 수 없습니다: '+c.ctrlId);
  count(c.para,bodyCount-1,'개체 문단');count(c.controlIndex,MAX_CONTROLS-1,'개체 번호');const key=c.para+':'+c.controlIndex;if(seen.has(key))fail('개체 위치가 중복되어 읽지 않았습니다.');seen.add(key);const list=byParagraph.get(c.para)??[];list.push(c);byParagraph.set(c.para,list);
 }
 let paragraphs=0,tables=0,chars=0,textBytes=0,global=0;
 const encoder=new TextEncoder();
 const text=(value:string,length:number)=>{if(typeof value!=='string'||Array.from(value).length!==length)fail('문서 문자열 길이가 일치하지 않아 일부 내용을 보내지 않았습니다.');chars+=length;textBytes+=encoder.encode(value).length;if(textBytes>MAX_BYTES)fail('전체 문서 내용이 16MiB를 넘어 읽지 않았습니다. 내용을 자르지 않았습니다.');return value;};
 const paragraph=()=>{if(++paragraphs>MAX_PARAGRAPHS)fail('본문과 표 셀 문단 수가 전체 문서 읽기 범위를 넘었습니다.');};
 const noField=(position:Parameters<WasmBridge['getFieldInfoAt']>[0],length:number)=>{for(let i=0;i<=length;i++)if(wasm.getFieldInfoAt({...position,charOffset:i}).inField)fail('필드가 있어 원문 내용을 안전하게 가져올 수 없습니다.');};
 const sections:WholeDocumentSection[]=[];
 for(let s=0;s<sectionCount;s++){const sourceParagraphs:WholeDocumentParagraph[]=[];
  for(let p=0;p<counts[s];p++,global++){paragraph();const length=count(wasm.getParagraphLength(s,p),MAX_BYTES,'문단 길이'),value=text(wasm.getTextRange(s,p,0,length),length);noField({sectionIndex:s,paragraphIndex:p,charOffset:0},length);
   const positions=wasm.getControlTextPositions(s,p),local=(byParagraph.get(global)??[]).sort((a,b)=>a.controlIndex-b.controlIndex);
   // Controls occupy their own slots, so a control after others can sit past the text length (e.g. a footer after a table in an empty paragraph).
   if(positions.length!==local.length||local.some((c,i)=>c.controlIndex!==i)||positions.some(n=>!Number.isSafeInteger(n)||n<0||n>length+local.length))fail('문단 개체의 순서와 위치가 일치하지 않아 읽지 않았습니다.');
   const sourceTables:WholeDocumentTable[]=[];
   for(const c of local){if(c.ctrlId!=='tbl')continue;tables++;const d=wasm.getTableDimensions(s,p,c.controlIndex);count(d.rowCount,MAX_ROWS,'표 행 수',1);count(d.colCount,MAX_COLS,'표 열 수',1);count(d.cellCount,MAX_TABLE_CELLS,'표 셀 수',1);if(d.rowCount*d.colCount>MAX_TABLE_CELLS)fail('표 셀 수가 전체 문서 읽기 범위를 넘었습니다.');const grid=new Set<number>(),sourceCells:WholeDocumentCell[]=[];
    for(let cell=0;cell<d.cellCount;cell++){const info=wasm.getCellInfo(s,p,c.controlIndex,cell);count(info.row,d.rowCount-1,'셀 행');count(info.col,d.colCount-1,'셀 열');count(info.rowSpan,d.rowCount,'셀 병합 행',1);count(info.colSpan,d.colCount,'셀 병합 열',1);if(info.row+info.rowSpan>d.rowCount||info.col+info.colSpan>d.colCount)fail('표 병합 범위가 올바르지 않습니다.');for(let r=info.row;r<info.row+info.rowSpan;r++)for(let col=info.col;col<info.col+info.colSpan;col++){const key=r*d.colCount+col;if(grid.has(key))fail('겹치는 표 셀은 읽을 수 없습니다.');grid.add(key);}
     const n=count(wasm.getCellParagraphCount(s,p,c.controlIndex,cell),MAX_PARAGRAPHS,'셀 문단 수',1),sourceCellParagraphs=[];
     for(let cp=0;cp<n;cp++){paragraph();const args=[s,p,c.controlIndex,cell,cp] as const,len=count(wasm.getCellParagraphLength(...args),MAX_BYTES,'셀 문단 길이'),content=text(wasm.getTextInCell(...args,0,len),len);noField({sectionIndex:s,paragraphIndex:cp,charOffset:0,parentParaIndex:p,controlIndex:c.controlIndex,cellIndex:cell,cellParaIndex:cp},len);sourceCellParagraphs.push({index:cp,text:content});}
     sourceCells.push({index:cell,...info,paragraphs:sourceCellParagraphs});
    }
    if(grid.size!==d.rowCount*d.colCount)fail('표에 확인하지 못한 빈 좌표가 있어 읽지 않았습니다.');sourceTables.push({controlIndex:c.controlIndex,charOffset:positions[c.controlIndex],rowCount:d.rowCount,colCount:d.colCount,cells:sourceCells});
   }
   sourceParagraphs.push({index:p,text:value,tables:sourceTables});
  }
  sections.push({index:s,paragraphs:sourceParagraphs});
 }
 return {sections,paragraphs,tables,chars};
}
