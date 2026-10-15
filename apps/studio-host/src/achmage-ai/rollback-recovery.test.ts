/// <reference types="node" />
// When an edit fails and the engine's own rollback fails too, the document is partly changed. The copy taken
// just before the edit must reach a new window, unchanged, and the message must say which window to keep.
import { describe, expect, it } from 'vitest';
import { HwpDocument } from '../../vendor/rhwp-core/rhwp.js';
import { bodyDocument, historyHarness } from './test-support/history-harness';
import { RollbackFailed } from './document';

const text = (bytes: Uint8Array) => { const d = new HwpDocument(bytes); try { return d.getTextFileUnicode(); } finally { d.free(); } };

describe('rollback failure recovery (actual pinned engine and upstream history)', () => {
  it('opens the document as it was before the edit when the edit and its rollback both fail', async () => {
    const recovered: Uint8Array[] = [];
    const h = historyHarness(bodyDocument(['첫째 문단', '둘째 문단']), { recover: async bytes => { recovered.push(bytes); } });
    try {
      const before = h.native.getTextFileUnicode(), charsBefore = JSON.stringify(h.native.getCharPropertiesAt(0, 0, 0));
      h.select(0, 0, 0, 2); h.failRender(); h.failRestore();
      const error = await h.adapter.applyTextFormat({ bold: true }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RollbackFailed);
      expect((error as Error).message).toContain('편집 전 문서를 새 창에 열었습니다');
      expect(recovered).toHaveLength(1);
      expect(text(recovered[0])).toBe(before);
      const copy = new HwpDocument(recovered[0]);
      try { expect(JSON.stringify(copy.getCharPropertiesAt(0, 0, 0))).toBe(charsBefore); } finally { copy.free(); }
      // The partly changed window stays blocked for further AI edits.
      expect(() => h.adapter.captureSelection()).toThrow('문서 복구 상태를 확인하지 못했습니다');
    } finally { h.close(); }
  });

  it('says so when the copy cannot be opened either', async () => {
    const h = historyHarness(bodyDocument(['첫째 문단']), { recover: async () => { throw new Error('no window'); } });
    try {
      h.select(0, 0, 0, 2); h.failRender(); h.failRestore();
      await expect(h.adapter.applyTextFormat({ bold: true })).rejects.toThrow('편집 전 문서를 새 창에 열지 못했습니다');
    } finally { h.close(); }
  });

  it('opens nothing when the engine rolls the failed edit back itself', async () => {
    const recovered: Uint8Array[] = [];
    const h = historyHarness(bodyDocument(['첫째 문단']), { recover: async bytes => { recovered.push(bytes); } });
    try {
      h.select(0, 0, 0, 2); h.failRender();
      await expect(h.adapter.applyTextFormat({ bold: true })).rejects.toThrow('injected render failure');
      expect(recovered).toHaveLength(0);
    } finally { h.close(); }
  });

  it('never writes an unencrypted copy of a password-protected document', async () => {
    const recovered: Uint8Array[] = [];
    const h = historyHarness(bodyDocument(['첫째 문단']), { recover: async bytes => { recovered.push(bytes); }, password: true });
    try {
      h.select(0, 0, 0, 2); h.failRender(); h.failRestore();
      const error = await h.adapter.applyTextFormat({ bold: true }).catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(RollbackFailed);
      expect(recovered).toHaveLength(0);
    } finally { h.close(); }
  });
});
