import { checkboxTargets, clearCheckboxTargets } from './checkbox-edit';
import { executeTocRefresh, findToc } from './toc-pages';
import { DocumentAgentController, collectTargetEvidence, parseApplyTextCommand, type RhwpApplyTextCommandV1, type RhwpDocumentStateV1 } from '@/upstream/document-agent';
import type { WasmBridge, EventBus } from '@/upstream/core';
import type { InputHandler } from '@/upstream/editor';
import type { CanvasView } from '@/upstream/view';
import { captureStructuredRange, captureStructuredInsertion as captureInsertionPlan, executeStructuredInsertion, executeStructuredPlan, parseStructuredPlan, type ParagraphRange, type StructuredCapture } from './structured-edit';
import { captureCellRange, captureMultiRange, executeMultiRange, normalizeMultiReplacement, type MultiRange } from './multi-range';
import { prepareImportedDocument, type ImportSourceRange } from './kordoc-document';
import { prepareWholeDocumentReplacement, type WholeReplacement } from './whole-document-replace';
import { executeRestyle, planRestyle, type RestyleResult } from './restyle';
import type { DocumentTemplate } from './document-templates';
import { textFormatMods, type TextFormat } from './text-format';

export interface ParagraphCapture { command: RhwpApplyTextCommandV1; before: string; selection: string; range?: { start: number; end: number; paragraph: string }; insertion?:never; multi?:never }
export interface InsertionCapture { multi?:never; before:string;selection:string;command?:never;range?:never;insertion:{identity:RhwpDocumentStateV1;position:ReturnType<InputHandler['getCursorPosition']>;paragraph:string;controls:string;paraFormat:string;charFormat:string;paragraphCount:number} }
export interface MultiCapture { before:string; selection:string; multi:MultiRange; wholeParagraphs?:true; command?:never; range?:never; insertion?:never }
export type Capture=ParagraphCapture|InsertionCapture|MultiCapture;
/** HOP positions count Unicode scalars; JavaScript string slices count UTF-16. */
export function selectedRange(text: string, start: number, end: number): { prefix: string; selected: string; suffix: string } {
  const scalars = Array.from(text);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > scalars.length) throw new Error('올바른 본문 선택 영역이 아닙니다.');
  if (typeof Intl.Segmenter !== 'function') throw new Error('이 환경에서는 안전한 선택 경계를 확인할 수 없습니다.');
  const prefix = scalars.slice(0, start).join(''), selected = scalars.slice(start, end).join('');
  const boundaries = new Set([...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(text)].map(s => s.index));
  boundaries.add(text.length);
  if (!boundaries.has(prefix.length) || !boundaries.has(prefix.length + selected.length)) throw new Error('결합 문자나 이모지 중간에서는 나눌 수 없습니다.');
  return { prefix, selected, suffix: scalars.slice(end).join('') };
}
type BodyPosition={sectionIndex:number;paragraphIndex:number;charOffset:number};
function orderedPositions<T extends BodyPosition>(a:T,b:T):[T,T]{return a.paragraphIndex<b.paragraphIndex||a.paragraphIndex===b.paragraphIndex&&a.charOffset<=b.charOffset?[a,b]:[b,a];}
/**
 * The paragraphs a selection really covers: an end at the next paragraph's start (Shift+Down)
 * or a start at a paragraph's end only touches a paragraph break and does not include that paragraph.
 */
export function coveredParagraphs(a:BodyPosition,b:BodyPosition,length:(p:number)=>number):{first:number;last:number;partial:boolean}{
  let first=a.paragraphIndex,last=b.paragraphIndex;
  if(last>first&&b.charOffset===0)last-=1;
  if(first<last&&a.charOffset>=length(first))first+=1;
  const startsInside=first===a.paragraphIndex&&a.charOffset>0,endsInside=last===b.paragraphIndex&&b.charOffset<length(last);
  return {first,last,partial:startsInside||endsInside};
}
/** Typed adapter over the actual HOP editor, never a second document or history. */
/** Both ends in the same cell of a table that sits in the body (nested tables are not edited yet). */
function sameCell(a:ReturnType<InputHandler['getCursorPosition']>,b:ReturnType<InputHandler['getCursorPosition']>):{section:number;parent:number;control:number;cell:number}|null{
  const flat=(p:typeof a)=>p.parentParaIndex!==undefined&&p.controlIndex!==undefined&&p.cellIndex!==undefined&&p.cellParaIndex!==undefined&&!p.isTextBox&&(p.cellPath?.length??1)<=1;
  if(!flat(a)||!flat(b)||a.sectionIndex!==b.sectionIndex||a.parentParaIndex!==b.parentParaIndex||a.controlIndex!==b.controlIndex||a.cellIndex!==b.cellIndex)return null;
  return {section:a.sectionIndex,parent:a.parentParaIndex!,control:a.controlIndex!,cell:a.cellIndex!};
}
/** Only the contents page-number step of a whole-document replacement failed. */
class TocRefreshFailed extends Error {}
/** An edit failed and so did the engine's rollback: the open document may be partly changed. */
export class RollbackFailed extends Error {}
type SnapshotOperation=Parameters<InputHandler['executeDocumentAgentOperation']>[0]['operation'];

export class AiDocument {
  private controller: DocumentAgentController;
  private applying = false;
  private blockedEpoch: number | null = null;
  /** `recover` opens given HWPX bytes in a new window; without it a failed rollback only blocks further AI edits. */
  constructor(private wasm: WasmBridge, private input: InputHandler, eventBus: EventBus, private view: CanvasView, dirty: () => boolean, private recover?: (bytes: Uint8Array) => Promise<void>) {
    this.controller = new DocumentAgentController({ wasm, input, eventBus, isDirty: dirty, render: () => view.refreshDocumentAgentMutation() });
  }
  /** The open document as HWPX, kept until an edit settles. Never for password documents: no unencrypted copy is written. */
  private recoveryBytes(): Uint8Array | null {
    if (!this.recover || this.wasm.requiresPasswordForSave) return null;
    try { return this.wasm.exportHwpx(); } catch { return null; }
  }
  /**
   * One snapshot command (one Ctrl+Z). The engine rolls a failed command back; if that rollback fails too, the
   * document no longer matches `identity` and is partly changed. The copy taken just before is then opened in a
   * new window so nothing the user had is lost, and the error says which window to keep.
   */
  private async snapshot(identity: RhwpDocumentStateV1, operationType: string, operation: SnapshotOperation): Promise<void> {
    const before = this.owns(identity) ? this.recoveryBytes() : null;
    try { await this.input.executeDocumentAgentOperation({ kind: 'snapshot', operationType, operation }, () => this.view.refreshDocumentAgentMutation()); }
    catch (error) { throw before && !this.owns(identity) ? await this.recovered(before, error) : error; }
  }
  private async recovered(before: Uint8Array, cause: unknown): Promise<RollbackFailed> {
    const lead = '편집을 되돌리지 못해 이 창의 문서는 일부만 바뀌었을 수 있습니다.';
    try {
      await this.recover!(before);
      return new RollbackFailed(`${lead} 편집 전 문서를 새 창에 열었습니다. 이 창은 저장하지 말고 새 창에서 이어서 작업하세요.`, { cause });
    } catch {
      return new RollbackFailed(`${lead} 편집 전 문서를 새 창에 열지 못했습니다. 이 창은 저장하지 말고 원래 파일을 다시 여세요.`, { cause });
    }
  }
  private selection(): string {
    // Geometry is not selection identity: a scroll/repaint must not invalidate it.
    const logical = (p: ReturnType<InputHandler['getCursorPosition']>) => ({
      sectionIndex: p.sectionIndex, paragraphIndex: p.paragraphIndex, charOffset: p.charOffset,
      parentParaIndex: p.parentParaIndex, controlIndex: p.controlIndex, cellIndex: p.cellIndex,
      cellParaIndex: p.cellParaIndex, cellPath: p.cellPath, isTextBox: p.isTextBox,
    });
    const selection = this.input.getSelection();
    return JSON.stringify({ cursor: logical(this.input.getCursorPosition()), selection: selection && { start: logical(selection.start), end: logical(selection.end) } });
  }
  /** One verified workflow, even when the model needed several inspection/edit rounds. */
  async applyWorkflow(identity:RhwpDocumentStateV1, operation:(wasm:WasmBridge)=>void):Promise<void> {
    if(this.applying||!this.owns(identity))throw Error('작업 중 문서가 변경되어 반영하지 않았습니다. 다시 요청하세요.');
    this.applying=true;
    try { await this.snapshot(identity,'achmageWorkflow',wasm=>{
      if(!this.owns(identity))throw Error('문서가 변경되었습니다.');
      operation(wasm);
      return {sectionIndex:0,paragraphIndex:0,charOffset:0};
    }); } finally { this.applying=false; }
  }
  capture(): Capture {
    if (!this.input.getSelection() && this.emptyCellCaret()) return this.captureSelection();
    if (this.wasm.pageCount === 0) throw new Error('문서를 먼저 여세요.');
    const context = this.controller.getSelectionContext();
    if (!context.editable || !context.target) throw new Error('같은 글자 서식의 본문 문단만 수정할 수 있습니다. 표·필드·혼합 서식은 아직 지원하지 않습니다.');
    const state = this.controller.getDocumentState();
    if (state.documentEpoch === this.blockedEpoch) throw new Error('편집 결과의 복구를 확인하지 못했습니다. 문서를 다시 여세요.');
    const evidence = collectTargetEvidence(this.wasm, context.target);
    return { before: evidence.text, selection: this.selection(), command: {
      schemaVersion: 1, commandId: crypto.randomUUID(), expectedDocumentEpoch: state.documentEpoch,
      expectedChangeSeq: state.changeSeq, expectedDocumentSha256: state.documentSha256,
      target: { ...context.target }, expectedBeforeSha256: evidence.textSha256,
      expectedFormatSha256: evidence.formatSha256, expectedAdjacentContextSha256: evidence.adjacentContextSha256, replacement: '',
    } };
  }
  private emptyCellCaret(): ReturnType<InputHandler['getCursorPosition']> | null {
    const p=this.input.getCursorPosition();
    if (!sameCell(p,p)) return null;
    return this.wasm.getCellParagraphLength(p.sectionIndex,p.parentParaIndex!,p.controlIndex!,p.cellIndex!,p.cellParaIndex!) === 0 ? p : null;
  }
  /** With wholeParagraphs the request covers the selected paragraphs from start to end; the visible selection is unchanged. */
  captureSelection(options:{wholeParagraphs?:boolean}={}): Capture {
    const caret=this.emptyCellCaret();
    const selection=this.input.getSelection() ?? (caret ? {start:caret,end:caret} : null);
    if(!selection||this.applying||this.wasm.pageCount===0)throw Error('수정할 본문을 먼저 선택하세요.');
    const body=(p:typeof selection.start)=>p.parentParaIndex===undefined&&p.cellIndex===undefined&&!p.isTextBox&&!p.cellPath?.length;
    const identity=this.identity();if(!this.owns(identity))throw Error('문서 복구 상태를 확인하지 못했습니다.');
    // Inside one cell of a body table: the edit stays in that cell and never touches the table's structure.
    const cell=sameCell(selection.start,selection.end);
    if(cell){
      const range=captureCellRange(this.wasm,identity,cell,{paragraph:selection.start.cellParaIndex!,offset:selection.start.charOffset},{paragraph:selection.end.cellParaIndex!,offset:selection.end.charOffset});
      return {before:range.before,selection:this.selection(),multi:range};
    }
    if(!body(selection.start)||!body(selection.end))throw Error('셀 하나 안의 글이나 표 밖의 본문 문단을 선택하세요.');
    let [a,b]=orderedPositions(selection.start,selection.end);
    if(options.wholeParagraphs){
      const len=(p:number)=>this.wasm.getParagraphLength(a.sectionIndex,p),covered=coveredParagraphs(a,b,len);
      a={...a,paragraphIndex:covered.first,charOffset:0};b={...b,paragraphIndex:covered.last,charOffset:len(covered.last)};
    }
    const multi=captureMultiRange(this.wasm,identity,a,b);
    return {before:multi.before,selection:this.selection(),multi,...(options.wholeParagraphs?{wholeParagraphs:true as const}:{})};
  }
  /** How the current body selection sits in its paragraphs (for offering "whole paragraphs"). */
  selectionShape():{paragraphs:number;partial:boolean}|null{
    // Cells have no "whole paragraphs" offer: a cell selection is edited inside that cell as it is.
    const s=this.input.getSelection();if(!s||s.start.sectionIndex!==s.end.sectionIndex||s.start.cellIndex!==undefined||s.end.cellIndex!==undefined||s.start.parentParaIndex!==undefined||s.end.parentParaIndex!==undefined)return null;
    try{const [a,b]=orderedPositions(s.start,s.end),covered=coveredParagraphs(a,b,p=>this.wasm.getParagraphLength(a.sectionIndex,p));
      return {paragraphs:covered.last-covered.first+1,partial:covered.partial};}
    catch{return null;}
  }
  captureInsertion():InsertionCapture {
    const p={...this.input.getCursorPosition()},selection=this.input.getSelection();
    if(this.wasm.pageCount===0)throw new Error('문서를 먼저 여세요.');
    if(p.parentParaIndex!==undefined||p.isTextBox||p.cellPath?.length||p.cellIndex!==undefined)throw new Error('본문의 커서 위치에만 새 글을 삽입할 수 있습니다.');
    if(selection&&(selection.start.sectionIndex!==selection.end.sectionIndex||selection.start.paragraphIndex!==selection.end.paragraphIndex||selection.start.charOffset!==selection.end.charOffset))throw new Error('새 글을 넣을 위치를 클릭해 선택 영역을 해제하세요.');
    const identity=this.identity();if(!this.owns(identity))throw new Error('문서 상태를 확인하지 못했습니다. 다시 여세요.');
    const length=this.wasm.getParagraphLength(p.sectionIndex,p.paragraphIndex),text=length?this.wasm.getTextRange(p.sectionIndex,p.paragraphIndex,0,length):'';
    if(length>200_000||!Number.isInteger(p.charOffset)||p.charOffset<0||p.charOffset>Array.from(text).length)throw new Error('이 본문 위치는 아직 삽입을 지원하지 않습니다.');
    const prefix=Array.from(text).slice(0,p.charOffset).join('');
    if(typeof Intl.Segmenter!=='function'||![...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(text)].some(s=>s.index===prefix.length)&&prefix.length!==text.length)throw new Error('결합 문자나 이모지 중간에는 삽입할 수 없습니다.');
    const controls=this.wasm.getControls();let globalParagraph=p.paragraphIndex;for(let i=0;i<p.sectionIndex;i++)globalParagraph+=this.wasm.getParagraphCount(i);
    const local=controls.filter(c=>c.list===0&&c.para===globalParagraph),positions=this.wasm.getControlTextPositions(p.sectionIndex,p.paragraphIndex);
    if(local.length!==positions.length||local.some(c=>!['secd','cold'].includes(c.ctrlId))||positions.some(n=>n!==0)||local.length>2||new Set(local.map(c=>c.ctrlId)).size!==local.length)throw new Error('표·필드·그림 등 개체가 있는 문단에는 아직 새 글을 삽입할 수 없습니다.');
    const charFormat=JSON.stringify(this.wasm.getCharPropertiesAt(p.sectionIndex,p.paragraphIndex,0));
    for(let i=0;i<=length;i++){if(this.wasm.getFieldInfoAt({...p,charOffset:i}).inField)throw new Error('필드 안에는 삽입할 수 없습니다.');if(i<length&&JSON.stringify(this.wasm.getCharPropertiesAt(p.sectionIndex,p.paragraphIndex,i))!==charFormat)throw new Error('혼합 글자 서식 문단은 아직 지원하지 않습니다.');}
    return {before:'',selection:this.selection(),insertion:{identity,position:p,paragraph:text,controls:JSON.stringify(controls),paraFormat:JSON.stringify(this.wasm.getParaPropertiesAt(p.sectionIndex,p.paragraphIndex)),charFormat,paragraphCount:this.wasm.getParagraphCount(p.sectionIndex)}};
  }
  identity(): RhwpDocumentStateV1 { return this.controller.getDocumentState(); }
  captureStructured(range?:ParagraphRange):StructuredCapture {
    if(this.applying||this.wasm.pageCount===0)throw new Error('문서를 먼저 열고 진행 중인 편집을 마치세요.');
    if(!range){
      const cursor=this.input.getCursorPosition(),selection=this.input.getSelection();
      const body=(p:typeof cursor)=>p.parentParaIndex===undefined&&!p.isTextBox&&!p.cellPath?.length&&p.cellIndex===undefined;
      if(!body(cursor))throw new Error('구조 편집은 본문 문단에서만 지원합니다.');
      if(selection){
        let {start,end}=selection;if(start.sectionIndex!==end.sectionIndex||!body(start)||!body(end))throw new Error('같은 구역의 본문 문단을 선택하세요.');
        if(start.paragraphIndex>end.paragraphIndex||start.paragraphIndex===end.paragraphIndex&&start.charOffset>end.charOffset)[start,end]=[end,start];
        if(start.charOffset!==0||end.charOffset!==this.wasm.getParagraphLength(end.sectionIndex,end.paragraphIndex))throw new Error('서식 작성은 문단 전체를 선택한 범위에만 적용할 수 있습니다.');
        range={section:start.sectionIndex,startParagraph:start.paragraphIndex,paragraphCount:end.paragraphIndex-start.paragraphIndex+1};
      }else{
        if(this.wasm.getParagraphLength(cursor.sectionIndex,cursor.paragraphIndex)!==0)throw new Error('기존 본문을 바꾸려면 해당 문단 전체를 선택하세요.');
        range={section:cursor.sectionIndex,startParagraph:cursor.paragraphIndex,paragraphCount:1};
      }
    }
    const identity=this.identity();if(!this.owns(identity))throw new Error('문서 복구 상태를 확인하지 못했습니다. 다시 여세요.');
    return captureStructuredRange(this.wasm,identity,this.selection(),range);
  }
  isStructuredCurrent(capture:StructuredCapture):boolean{return !this.applying&&this.selection()===capture.selection&&this.owns(capture.identity);}
  captureStructuredInsertion():StructuredCapture {
    if(this.applying||this.wasm.pageCount===0)throw new Error('문서를 먼저 열고 진행 중인 편집을 마치세요.');
    const p=this.input.getCursorPosition(),s=this.input.getSelection();
    if(p.sectionIndex!==0||p.parentParaIndex!==undefined||p.cellIndex!==undefined||p.isTextBox||p.cellPath?.length)throw new Error('표 셀 밖 본문에 커서를 놓아 주세요.');
    if(s&&(s.start.sectionIndex!==s.end.sectionIndex||s.start.paragraphIndex!==s.end.paragraphIndex||s.start.charOffset!==s.end.charOffset))throw new Error('삽입할 위치를 클릭해 선택을 해제하세요.');
    const identity=this.identity();if(!this.owns(identity))throw new Error('문서 상태를 확인하지 못했습니다.');
    return captureInsertionPlan(this.wasm,identity,this.selection(),p.paragraphIndex,p.charOffset);
  }
  async applyStructured(capture:StructuredCapture,unknownPlan:unknown):Promise<void>{
    const plan=parseStructuredPlan(unknownPlan);
    if(!this.isStructuredCurrent(capture))throw new Error('문서 또는 선택이 바뀌어 구조 편집을 취소했습니다.');
    const fresh=capture.insertion?this.captureStructuredInsertion():this.captureStructured(capture.range);
    if(JSON.stringify(fresh)!==JSON.stringify(capture))throw new Error('구조 편집의 원문/서식 검증이 실패했습니다.');
    this.applying=true;
    try{
      await this.snapshot(capture.identity,'achmageStructuredEdit',wasm=>{
        if(!this.owns(capture.identity))throw new Error('구조 편집 직전에 문서가 바뀌었습니다.');
        if(capture.insertion)executeStructuredInsertion(wasm,capture,plan);else executeStructuredPlan(wasm,capture,plan);
        const paragraphIndex=capture.range.startParagraph+plan.paragraphs.length-1;
        return {sectionIndex:capture.range.section,paragraphIndex,charOffset:wasm.getParagraphLength(capture.range.section,paragraphIndex)};
      });
    }catch(error){try{if(!this.owns(capture.identity))this.blockedEpoch=this.identity().documentEpoch;}catch{this.blockedEpoch=capture.identity.documentEpoch;}throw error;}finally{this.applying=false;}
  }
  owns(identity: RhwpDocumentStateV1): boolean {
    try { const now = this.identity(); return now.documentEpoch !== this.blockedEpoch && now.documentEpoch === identity.documentEpoch && now.changeSeq === identity.changeSeq && now.documentSha256 === identity.documentSha256; } catch { return false; }
  }
  async applyImportedDocument(capture:StructuredCapture,bytes:Uint8Array,sourceRange?:ImportSourceRange):Promise<void>{
    if(!capture.insertion||!this.isStructuredCurrent(capture))throw Error('문서 또는 삽입 위치가 바뀌었습니다.');
    if(JSON.stringify(this.captureStructuredInsertion())!==JSON.stringify(capture))throw Error('문서 가져오기 원문 검증이 실패했습니다.');
    // Full native dry-run happens before history or target mutation.
    const prepared=prepareImportedDocument(this.wasm,capture,bytes,sourceRange);this.applying=true;
    try{await this.snapshot(capture.identity,'achmageImportDocument',()=>{
      if(!this.owns(capture.identity))throw Error('문서 가져오기 직전에 원문이 바뀌었습니다.');return prepared.execute();
    });}
    catch(error){try{if(!this.owns(capture.identity))this.blockedEpoch=this.identity().documentEpoch;}catch{this.blockedEpoch=capture.identity.documentEpoch;}throw error;}
    finally{prepared.close();this.applying=false;}
  }
  /** True for a fresh document: one empty body paragraph holding only its section controls. */
  isBlank(): boolean {
    try {
      if (this.wasm.pageCount === 0 || this.wasm.getSectionCount() !== 1 || this.wasm.getParagraphCount(0) !== 1 || this.wasm.getParagraphLength(0, 0) !== 0) return false;
      return this.wasm.getControls().every(c => c.list === 0 && ['secd', 'cold'].includes(c.ctrlId));
    } catch { return false; }
  }
  /**
   * Replaces the whole open document with generated HWPX inside one snapshot command (one Ctrl+Z).
   * With `toc` (the template has a contents page) the contents lines get their page numbers in the same
   * step. If only that step fails, the snapshot is rolled back and the document is applied again without
   * page numbers, so the generated result is never lost; `tocFailure` says why.
   */
  async clearCheckboxes(): Promise<{found:number;changed:number}> {
    if(this.applying) throw Error('편집 중입니다.');
    const identity=this.identity(),targets=checkboxTargets(this.wasm);
    if(!targets.some(t=>t.value!==0)) return {found:targets.length,changed:0};
    this.applying=true;let changed=0;
    try { await this.snapshot(identity,'achmageClearCheckboxes',wasm=>{
      if(!this.owns(identity)) throw Error('문서가 바뀌었습니다.');
      changed=clearCheckboxTargets(wasm,targets);return this.input.getCursorPosition();
    });return {found:targets.length,changed}; } finally {this.applying=false;}
  }
  async applyWholeDocument(identity:RhwpDocumentStateV1,bytes:Uint8Array,options:{hideFirstPage:boolean;toc?:boolean}):Promise<Pick<WholeReplacement,'paragraphs'|'removedLayout'>&{toc?:{entries:number;pages:number[]};tocFailure?:string}>{
    if(this.applying||!this.owns(identity))throw Error('문서가 바뀌어 서식 적용을 멈췄습니다. 다시 요청하세요.');
    // Throws InPlaceReplacementUnsupported before any history or document mutation.
    const prepared=prepareWholeDocumentReplacement(this.wasm,bytes,options);this.applying=true;
    let toc:{entries:number;pages:number[]}|undefined,tocFailure:string|undefined;
    try{await this.snapshot(identity,'achmageWholeDocument',wasm=>{
      if(!this.owns(identity))throw Error('서식 적용 직전에 문서가 바뀌었습니다.');const cursor=prepared.execute();
      if(options.toc){
        let entries:ReturnType<typeof findToc>=[];try{entries=findToc(wasm);}catch{entries=[];}
        if(entries.length)try{toc=executeTocRefresh(wasm,entries);}catch(error){throw new TocRefreshFailed(error instanceof Error?error.message:'목차 쪽 번호를 넣지 못했습니다.');}
      }
      return cursor;
    });return {paragraphs:prepared.paragraphs,removedLayout:prepared.removedLayout,...(toc?{toc}:{})};}
    catch(error){
      if(error instanceof TocRefreshFailed&&this.owns(identity))tocFailure=error.message;
      else{try{if(!this.owns(identity))this.blockedEpoch=this.identity().documentEpoch;}catch{this.blockedEpoch=identity.documentEpoch;}throw error;}
    }
    finally{prepared.close();this.applying=false;}
    return {...await this.applyWholeDocument(identity,bytes,{...options,toc:false}),tocFailure};
  }
  /** '서식만 바꾸기': every body and table paragraph takes its role's template look, in one snapshot (one Ctrl+Z). No AI, no text change. */
  async applyRestyle(identity:RhwpDocumentStateV1,template:Pick<DocumentTemplate,'roles'>):Promise<RestyleResult>{
    if(this.applying||!this.owns(identity))throw Error('문서가 바뀌어 서식 적용을 멈췄습니다. 다시 요청하세요.');
    const plan=planRestyle(this.wasm);if(!plan.targets.length)throw Error('서식을 바꿀 본문이 없습니다. 표지·목차와 디자인 표는 그대로 둡니다.');
    let result:RestyleResult|undefined;this.applying=true;
    try{await this.snapshot(identity,'achmageRestyle',wasm=>{
      if(!this.owns(identity))throw Error('서식 적용 직전에 문서가 바뀌었습니다.');result=executeRestyle(wasm,plan,template);return this.input.getCursorPosition();
    });return result!;}
    catch(error){try{if(!this.owns(identity))this.blockedEpoch=this.identity().documentEpoch;}catch{this.blockedEpoch=identity.documentEpoch;}throw error;}
    finally{this.applying=false;}
  }
  /** Character formatting for exactly the selected characters (body or one cell), one Ctrl+Z; the text never changes. */
  async applyTextFormat(format:TextFormat):Promise<{chars:number}>{
    const capture=this.captureSelection();if(!capture.multi)throw Error('서식을 바꿀 글을 선택하세요.');
    const m=capture.multi,s=m.start.sectionIndex;let chars=0;
    this.applying=true;
    try{await this.snapshot(m.identity,'achmageTextFormat',wasm=>{
      if(!this.owns(m.identity))throw Error('적용 직전에 문서가 바뀌었습니다.');
      const d=wasm.borrowDocumentHandle();if(!d)throw Error('문서 엔진이 없습니다.');
      const text=d.getTextFileUnicode(),controls=JSON.stringify(wasm.getControls());
      const mods=textFormatMods(format,family=>Array.from({length:7},(_,lang)=>wasm.findOrCreateFontIdForLang(lang,family)));
      for(let p=m.start.paragraphIndex;p<=m.end.paragraphIndex;p++){
        const length=Array.from(m.paragraphs[p].text).length,lo=p===m.start.paragraphIndex?m.start.charOffset:0,hi=p===m.end.paragraphIndex?m.end.charOffset:length;
        if(hi<=lo)continue;chars+=hi-lo;
        const r=JSON.parse(m.cell?wasm.applyCharFormatInCell(s,m.cell.parent,m.cell.control,m.cell.cell,p,lo,hi,mods):wasm.applyCharFormat(s,p,lo,hi,mods)) as {ok?:boolean};
        if(r.ok===false)throw Error('글자 서식을 적용하지 못했습니다.');
      }
      if(d.getTextFileUnicode()!==text||JSON.stringify(wasm.getControls())!==controls)throw Error('서식을 바꾸는 중 글이나 개체가 달라져 취소했습니다.');
      return this.input.getCursorPosition();
    });return {chars};}
    catch(error){try{if(!this.owns(m.identity))this.blockedEpoch=this.identity().documentEpoch;}catch{this.blockedEpoch=m.identity.documentEpoch;}throw error;}
    finally{this.applying=false;}
  }
  /** '목차 새로 고침': contents lines take the page numbers their headings are on now (one Ctrl+Z, no AI). */
  async applyTocRefresh(identity:RhwpDocumentStateV1):Promise<{entries:number;pages:number[]}>{
    if(this.applying||!this.owns(identity))throw Error('문서가 바뀌어 목차 새로 고침을 멈췄습니다. 다시 요청하세요.');
    const entries=findToc(this.wasm);if(!entries.length)throw Error('목차를 찾지 못했습니다. 뒤에 같은 제목이 있는 목차 줄이 두 개 이상 필요합니다.');
    let result:{entries:number;pages:number[]}|undefined;this.applying=true;
    try{await this.snapshot(identity,'achmageTocRefresh',wasm=>{
      if(!this.owns(identity))throw Error('목차 새로 고침 직전에 문서가 바뀌었습니다.');result=executeTocRefresh(wasm,entries);return this.input.getCursorPosition();
    });return result!;}
    catch(error){try{if(!this.owns(identity))this.blockedEpoch=this.identity().documentEpoch;}catch{this.blockedEpoch=identity.documentEpoch;}throw error;}
    finally{this.applying=false;}
  }
  isCurrent(capture: Capture): boolean {
    if (this.applying || this.selection() !== capture.selection) return false;
    try {
      if(capture.insertion)return this.owns(capture.insertion.identity);
      if(capture.multi)return this.owns(capture.multi.identity);
      const state = this.controller.getDocumentState();
      return state.documentEpoch !== this.blockedEpoch && state.documentEpoch === capture.command.expectedDocumentEpoch && state.changeSeq === capture.command.expectedChangeSeq && state.documentSha256 === capture.command.expectedDocumentSha256;
    } catch { return false; }
  }
  async apply(capture: Capture, replacement: string): Promise<void> {
    if (!this.isCurrent(capture)) throw new Error('문서 또는 선택이 바뀌었습니다. 문단을 다시 선택해 요청하세요.');
    if(capture.insertion){await this.applyInsertion(capture,replacement);return;}
    if(capture.multi){await this.applyMulti(capture,replacement);return;}
    let paragraphReplacement = replacement;
    if (capture.range) {
      const r = selectedRange(capture.range.paragraph, capture.range.start, capture.range.end);
      if (r.selected !== capture.before) throw new Error('선택 영역의 원문이 일치하지 않습니다.');
      paragraphReplacement = r.prefix + replacement + r.suffix;
    }
    const command = parseApplyTextCommand({ ...capture.command, replacement: paragraphReplacement });
    if (replacement === capture.before) return;
    const before = this.recoveryBytes();
    this.applying = true;
    try { await this.controller.applyTextCommand(command); }
    catch (error) {
      let partial = true;
      try {
        const state = this.controller.getDocumentState();
        partial = state.documentSha256 !== command.expectedDocumentSha256 || state.changeSeq !== command.expectedChangeSeq;
        if (partial) this.blockedEpoch = state.documentEpoch;
      } catch { this.blockedEpoch = command.expectedDocumentEpoch; }
      throw partial && before ? await this.recovered(before, error) : error;
    }
    finally { this.applying = false; }
  }
  private async applyMulti(capture:MultiCapture,replacement:string):Promise<void>{
    if(normalizeMultiReplacement(replacement,capture.before)===capture.before)return;
    const fresh=this.captureSelection({wholeParagraphs:capture.wholeParagraphs===true});if(JSON.stringify(fresh)!==JSON.stringify(capture))throw Error('선택 영역의 원문이나 서식이 바뀌었습니다.');
    this.applying=true;
    try{await this.snapshot(capture.multi.identity,'achmageMultiRange',wasm=>{
      if(!this.owns(capture.multi.identity))throw Error('적용 직전에 문서가 바뀌었습니다.');
      return executeMultiRange(wasm,capture.multi,replacement);
    });}
    catch(error){try{if(!this.owns(capture.multi.identity))this.blockedEpoch=this.identity().documentEpoch;}catch{this.blockedEpoch=capture.multi.identity.documentEpoch;}throw error;}
    finally{this.applying=false;}
  }
  private async applyInsertion(capture:InsertionCapture,replacement:string):Promise<void>{
    if(!replacement.trim())throw new Error('삽입할 응답이 비어 있습니다.');
    if(replacement!==replacement.replace(/\r\n?/g,'\n')||/[\u0000-\u0008\u000b-\u001f\u007f]/.test(replacement)||Array.from(replacement).length+Array.from(capture.insertion.paragraph).length>200_000)throw new Error('새 글은 줄바꿈을 포함해 20만 자 이내로 입력하세요.');
    const fresh=this.captureInsertion(),expected=capture.insertion;
    if(JSON.stringify(fresh.insertion)!==JSON.stringify(expected))throw new Error('삽입 위치의 원문이나 서식이 바뀌었습니다.');
    const p=expected.position,chars=Array.from(expected.paragraph),text=chars.slice(0,p.charOffset).join('')+replacement+chars.slice(p.charOffset).join('');
    this.applying=true;
    try {
      await this.snapshot(expected.identity,'achmageInsertText',wasm=>{
        if(!this.owns(expected.identity))throw new Error('문서가 바뀌어 삽입을 취소했습니다.');
        const result=JSON.parse(wasm.insertText(p.sectionIndex,p.paragraphIndex,p.charOffset,replacement)) as {ok?:boolean;charOffset?:number};
        if(result.ok!==true||result.charOffset!==p.charOffset+Array.from(replacement).length)throw new Error('텍스트 삽입 결과를 확인하지 못했습니다.');
        const length=wasm.getParagraphLength(p.sectionIndex,p.paragraphIndex);
        if(wasm.getTextRange(p.sectionIndex,p.paragraphIndex,0,length)!==text||JSON.stringify(wasm.getControls())!==expected.controls||JSON.stringify(wasm.getParaPropertiesAt(p.sectionIndex,p.paragraphIndex))!==expected.paraFormat||wasm.getParagraphCount(p.sectionIndex)!==expected.paragraphCount)throw new Error('삽입 후 본문·구역 설정 보존 검사가 실패했습니다.');
        for(let i=0;i<length;i++)if(JSON.stringify(wasm.getCharPropertiesAt(p.sectionIndex,p.paragraphIndex,i))!==expected.charFormat)throw new Error('삽입 후 글자 서식 보존 검사가 실패했습니다.');
        return {...p,charOffset:result.charOffset};
      });
    }catch(error){try{if(!this.owns(expected.identity))this.blockedEpoch=this.identity().documentEpoch;}catch{this.blockedEpoch=expected.identity.documentEpoch;}throw error;}finally{this.applying=false;}
  }
  dispose(): void { this.controller.dispose(); }
}
