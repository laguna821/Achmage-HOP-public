/// <reference types="node" />
import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {HwpDocument} from '../../vendor/rhwp-core/rhwp.js';
import {SnapshotCommand} from '@upstream/engine/command';
import {CommandHistory} from '@upstream/engine/history';
import type {WasmBridge} from '@/upstream/core';
import {initPinnedEngine} from './test-support/pinned-wasm';
import {checkboxTargets,clearCheckboxTargets} from './checkbox-edit';
initPinnedEngine();
function bridge(native:HwpDocument):WasmBridge {
 return new Proxy({}, {get(_t,name:string){
  if(name==='pageCount')return native.pageCount();
  if(name==='borrowDocumentHandle')return ()=>native;
  const fn=(native as any)[name];return typeof fn==='function'?(...args:any[])=>{
   const v=fn.apply(native,args);return ['getFormObjectAt','setFormValue','setFormValueInCell'].includes(name)?JSON.parse(v):v;
  }:fn;
 }}) as WasmBridge;
}
describe('checkbox commands',()=>{
 for(const sample of ['form-01.hwp','hwpx/form-002.hwpx']) it(`native checkbox changes preserve text and undo: ${sample}`,()=>{
  const native=new HwpDocument(readFileSync(new URL('../../../../third_party/rhwp/samples/'+sample,import.meta.url))),wasm=bridge(native);
  try {
   let targets=checkboxTargets(wasm);expect(targets.length).toBeGreaterThan(0);
   for(const t of targets){const v='{"value":1}';if(t.inCell)wasm.setFormValueInCell(t.sec!,t.tablePara!,t.tableCi!,t.cellIdx!,t.cellPara!,t.ci!,v);else wasm.setFormValue(t.sec!,t.para!,t.ci!,v);}
   targets=checkboxTargets(wasm);expect(targets.every(t=>t.value===1)).toBe(true);
   const before=native.exportHwpx(),controls=native.getControls(),text=native.getTextFileUnicode(),history=new CommandHistory(),cursor={sectionIndex:0,paragraphIndex:0,charOffset:0};
   history.execute(new SnapshotCommand('checkbox-test',cursor,cursor,w=>{expect(clearCheckboxTargets(w,targets)).toBe(targets.length);return cursor;}),wasm);
   expect(checkboxTargets(wasm).every(t=>t.value===0)).toBe(true);
   expect(native.getControls()).toBe(controls);expect(native.getTextFileUnicode()).toBe(text);
   const reopened=new HwpDocument(native.exportHwpx());try{expect(checkboxTargets(bridge(reopened)).every(t=>t.value===0)).toBe(true);}finally{reopened.free();}
   expect(clearCheckboxTargets(wasm,checkboxTargets(wasm))).toBe(0);
   history.undo(wasm);expect(native.exportHwpx()).toEqual(before);
  }finally{native.free();}
 });
});
