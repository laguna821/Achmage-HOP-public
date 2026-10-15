import {describe,it,expect} from 'vitest';
import {runtimeBusy,type RuntimeView} from './runtime-tools';
describe('official runtime status',()=>{
  const view=(phase:string):RuntimeView=>({generation:1,phase,version:null,installed:false,bytes:null,sha512:null,message:''});
  it('keeps cancel visible for all actual job phases',()=>{for(const phase of ['checking','downloading','cancelling'])expect(runtimeBusy(view(phase))).toBe(true);});
  it('does not invent installation or login progress from idle/error/ready',()=>{for(const phase of ['idle','ready','error','cancelled'])expect(runtimeBusy(view(phase))).toBe(false);expect(runtimeBusy(null)).toBe(false);});
});
