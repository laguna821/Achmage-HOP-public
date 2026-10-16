/// <reference types="node" />
// Shared test harness: the pinned rhwp WASM document, the real upstream CommandHistory and AiDocument,
// with only rendering replaced. Test-only; never imported by product code.
import { readFileSync } from 'node:fs';
import { HwpDocument } from '../../../vendor/rhwp-core/rhwp.js';
import { EventBus } from '@/upstream/core';
import { CommandHistory, SnapshotCommand } from '@/upstream/editor';
import type { WasmBridge } from '@/upstream/core';
import type { InputHandler } from '@/upstream/editor';
import type { CanvasView } from '@/upstream/view';
import { AiDocument } from '../document';
import { initPinnedEngine } from './pinned-wasm';

initPinnedEngine();

export const fixtureBytes = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
const JSON_METHODS = new Set(['getControlTextPositions', 'getCharPropertiesAt', 'getParaPropertiesAt', 'getStyleAt', 'replaceText', 'getPageOfPosition', 'getPageDef', 'insertPicture', 'getControls', 'getTableDimensions', 'getCellInfo', 'createTable', 'getCellParaPropertiesAt', 'getCellCharPropertiesAt', 'getTableProperties', 'getCellOwnProperties', 'getPictureProperties']);
type Position = ReturnType<InputHandler['getCursorPosition']>;

/** `recover` and `password` reach AiDocument's rollback-failure path; `failRestore()` makes snapshot restores throw. */
export function historyHarness(bytes: Uint8Array, options: { recover?: (bytes: Uint8Array) => Promise<void>; password?: boolean } = {}) {
  const native = new HwpDocument(bytes), history = new CommandHistory(), bus = new EventBus();
  let cursor: Position = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }, generation = 1, failRender = false, failRestore = false;
  let selection: { start: Position; end: Position } | null = null;
  const wasm = new Proxy({}, { get(_t, name: string) {
    if (name === 'pageCount') return native.pageCount();
    if (name === 'requiresPasswordForSave') return options.password === true;
    if (name === 'restoreSnapshot' && failRestore) return () => { throw new Error('injected restore failure'); };
    if (name === 'documentGeneration') return generation;
    if (name === 'getSourceFormat') return () => 'hwpx';
    if (name === 'borrowDocumentHandle') return () => native;
    if (name === 'getFieldInfoAt') return (p: Position) => JSON.parse(p.parentParaIndex === undefined ? native.getFieldInfoAt(p.sectionIndex, p.paragraphIndex, p.charOffset) : native.getFieldInfoAtInCell(p.sectionIndex, p.parentParaIndex, p.controlIndex!, p.cellIndex!, p.cellParaIndex!, p.charOffset, false));
    // Rendering-only deferred pagination is omitted in this headless engine/history harness.
    if (['beginDeferredPagination', 'flushDeferredPagination', 'cancelDeferredPagination'].includes(name)) return undefined;
    const fn = (native as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
    return typeof fn === 'function' ? (...args: unknown[]) => { const value = fn.apply(native, args); return JSON_METHODS.has(name) ? JSON.parse(value as string) : value; } : fn;
  } }) as WasmBridge;
  const input = {
    getCursorPosition: () => cursor, getSelection: () => selection,
    async executeDocumentAgentOperation(d: { operationType: string; operation: (w: WasmBridge) => Position }, render: () => Promise<void>) {
      const command = new SnapshotCommand(d.operationType, cursor, cursor, d.operation);
      cursor = history.execute(command, wasm);
      try { await render(); } catch (error) { const restored = history.rollbackUncommittedSnapshot(command.type, wasm); if (restored) cursor = restored; throw error; }
      bus.emit('document-mutated');
    },
  } as unknown as InputHandler;
  const view = { refreshDocumentAgentMutation: async () => { if (failRender) throw new Error('injected render failure'); } } as unknown as CanvasView;
  const adapter = new AiDocument(wasm, input, bus, view, () => true, options.recover);
  const at = (paragraphIndex: number, charOffset: number): Position => ({ sectionIndex: 0, paragraphIndex, charOffset });
  return {
    native, wasm, history, adapter,
    /** Undo stack depth, read by undoing on a copy-free path: count steps, then redo them back. */
    depth() { let n = 0; while (history.canUndo()) { history.undo(wasm); n++; } for (let i = 0; i < n; i++) history.redo(wasm); bus.emit('document-mutated'); return n; },
    select(startParagraph: number, start: number, endParagraph: number, end: number) { selection = { start: at(startParagraph, start), end: at(endParagraph, end) }; cursor = at(endParagraph, end); },
    cellCaret(position: Position) { selection = null; cursor = {...position}; },
    caret(paragraph: number, offset: number) { selection = null; cursor = at(paragraph, offset); },
    undo() { const r = history.undo(wasm); if (r) cursor = r; bus.emit('document-mutated'); },
    redo() { const r = history.redo(wasm); if (r) cursor = r; bus.emit('document-mutated'); },
    reopen() { generation++; },
    failRender() { failRender = true; },
    failRestore() { failRestore = true; },
    close() { adapter.dispose(); history.clear(wasm); native.free(); },
  };
}

/** Owned blank form with the given body paragraphs typed in (section and column controls stay in paragraph 0). */
export function bodyDocument(paragraphs: string[]): Uint8Array {
  const d = new HwpDocument(fixtureBytes('owned-blank.hwpx'));
  try {
    paragraphs.forEach((text, i) => { if (i > 0) d.splitParagraph(0, i - 1, d.getParagraphLength(0, i - 1)); d.insertText(0, i, 0, text); });
    return d.exportHwpx();
  } finally { d.free(); }
}
