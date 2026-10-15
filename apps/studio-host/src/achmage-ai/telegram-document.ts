import type {WasmBridge} from '@/upstream/core';

/**
 * Answers the Telegram gateway when the owner asks about the document open in this window. Read-only
 * and lenient (like the request router's state card): body paragraphs in reading order and table
 * cells row by row, cut at a byte budget. The native side accepts the reply only from the window it asked.
 */
type Wasm = Pick<WasmBridge, 'pageCount' | 'getSectionCount' | 'getParagraphCount' | 'getParagraphLength' | 'getTextRange' | 'getControls'> & Partial<Pick<WasmBridge, 'getTableDimensions' | 'getCellInfo' | 'getCellParagraphCount' | 'getCellParagraphLength' | 'getTextInCell'>>;
export interface RemoteDocumentText { title: string; text: string; truncated: boolean }
export const READ_EVENT = 'achmage-telegram-read-document';
export const REMOTE_TEXT_BUDGET = 48 * 1024;
const attempt = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };

function tableRows(wasm: Wasm, section: number, paragraph: number, controlIndex: number): string[] {
  if (!wasm.getTableDimensions || !wasm.getCellInfo || !wasm.getCellParagraphCount || !wasm.getCellParagraphLength || !wasm.getTextInCell) return ['[표]'];
  return attempt(() => {
    const d = wasm.getTableDimensions!(section, paragraph, controlIndex), rows = new Map<number, Array<{ col: number; text: string }>>();
    for (let cell = 0; cell < d.cellCount; cell++) {
      const info = wasm.getCellInfo!(section, paragraph, controlIndex, cell), parts: string[] = [];
      const count = wasm.getCellParagraphCount!(section, paragraph, controlIndex, cell);
      for (let p = 0; p < count; p++) {
        const length = wasm.getCellParagraphLength!(section, paragraph, controlIndex, cell, p);
        const text = length ? wasm.getTextInCell!(section, paragraph, controlIndex, cell, p, 0, length).trim() : '';
        if (text) parts.push(text);
      }
      rows.set(info.row, [...(rows.get(info.row) ?? []), { col: info.col, text: parts.join(' / ') }]);
    }
    return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, cells]) => '| ' + cells.sort((a, b) => a.col - b.col).map(c => c.text.replaceAll('|', '¦')).join(' | ') + ' |');
  }, ['[표]']);
}

export function readDocumentForRemote(wasm: Wasm & { fileName?: unknown }): RemoteDocumentText {
  const title = typeof wasm.fileName === 'string' && wasm.fileName.trim() ? wasm.fileName.trim() : '제목 없음';
  const result: RemoteDocumentText = { title, text: '', truncated: false };
  if (!(wasm.pageCount > 0)) return result;
  const tables = new Map<number, number[]>();
  for (const c of attempt(() => wasm.getControls(), [])) if (c.ctrlId === 'tbl' && c.list === 0) tables.set(c.para, [...(tables.get(c.para) ?? []), c.controlIndex]);
  const lines: string[] = [], encoder = new TextEncoder(); let bytes = 0, global = 0;
  const push = (line: string) => {
    if (result.truncated) return;
    const size = encoder.encode(line).length + 1;
    if (bytes + size > REMOTE_TEXT_BUDGET) { result.truncated = true; return; }
    bytes += size; lines.push(line);
  };
  const sections = attempt(() => wasm.getSectionCount(), 0);
  for (let s = 0; s < sections && !result.truncated; s++) {
    const count = attempt(() => wasm.getParagraphCount(s), 0);
    for (let p = 0; p < count && !result.truncated; p++, global++) {
      const length = attempt(() => wasm.getParagraphLength(s, p), 0);
      const text = length ? attempt(() => wasm.getTextRange(s, p, 0, length), '') : '';
      if (text.trim()) push(text);
      for (const controlIndex of tables.get(global) ?? []) for (const row of tableRows(wasm, s, p, controlIndex)) push(row);
    }
  }
  result.text = lines.join('\n');
  return result;
}

/** Registers the responder for this window; returns the unlisten function. */
export async function installTelegramDocumentResponder(wasm: Wasm & { fileName?: unknown }): Promise<() => void> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  return getCurrentWebviewWindow().listen<{ requestId?: unknown }>(READ_EVENT, event => {
    const requestId = event.payload?.requestId;
    if (typeof requestId !== 'string' || requestId.length > 64) return;
    let reply: Record<string, unknown>;
    try {
      const read = readDocumentForRemote(wasm);
      reply = { requestId, title: read.title, text: read.text, truncated: read.truncated, error: null };
    } catch (error) {
      reply = { requestId, title: '', text: null, truncated: false, error: error instanceof Error ? error.message : '문서를 읽지 못했습니다.' };
    }
    void invoke('achmage_telegram_document_text', reply).catch(() => undefined);
  });
}
