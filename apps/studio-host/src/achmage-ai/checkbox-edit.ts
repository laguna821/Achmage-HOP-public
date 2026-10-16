import type { WasmBridge } from '@/upstream/core';
type FormObjectHitResult = ReturnType<WasmBridge['getFormObjectAt']>;

/** Only an explicit all-checkbox clearing command; quoted examples/questions/negations never mutate. */
export function asksToClearCheckboxes(text: string): boolean {
  if (/[`"“”‘’\n?？]/u.test(text) || /말|않|아니|방법|가능|설명|알려|제외|빼고|선택한|이\s*표|이\s*쪽/u.test(text)) return false;
  return /체크\s*박스/u.test(text) && /전부|모두|모든|전체|싹\s*다/u.test(text)
    && /(?:해제|풀어)\s*(?:해\s*)?(?:줘|주세요|봐|해봐|해줘|해주세요|하자|해라)[.!\s]*$/u.test(text);
}
type Target = FormObjectHitResult & { page: number; x: number; y: number };
function key(t: FormObjectHitResult): string { return JSON.stringify([t.sec,t.para,t.ci,t.inCell,t.tablePara,t.tableCi,t.cellIdx,t.cellPara]); }
function valid(t: FormObjectHitResult): boolean {
  const ids = [t.sec,t.para,t.ci,...(t.inCell ? [t.tablePara,t.tableCi,t.cellIdx,t.cellPara] : [])];
  return ids.every(n => Number.isSafeInteger(n) && n! >= 0);
}
/** Enumerate rendered interactive forms. Never guess a source address from text or layout order. */
export function checkboxTargets(wasm: WasmBridge): Target[] {
  const doc = wasm.borrowDocumentHandle();
  if (!doc || wasm.pageCount < 1) throw Error('열린 문서가 없습니다.');
  if (wasm.pageCount > 1000) throw Error('체크박스 확인 범위가 너무 큽니다.');
  const targets = new Map<string,Target>();
  let visited=0;
  const walk = (node: any, page: number, depth=0): void => {
    if (++visited>500_000 || depth>64) throw Error('문서 개체 구조를 확인하지 못했습니다.');
    if (node.type==='Form') {
      const b=node.bbox;
      if (!b || ![b.x,b.y,b.w,b.h].every(Number.isFinite) || b.w<=0 || b.h<=0) throw Error('양식 개체 위치를 확인하지 못했습니다.');
      const x=b.x+b.w/2,y=b.y+b.h/2,t=wasm.getFormObjectAt(page,x,y);
      if (!t.found || !valid(t)) throw Error('양식 개체의 원본 위치를 확인하지 못했습니다.');
      if (t.formType==='CheckBox') targets.set(key(t),{...t,page,x,y});
    }
    for(const child of node.children??[]) walk(child,page,depth+1);
  };
  for(let page=0;page<wasm.pageCount;page++) walk(JSON.parse(doc.getPageRenderTree(page)),page);
  return [...targets.values()];
}
export function clearCheckboxTargets(wasm: WasmBridge, targets: readonly Target[]): number {
  for (const t of targets) {
    const now=wasm.getFormObjectAt(t.page,t.x,t.y);
    if(key(now)!==key(t)||now.formType!=='CheckBox'||now.value!==t.value) throw Error('체크박스 상태가 바뀌었습니다. 다시 요청해 주세요.');
  }
  let changed=0;
  for(const t of targets.filter(t=>t.value!==0)) {
    const value='{"value":0}';
    const result=t.inCell ? wasm.setFormValueInCell(t.sec!,t.tablePara!,t.tableCi!,t.cellIdx!,t.cellPara!,t.ci!,value) : wasm.setFormValue(t.sec!,t.para!,t.ci!,value);
    if(!result.ok) throw Error('체크박스를 해제하지 못했습니다.');
    changed++;
  }
  const after=checkboxTargets(wasm);
  if(after.length!==targets.length||after.some(t=>t.value!==0)||after.some(t=>!targets.some(old=>key(old)===key(t)))) throw Error('체크박스 변경 결과를 검증하지 못했습니다.');
  return changed;
}
