import type {AiDocument} from '../document';
import type {RhwpDocumentStateV1} from '@/upstream/document-agent';
import type {WasmBridge} from '@/upstream/core';
import {DocumentMap,type Handle,type ReadRequest} from './document-map';
import {executePrepared,prepareText,prepareFormat,type PreparedOperation,type TextChange} from './edits';
/** All model writes are rehearsed on a private engine. Only commit mutates the editor. */
export class WorkflowDraft {
 readonly engine:Handle;
 map:DocumentMap;
 private operations:PreparedOperation[]=[];
 private sequence=0;
 private closed=false;
 private committed=false;
 readonly id=crypto.randomUUID();
 constructor(readonly source:WasmBridge,readonly identity:RhwpDocumentStateV1){
  const live=source.borrowDocumentHandle();if(!live)throw Error('열린 문서가 없습니다.');
  const Constructor=live.constructor as new(bytes:Uint8Array)=>Handle;
  this.engine=new Constructor(live.exportHwpx());this.map=new DocumentMap(this.engine,`${this.id}.0`);
 }
 read(req:ReadRequest={}) {this.assertOpen();return this.map.read(req);}
 edit(changes:TextChange[]) {return this.stage(prepareText(this.map,changes));}
 format(ids:string[],format:unknown) {return this.stage(prepareFormat(this.map,ids,format));}
 private stage(op:PreparedOperation){
  this.assertOpen();const snapshot=this.engine.saveSnapshot();
  try{executePrepared(this.engine,op);const map=new DocumentMap(this.engine,`${this.id}.${this.sequence+1}`);this.operations.push(op);this.sequence++;this.map=map;return {staged:true,operationCount:this.operations.length,revision:this.map.revision,message:'임시본에서 검증했습니다. finish 전에는 원문이 바뀌지 않습니다.'};}
  catch(error){this.engine.restoreSnapshot(snapshot);throw error;}finally{this.engine.discardSnapshot(snapshot);}
 }
 get pending(){return this.operations.length;}
 async commit(doc:AiDocument){
  this.assertOpen();if(this.committed)throw Error('이미 반영한 요청입니다.');
  const expected=this.map.fingerprint(),operations=[...this.operations];
  if(!operations.length)return {changed:0,message:'문서는 변경하지 않았습니다.'};
  await doc.applyWorkflow(this.identity,wasm=>{
   const engine=wasm.borrowDocumentHandle();if(!engine)throw Error('문서를 다시 여세요.');
   for(const op of operations)executePrepared(engine,op);
   if(new DocumentMap(engine,'verify').fingerprint()!==expected)throw Error('실제 편집 결과가 검증한 임시본과 다릅니다.');
  });
  this.committed=true;
  return {changed:operations.reduce((n,op)=>n+op.nodes.length,0),message:'요청한 변경을 반영하고 결과를 확인했습니다. Ctrl+Z 한 번으로 되돌릴 수 있습니다.'};
 }
 private assertOpen(){if(this.closed)throw Error('종료된 작업입니다. 다시 요청하세요.');}
 close(){if(!this.closed){this.closed=true;this.engine.free();}}
}
