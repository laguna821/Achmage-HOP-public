import { describe, it, expect, vi } from 'vitest';
import { InlineRequest, selectsWholeDocument } from './inline';
import type { ParagraphCapture } from './document';
const capture = { before:'선택', command:{}, selection:'fixed' } as ParagraphCapture;
describe('inline shared request boundary', () => {
  it('dispatches exact capture and explicit instruction once', () => { const send=vi.fn(), doc={captureSelection:()=>capture,isCurrent:()=>true}; const r=new InlineRequest(doc,send); expect(r.open()).toBe('선택'); r.submit('  간결하게  '); expect(send).toHaveBeenCalledWith(capture,'간결하게'); expect(()=>r.submit('다시')).toThrow(); });
  it('rejects stale, composing, empty and cancelled requests without dispatch', () => { const send=vi.fn(); let current=true; const r=new InlineRequest({captureSelection:()=>capture,isCurrent:()=>current},send); r.open(); expect(()=>r.submit('요청',true)).toThrow(); expect(()=>r.submit(' ')).toThrow(); current=false; expect(()=>r.submit('요청')).toThrow(); current=true;r.cancel();expect(()=>r.submit('요청')).toThrow();expect(send).not.toHaveBeenCalled(); });
  it('uses the capture prepared when the context menu opened, without recapturing a later selection',()=>{const send=vi.fn(),read=vi.fn(()=>capture);let current=true;const r=new InlineRequest({captureSelection:read,isCurrent:()=>current},send);r.open();expect(r.preparedText()).toBe('선택');expect(read).toHaveBeenCalledOnce();current=false;expect(()=>r.preparedText()).toThrow('바뀌');expect(()=>r.submit('변경')).toThrow('바뀌');expect(send).not.toHaveBeenCalled();});
  it('preserves multiline selection text and capture metadata through the shared dispatch',()=>{const selected={...capture,before:'첫 문단 선택\n둘째 문단 선택'},send=vi.fn(),r=new InlineRequest({captureSelection:()=>selected,isCurrent:()=>true},send);expect(r.open()).toBe(selected.before);r.submit('두 문단을 다듬어 주세요');expect(send).toHaveBeenCalledWith(selected,'두 문단을 다듬어 주세요');});
  it('recognizes Ctrl+A of a single-section document in either drag direction, but not a partial or multi-section selection',()=>{
    const wasm={getSectionCount:()=>1,getParagraphCount:()=>20,getParagraphLength:(_s:number,p:number)=>p===19?7:3};
    const at=(paragraphIndex:number,charOffset:number)=>({sectionIndex:0,paragraphIndex,charOffset});
    expect(selectsWholeDocument(wasm,{start:at(0,0),end:at(19,7)} as never)).toBe(true);
    expect(selectsWholeDocument(wasm,{start:at(19,7),end:at(0,0)} as never)).toBe(true);
    expect(selectsWholeDocument(wasm,{start:at(0,1),end:at(19,7)} as never)).toBe(false);
    expect(selectsWholeDocument(wasm,{start:at(0,0),end:at(18,3)} as never)).toBe(false);
    expect(selectsWholeDocument({...wasm,getSectionCount:()=>2},{start:at(0,0),end:at(19,7)} as never)).toBe(false);
    expect(selectsWholeDocument(wasm,{start:{...at(0,0),parentParaIndex:3},end:at(19,7)} as never)).toBe(false);
    expect(selectsWholeDocument(wasm,null)).toBe(false);
  });
});