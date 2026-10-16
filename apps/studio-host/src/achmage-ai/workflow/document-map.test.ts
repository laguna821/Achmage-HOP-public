import {describe,it,expect} from 'vitest';
import {HwpDocument} from '../../../vendor/rhwp-core/rhwp.js';
import {bodyDocument} from '../test-support/history-harness';
import {DocumentMap} from './document-map';
describe('document inspection',()=>{
 it('finds an unselected field and its empty input cell, without inventing addresses',()=>{
  const d=new HwpDocument(bodyDocument(['신청서','']));try{
   const t=JSON.parse(d.createTable(0,1,0,2,2));d.insertTextInCell(0,t.paraIdx,t.controlIdx,0,0,0,'수업개요');
   const m=new DocumentMap(d,'v1'),r=m.read({query:'수업개요'});
   expect(r.nodes.some(n=>n.kind==='cell'&&n.col===1&&n.text==='')).toBe(true);
   expect(()=>m.target('v0:3')).toThrow();expect(r.nodes.every(n=>n.address===undefined)).toBe(true);
  }finally{d.free();}
 });
 it('paginates large text with explicit coverage and refuses an unread target',()=>{
  const d=new HwpDocument(bodyDocument(['가'.repeat(50_000),'마지막']));try{
   const m=new DocumentMap(d,'v'),r=m.read();expect(r.nodes[0].complete).toBe(false);expect(()=>m.target(r.nodes[0].id)).toThrow();
   expect(m.read({query:'마지막'}).nodes.some(n=>n.text==='마지막')).toBe(true);
   expect(m.read({ids:[r.nodes[0].id],start:49_000}).nodes[0].text).toHaveLength(1000);
  }finally{d.free();}
 });
});
