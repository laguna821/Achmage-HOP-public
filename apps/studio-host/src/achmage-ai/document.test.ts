/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { HwpDocument } from '../../vendor/rhwp-core/rhwp.js';
import { EventBus } from '@upstream/core/event-bus';
import { SnapshotCommand } from '@upstream/engine/command';
import { CommandHistory } from '@upstream/engine/history';
import { finishImagePlacement } from '@upstream/engine/input-handler-table';
import { AiDocument, selectedRange } from './document';
import type { WasmBridge } from '@/upstream/core';
import type { InputHandler } from '@/upstream/editor';
import type { CanvasView } from '@/upstream/view';
import { initPinnedEngine } from './test-support/pinned-wasm';

initPinnedEngine();
export function fixture(text = '한글 😀 é 문단', blank = false) {
  const seed = readFileSync(new URL('./fixtures/owned-blank.hwpx', import.meta.url));
  expect(createHash('sha256').update(seed).digest('hex')).toBe('c8b7a78482b6c46fc506832b85b52f33434a6c90b048babc0cdaa471f653d774');
  const native = new HwpDocument(seed); const paragraph=blank?0:1;if(!blank)native.splitParagraph(0, 0, 0); if(text)native.insertText(0, paragraph, 0, text);
  if(!blank)expect(JSON.parse(native.getControlTextPositions(0, 1))).toEqual([]);
  const eventBus = new EventBus(), history = new CommandHistory();
  let cursor = { sectionIndex: 0, paragraphIndex: paragraph, charOffset: 0 }, generation = 1, renders = 0, failRender = false;
  let selection: ReturnType<InputHandler['getSelection']> = null;
  const json = new Set(['getControlTextPositions', 'getCharPropertiesAt', 'getParaPropertiesAt', 'getStyleAt', 'replaceText', 'getPageOfPosition','getPageDef','insertPicture','getControls']);
  const wasm = new Proxy({}, { get(_target, name: string) {
    if (name === 'pageCount') return native.pageCount();
    if (name === 'documentGeneration') return generation;
    if (name === 'getSourceFormat') return () => 'hwpx';
    if (name === 'borrowDocumentHandle') return () => native;
    if (name === 'getFieldInfoAt') return (p: typeof cursor) => JSON.parse(native.getFieldInfoAt(p.sectionIndex, p.paragraphIndex, p.charOffset));
    // Rendering-only deferred pagination is omitted in this headless engine/history test.
    if (['beginDeferredPagination', 'flushDeferredPagination', 'cancelDeferredPagination'].includes(name)) return undefined;
    const fn = (native as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
    return typeof fn === 'function' ? (...args: unknown[]) => { const value = fn.apply(native, args); return json.has(name) ? JSON.parse(value as string) : value; } : fn;
  } }) as WasmBridge;
  const input = {
    getCursorPosition: () => cursor, getSelection: () => selection,
    async executeDocumentAgentOperation(desc: { operationType: string; operation: (wasm: WasmBridge) => typeof cursor }, render: () => Promise<void>) {
      const command = new SnapshotCommand(desc.operationType, cursor, cursor, desc.operation);
      cursor = history.execute(command, wasm);
      try { await render(); } catch (error) { history.rollbackUncommittedSnapshot(command.type, wasm); throw error; }
      eventBus.emit('document-mutated');
    },
  } as unknown as InputHandler;
  const view = { refreshDocumentAgentMutation: async () => { renders++; if (failRender) throw new Error('injected render failure'); } } as unknown as CanvasView;
  const adapter = new AiDocument(wasm, input, eventBus, view, () => true);
  return { adapter, native, history, wasm, input, eventBus, text: () => native.getTextRange(0, paragraph, 0, native.getParagraphLength(0, paragraph)),
    selectRange: (startParagraph:number,start:number,endParagraph:number,end:number) => { selection={start:{...cursor,paragraphIndex:startParagraph,charOffset:start},end:{...cursor,paragraphIndex:endParagraph,charOffset:end}}; },
    select: (start: number, end: number, endParagraph = 1) => { selection = { start: { ...cursor, paragraphIndex: 1, charOffset: start }, end: { ...cursor, paragraphIndex: endParagraph, charOffset: end } }; },
    move: () => { cursor = { ...cursor, charOffset: 1 }; }, reopen: () => { generation++; }, renders: () => renders, failRender: () => { failRender = true; },
    close: () => { adapter.dispose(); history.clear(wasm); native.free(); } };
}
describe('Achmage actual pinned WASM and upstream history integration', () => {
  it('inserts three lines into the real blank paragraph preserving section/column controls and shared Undo',async()=>{
    const f=fixture('',true);try{const controls=f.native.getControls(),format=f.native.getParaPropertiesAt(0,0),before=f.native.exportHwpx();
      expect(JSON.parse(controls).map((x:{ctrlId:string})=>x.ctrlId)).toEqual(['secd','cold']);
      const c=f.adapter.captureInsertion();expect(c.before).toBe('');await f.adapter.apply(c,'첫 줄의 이야기.\n두 번째 줄 😀.\n마지막 줄.');
      expect(f.text()).toBe('첫 줄의 이야기.\n두 번째 줄 😀.\n마지막 줄.');expect(f.native.getControls()).toBe(controls);expect(f.native.getParaPropertiesAt(0,0)).toBe(format);
      const saved=f.native.exportHwpx(),opened=new HwpDocument(saved);try{expect(opened.getTextRange(0,0,0,opened.getParagraphLength(0,0))).toBe(f.text());expect(JSON.parse(opened.getControls()).map((x:{ctrlId:string})=>x.ctrlId)).toEqual(['secd','cold']);}finally{opened.free();}
      f.history.undo(f.wasm);f.eventBus.emit('document-mutated');expect(f.text()).toBe('');expect(f.native.getControls()).toBe(controls);expect(f.native.exportHwpx()).toEqual(before);
      f.history.redo(f.wasm);expect(f.text()).toContain('두 번째 줄');
    }finally{f.close();}
  });
  it('inserts at caret without replacing existing text and rejects stale selection and grapheme splits',async()=>{
    const f=fixture();try{f.move();const c=f.adapter.captureInsertion();await f.adapter.apply(c,'새 글');expect(f.text()).toBe('한새 글글 😀 é 문단');f.history.undo(f.wasm);f.eventBus.emit('document-mutated');expect(f.text()).toBe('한글 😀 é 문단');const stale=f.adapter.captureInsertion();f.reopen();await expect(f.adapter.apply(stale,'x')).rejects.toThrow();f.select(0,2);expect(()=>f.adapter.captureInsertion()).toThrow('선택 영역');}finally{f.close();}
  });
  it('rolls blank insertion back on render failure and rejects control characters before mutation',async()=>{
    const f=fixture('',true);try{const c=f.adapter.captureInsertion(),controls=f.native.getControls();await expect(f.adapter.apply(c,'a\u0000b')).rejects.toThrow();expect(f.history.canUndo()).toBe(false);f.failRender();await expect(f.adapter.apply(c,'새 글')).rejects.toThrow();expect(f.text()).toBe('');expect(f.native.getControls()).toBe(controls);expect(f.history.canUndo()).toBe(false);}finally{f.close();}
  });
  it('executes the pinned image placement function through shared snapshot Undo/Redo', () => {
    const f=fixture();try {
      const before=f.text(),position={sectionIndex:0,paragraphIndex:1,charOffset:0};
      const data=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1kAAAAASUVORK5CYII=','base64'));
      const context={imagePlacementDrag:{isDragging:false,startClientX:0,startClientY:0},imagePlacementData:{data,ext:'png',fileName:'owned.png',naturalWidth:1,naturalHeight:1},hideImagePlacementOverlay:()=>{},hitTestFromEvent:()=>position,viewportManager:{getZoom:()=>1},container:{querySelector:()=>null,style:{cursor:'crosshair'}},wasm:f.wasm,cursor:{getPosition:()=>position},executeOperation:(desc:{operationType:string;operation:(w:WasmBridge)=>typeof position})=>f.history.execute(new SnapshotCommand(desc.operationType,position,position,desc.operation),f.wasm)};
      finishImagePlacement.call(context,{} as MouseEvent);
      expect(JSON.parse(f.native.getControlTextPositions(0,1))).toHaveLength(1);expect(f.history.canUndo()).toBe(true);
      f.history.undo(f.wasm);expect(JSON.parse(f.native.getControlTextPositions(0,1))).toEqual([]);expect(f.text()).toBe(before);
      f.history.redo(f.wasm);expect(JSON.parse(f.native.getControlTextPositions(0,1))).toHaveLength(1);
    }finally{f.close();}
  });
  it('replaces only the selected Unicode scalar range and shares one Undo', async () => {
    const f = fixture(); try {
      const original = f.text(), format = f.native.getCharPropertiesAt(0, 1, 0);
      f.select(4, 3); const c = f.adapter.captureSelection(); expect(c.before).toBe('😀');
      await f.adapter.apply(c, '별'); expect(f.text()).toBe('한글 별 é 문단');
      expect(f.native.getCharPropertiesAt(0, 1, 0)).toBe(format);
      f.history.undo(f.wasm); f.eventBus.emit('document-mutated'); expect(f.text()).toBe(original);
      f.history.redo(f.wasm); f.eventBus.emit('document-mutated'); expect(f.text()).toBe('한글 별 é 문단');
    } finally { f.close(); }
  });
  it('rejects cross-paragraph, empty, combining-mark and ZWJ boundary splits without mutation', () => {
    const f = fixture(); try {
      for (const [a,b,p] of [[5,6,1],[3,3,1],[0,1,0]]) { f.select(a,b,p); expect(() => f.adapter.captureSelection()).toThrow(); }
      expect(f.history.canUndo()).toBe(false); expect(f.text()).toBe('한글 😀 é 문단');
      expect(() => selectedRange('가👩‍👩‍👧나',1,2)).toThrow();
      expect(selectedRange('가👩‍👩‍👧나',1,6).selected).toBe('👩‍👩‍👧');
    } finally { f.close(); }
  });
  it('keeps range requests bound to the original selection and complete paragraph', async () => {
    const f = fixture(); try {
      f.select(5,7); const c = f.adapter.captureSelection(); f.select(0,2);
      await expect(f.adapter.apply(c,'é')).rejects.toThrow();
      f.select(5,7); const d = f.adapter.captureSelection(); f.native.insertText(0,1,0,'앞');
      await expect(f.adapter.apply(d,'é')).rejects.toThrow(); expect(f.text()).toBe('앞한글 😀 é 문단');
    } finally { f.close(); }
  });
  it('captures without mutation and applies Unicode through one shared Undo/Redo', async () => {
    const f = fixture(); try {
      const before = f.text(), capture = f.adapter.capture(); expect(f.text()).toBe(before);
      await f.adapter.apply(capture, '수정 😀 é 한글'); expect(f.text()).toBe('수정 😀 é 한글'); expect(f.renders()).toBe(1);
      f.history.undo(f.wasm); f.eventBus.emit('document-mutated'); expect(f.text()).toBe(before);
      f.history.redo(f.wasm); f.eventBus.emit('document-mutated'); expect(f.text()).toBe('수정 😀 é 한글');
      const result = f.native.exportHwpxWithReport();
      try { expect(JSON.parse(result.contentLoss()).count).toBe(0); const reopened = new HwpDocument(result.takeBytes()); try { expect(reopened.getTextRange(0, 1, 0, reopened.getParagraphLength(0, 1))).toBe(f.text()); } finally { reopened.free(); } } finally { result.free(); }
    } finally { f.close(); }
  });
  it('rejects selection drift and document replacement', async () => {
    const f = fixture(); try { const c = f.adapter.capture(); f.move(); await expect(f.adapter.apply(c, '변경')).rejects.toThrow(); const d = f.adapter.capture(); f.reopen(); await expect(f.adapter.apply(d, '변경')).rejects.toThrow(); expect(f.text()).toBe('한글 😀 é 문단'); } finally { f.close(); }
  });
  it('rejects replay, native user edit and source mutation without event', async () => {
    const f = fixture(); try { const c = f.adapter.capture(); await f.adapter.apply(c, '한글'); await expect(f.adapter.apply(c, '다시')).rejects.toThrow(); const d = f.adapter.capture(); f.native.insertText(0, 1, 0, '사용자'); await expect(f.adapter.apply(d, '덮어쓰기')).rejects.toThrow(); expect(f.text()).toBe('사용자한글'); } finally { f.close(); }
  });
  it('no-op preserves empty history and rejects control characters before mutation', async () => {
    const f = fixture(); try { const c = f.adapter.capture(); await f.adapter.apply(c, c.before); expect(f.history.canUndo()).toBe(false); await expect(f.adapter.apply(c, '다른\n문단')).rejects.toThrow(); expect(f.text()).toBe(c.before); expect(f.history.canUndo()).toBe(false); } finally { f.close(); }
  });
  it('uses actual upstream history rollback when the headless render boundary fails', async () => {
    const f = fixture(); try { const c = f.adapter.capture(); f.failRender(); await expect(f.adapter.apply(c, '수정')).rejects.toThrow(); expect(f.renders()).toBe(1); expect(f.text()).toBe(c.before); expect(f.history.canUndo()).toBe(false); expect(f.adapter.capture().before).toBe(c.before); } finally { f.close(); }
  });
});


describe('atomic multi-paragraph and mixed-run replacement',()=>{
  const ptext=(f:ReturnType<typeof fixture>,p:number)=>f.native.getTextRange(0,p,0,f.native.getParagraphLength(0,p));
  it('preserves partial endpoints, mixed runs, original paragraph formats, neighboring content and exact Undo/Redo/save reopening',async()=>{
    const f=fixture('가나다ABC');try{
      f.native.splitParagraph(0,1,6);f.native.insertText(0,2,0,'DEF라마바');f.native.splitParagraph(0,2,6);f.native.insertText(0,3,0,'이웃 문단');
      f.native.applyCharFormat(0,1,0,2,JSON.stringify({bold:true}));f.native.applyCharFormat(0,2,4,6,JSON.stringify({italic:true}));
      f.native.applyParaFormat(0,2,JSON.stringify({alignment:2}));
      const before=f.native.exportHwpx(),left=f.native.getCharPropertiesAt(0,1,0),right=f.native.getCharPropertiesAt(0,2,5),para2=f.native.getParaPropertiesAt(0,2),neighbor=f.native.getCharPropertiesAt(0,3,0);
      f.selectRange(1,2,2,4);const c=f.adapter.captureSelection();expect(c.before).toBe('다ABC\nDEF라');
      await f.adapter.apply(c,'새 문장\n다음 문장');
      expect(ptext(f,1)).toBe('가나새 문장');expect(ptext(f,2)).toBe('다음 문장마바');expect(ptext(f,3)).toBe('이웃 문단');
      expect(f.native.getCharPropertiesAt(0,1,0)).toBe(left);expect(f.native.getCharPropertiesAt(0,2,6)).toBe(right);expect(f.native.getParaPropertiesAt(0,2)).toBe(para2);expect(f.native.getCharPropertiesAt(0,3,0)).toBe(neighbor);
      const after=f.native.exportHwpx(),opened=new HwpDocument(after);try{expect(opened.getParagraphCount(0)).toBe(4);expect(opened.getTextRange(0,2,0,7)).toBe('다음 문장마바');expect(opened.getCharPropertiesAt(0,2,6)).toBe(right);}finally{opened.free();}
      f.history.undo(f.wasm);f.eventBus.emit('document-mutated');expect(f.native.exportHwpx()).toEqual(before);expect(f.history.canUndo()).toBe(false);
      f.history.redo(f.wasm);expect(f.native.exportHwpx()).toEqual(after);expect(f.renders()).toBe(1);
    }finally{f.close();}
  });
  it('merges reversed selection across three paragraphs without widening and preserves following picture bytes',async()=>{
    const f=fixture('ABC');try{
      f.native.splitParagraph(0,1,3);f.native.insertText(0,2,0,'DEF');f.native.splitParagraph(0,2,3);f.native.insertText(0,3,0,'GHI');f.native.splitParagraph(0,3,3);f.native.insertText(0,4,0,'그림 옆');
      const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1kAAAAASUVORK5CYII=','base64'));
      f.native.insertPicture(0,4,0,'[]',png,1000,1000,1,1,'png','owned');
      const image=f.native.getControlImageData(0,4,'[]',0),before=f.native.exportHwpx();
      f.selectRange(3,1,1,2);const c=f.adapter.captureSelection();expect(c.before).toBe('C\nDEF\nG');await f.adapter.apply(c,'교체');
      expect(ptext(f,1)).toBe('AB교체HI');expect(f.native.getParagraphCount(0)).toBe(3);expect(f.native.getControlImageData(0,2,'[]',0)).toEqual(image);
      const reopened=new HwpDocument(f.native.exportHwpx());try{expect(reopened.getControlImageData(0,2,'[]',0)).toEqual(image);}finally{reopened.free();}
      f.history.undo(f.wasm);expect(f.native.exportHwpx()).toEqual(before);
    }finally{f.close();}
  });
  it('retains the right suffix paragraph format when replacing three paragraphs with two',async()=>{
    const f=fixture('ABC');try{
      f.native.splitParagraph(0,1,3);f.native.insertText(0,2,0,'DEF');f.native.splitParagraph(0,2,3);f.native.insertText(0,3,0,'GHI');
      f.native.applyParaFormat(0,2,JSON.stringify({alignment:1}));f.native.applyParaFormat(0,3,JSON.stringify({alignment:2}));const right=f.native.getParaPropertiesAt(0,3);
      f.selectRange(1,1,3,2);await f.adapter.apply(f.adapter.captureSelection(),'one\nnext');expect(ptext(f,1)).toBe('Aone');expect(ptext(f,2)).toBe('nextI');expect(f.native.getParaPropertiesAt(0,2)).toBe(right);
    }finally{f.close();}
  });
  it('supports mixed-style single paragraph, extra empty paragraphs and full deletion while preserving section controls',async()=>{
    const f=fixture('ABCD',true);try{
      f.native.applyCharFormat(0,0,2,4,JSON.stringify({bold:true}));const bold=f.native.getCharPropertiesAt(0,0,3),controls=f.native.getControls();
      f.selectRange(0,1,0,3);await f.adapter.apply(f.adapter.captureSelection(),'x\n\ny');expect(f.native.getParagraphCount(0)).toBe(3);expect(ptext(f,0)).toBe('Ax');expect(ptext(f,1)).toBe('');expect(ptext(f,2)).toBe('yD');expect(f.native.getCharPropertiesAt(0,2,1)).toBe(bold);expect(f.native.getControls()).toBe(controls);
      f.selectRange(0,0,2,2);await f.adapter.apply(f.adapter.captureSelection(),'');expect(f.native.getParagraphCount(0)).toBe(1);expect(ptext(f,0)).toBe('');expect(f.native.getControls()).toBe(controls);
    }finally{f.close();}
  });
  it('applies a whole-paragraph capture from a partial selection and undoes it in one step',async()=>{
    const f=fixture('ABC');try{
      f.native.splitParagraph(0,1,3);f.native.insertText(0,2,0,'DEF');f.native.splitParagraph(0,2,3);f.native.insertText(0,3,0,'GHI');
      const before=f.native.exportHwpx();f.selectRange(1,1,2,2);const c=f.adapter.captureSelection({wholeParagraphs:true});expect(c.before).toBe('ABC\nDEF');
      await f.adapter.apply(c,'하나\n둘');expect(ptext(f,1)).toBe('하나');expect(ptext(f,2)).toBe('둘');expect(ptext(f,3)).toBe('GHI');
      f.history.undo(f.wasm);expect(f.native.exportHwpx()).toEqual(before);
    }finally{f.close();}
  });
  it('rejects invalid replies and stale captures and rolls a multi-paragraph mutation back after render failure',async()=>{
    const f=fixture('ABC');try{
      f.native.splitParagraph(0,1,3);f.native.insertText(0,2,0,'DEF');f.selectRange(1,1,2,2);const before=f.native.exportHwpx(),c=f.adapter.captureSelection();
      await expect(f.adapter.apply(c,'bad\rtext')).rejects.toThrow();expect(f.native.exportHwpx()).toEqual(before);expect(f.history.canUndo()).toBe(false);
      f.failRender();await expect(f.adapter.apply(c,'one\ntwo\nthree')).rejects.toThrow('render');expect(f.native.exportHwpx()).toEqual(before);expect(f.history.canUndo()).toBe(false);
      f.reopen();await expect(f.adapter.apply(c,'stale')).rejects.toThrow();
          }finally{f.close();}
  });
  it('formats only the selected characters inside one table cell and keeps the other cells (T10)',async()=>{
    const f=fixture('ABC');try{
      const t=JSON.parse(f.native.createTable(0,1,0,2,2)) as {paraIdx:number;controlIdx:number};
      ['가나다라','다른 셀'].forEach((text,cell)=>f.native.insertTextInCell(0,t.paraIdx,t.controlIdx,cell,0,0,text));
      const cellAt=(charOffset:number)=>({...f.input.getCursorPosition(),sectionIndex:0,paragraphIndex:t.paraIdx,charOffset,parentParaIndex:t.paraIdx,controlIndex:t.controlIdx,cellIndex:0,cellParaIndex:0});
      (f.input as unknown as {getSelection:()=>unknown}).getSelection=()=>({start:cellAt(1),end:cellAt(3)});
      const before=f.native.exportHwpx(),other=f.native.getTextInCell(0,t.paraIdx,t.controlIdx,1,0,0,4);
      expect((await f.adapter.applyTextFormat({bold:true})).chars).toBe(2);
      const bold=(o:number)=>(JSON.parse(f.native.getCellCharPropertiesAt(0,t.paraIdx,t.controlIdx,0,0,o)) as {bold:boolean}).bold;
      expect([0,1,2,3].map(bold)).toEqual([false,true,true,false]);expect(f.native.getTextInCell(0,t.paraIdx,t.controlIdx,1,0,0,4)).toBe(other);
      f.history.undo(f.wasm);expect(f.native.exportHwpx()).toEqual(before);
    }finally{f.close();}
  });
  it('formats only the selected characters of a paragraph and undoes in one step (T10)',async()=>{
    const f=fixture('ABC');try{
      f.native.splitParagraph(0,1,3);f.native.insertText(0,2,0,'DEFGH');f.selectRange(1,1,2,2);
      const before=f.native.exportHwpx(),text=f.native.getTextFileUnicode();
      const r=await f.adapter.applyTextFormat({bold:true,fontSizePt:14});expect(r.chars).toBe(4);
      const bold=(p:number,o:number)=>JSON.parse(f.native.getCharPropertiesAt(0,p,o)) as {bold:boolean;fontSize:number};
      expect([bold(1,0).bold,bold(1,1).bold,bold(1,2).bold,bold(2,0).bold,bold(2,1).bold,bold(2,2).bold]).toEqual([false,true,true,true,true,false]);
      expect(bold(1,1).fontSize).toBe(1400);expect(bold(2,3).fontSize).not.toBe(1400);expect(f.native.getTextFileUnicode()).toBe(text);
      f.history.undo(f.wasm);expect(f.native.exportHwpx()).toEqual(before);
    }finally{f.close();}
  });
  it('edits text around a table inside the selection, keeps the table, and undoes in one step (T10)',async()=>{
    const f=fixture('ABC');try{
      f.native.splitParagraph(0,1,3);f.native.insertText(0,2,0,'DEF');f.native.createTable(0,1,0,2,2);
      const last=f.native.getParagraphCount(0)-1;f.selectRange(1,0,last,f.native.getParagraphLength(0,last));
      const c=f.adapter.captureSelection(),before=f.native.exportHwpx(),controls=f.native.getControls();expect(c.before).toContain('⟦표1⟧');
      await expect(f.adapter.apply(c,c.before.replace('⟦표1⟧',''))).rejects.toThrow('개체');expect(f.native.exportHwpx()).toEqual(before);
      await f.adapter.apply(c,c.before.replace('DEF','DEF 추가'));expect(f.native.getControls()).toBe(controls);
      expect(f.native.getTextRange(0,last,0,f.native.getParagraphLength(0,last))).toBe('DEF 추가');
      const after=f.native.exportHwpx(),reopened=new HwpDocument(after);
      try{expect(reopened.getTextRange(0,last,0,reopened.getParagraphLength(0,last))).toBe('DEF 추가');const ids=(json:string)=>(JSON.parse(json) as {ctrlId:string;para:number}[]).map(x=>x.ctrlId+'@'+x.para);expect(ids(reopened.getControls())).toEqual(ids(controls));}finally{reopened.free();}
      f.history.undo(f.wasm);expect(f.native.exportHwpx()).toEqual(before);
      f.history.redo(f.wasm);expect(f.native.getTextRange(0,last,0,f.native.getParagraphLength(0,last))).toBe('DEF 추가');expect(f.native.getControls()).toBe(controls);
    }finally{f.close();}
  });
});
