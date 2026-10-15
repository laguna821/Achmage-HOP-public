import type { WasmBridge } from '@/upstream/core';
import { beginStructuredInsertion, verifyStructuredInsertion, type StructuredCapture } from './structured-edit';

/** Explicit source selection only; omission imports the entire source section.
 * A rejected first paragraph is never stripped or silently skipped. */
export interface ImportSourceRange { start:number; end:number }
type Handle=NonNullable<ReturnType<WasmBridge['borrowDocumentHandle']>>;
export function prepareImportedDocument(wasm:WasmBridge,capture:StructuredCapture,bytes:Uint8Array,range?:ImportSourceRange){
  if(!capture.insertion)throw Error('문서 가져오기는 명시한 커서 삽입 위치가 필요합니다.');
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>32*1024*1024)throw Error('가져올 문서는 32MiB 이내여야 합니다.');
  const target=wasm.borrowDocumentHandle();if(!target)throw Error('문서를 먼저 여세요.');
  const Constructor=target.constructor as new(bytes:Uint8Array)=>Handle;
  const source=new Constructor(bytes.slice());
  try{
    if(source.getSectionCount()!==1)throw Error('한 구역의 생성 문서만 가져올 수 있습니다.');
    const count=source.getParagraphCount(0),start=range?.start??0,end=range?.end??count;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>count||end-start>256)throw Error('가져올 원문 문단 범위가 올바르지 않습니다.');
    const request={sourceSection:0,sourceStart:start,sourceEnd:end,targetSection:0,insertBefore:capture.range.startParagraph,count:1};
    const parseResult=(raw:string)=>{
      const result=JSON.parse(raw) as {operationResult?:{action?:string;result?:{inserted?:{start:number;end:number}}}};
      const inserted=result.operationResult?.result?.inserted;
      if(result.operationResult?.action!=='import_paragraph_block'||inserted?.start!==request.insertBefore||inserted.end-inserted.start!==end-start)throw Error('문서 가져오기 결과 범위가 일치하지 않습니다.');
      return result;
    };
    const preview=parseResult(target.importParagraphBlock(source,JSON.stringify({request,dryRun:true})));
    return {preview,sourceRange:{start,end},close:()=>source.free(),execute:()=>{
      const index=beginStructuredInsertion(wasm,capture);if(index!==request.insertBefore)throw Error('삽입 위치가 바뀌었습니다.');
      parseResult(target.importParagraphBlock(source,JSON.stringify({request})));
      verifyStructuredInsertion(wasm,capture,end-start);
      for(let i=start;i<end;i++){
        const targetIndex=index+i-start,expected=source.getTextRange(0,i,0,source.getParagraphLength(0,i));
        if(wasm.getTextRange(0,targetIndex,0,wasm.getParagraphLength(0,targetIndex))!==expected)throw Error('가져온 본문이 원문과 다릅니다.');
      }
      return {sectionIndex:0,paragraphIndex:index+end-start-1,charOffset:wasm.getParagraphLength(0,index+end-start-1)};
    }};
  }catch(error){source.free();throw error;}
}
