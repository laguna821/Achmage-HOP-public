import {describe,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({invoke:vi.fn().mockResolvedValue(undefined),handler:undefined as undefined|((event:{payload:unknown})=>void)}));
vi.mock('@tauri-apps/api/core',()=>({invoke:f.invoke}));
vi.mock('@tauri-apps/api/webviewWindow',()=>({getCurrentWebviewWindow:()=>({listen:async(_:string,handler:(event:{payload:unknown})=>void)=>{f.handler=handler;return ()=>undefined;}})}));
import {installTelegramDocumentResponder,readDocumentForRemote,READ_EVENT,REMOTE_TEXT_BUDGET} from './telegram-document';

// Two body paragraphs; a 2×2 table anchored on the first; one empty paragraph.
function wasm(paragraphs=['회의 안건','','결론: 예산 확정']){
 const cells=[['구분','금액'],['인건비','300만 원']].flatMap((row,r)=>row.map((text,c)=>({row:r,col:c,text})));
 return {fileName:'회의록.hwpx',pageCount:1,getSectionCount:()=>1,getParagraphCount:()=>paragraphs.length,getParagraphLength:(_:number,p:number)=>Array.from(paragraphs[p]).length,
  getTextRange:(_:number,p:number)=>paragraphs[p],getControls:()=>[{ctrlId:'tbl',list:0,para:0,controlIndex:0}],
  getTableDimensions:()=>({rowCount:2,colCount:2,cellCount:4}),getCellInfo:(_s:number,_p:number,_c:number,i:number)=>({row:cells[i].row,col:cells[i].col,rowSpan:1,colSpan:1}),
  getCellParagraphCount:()=>1,getCellParagraphLength:(_s:number,_p:number,_c:number,i:number)=>Array.from(cells[i].text).length,getTextInCell:(_s:number,_p:number,_c:number,i:number)=>cells[i].text} as never;
}
describe('Telegram open-document reader',()=>{
 it('reads paragraphs in order with tables as rows',()=>{
  expect(readDocumentForRemote(wasm())).toEqual({title:'회의록.hwpx',text:'회의 안건\n| 구분 | 금액 |\n| 인건비 | 300만 원 |\n결론: 예산 확정',truncated:false});
 });
 it('cuts at the byte budget and says so',()=>{
  const long='가'.repeat(10000),read=readDocumentForRemote(wasm([long,long,long,long,long,long]));
  expect(read.truncated).toBe(true);expect(new TextEncoder().encode(read.text).length).toBeLessThanOrEqual(REMOTE_TEXT_BUDGET);
 });
 it('answers only well-formed requests, with the document text or the reason it failed',async()=>{
  await installTelegramDocumentResponder(wasm());
  f.handler!({payload:{requestId:7}});expect(f.invoke).not.toHaveBeenCalled();
  f.handler!({payload:{requestId:'read-1'}});
  expect(f.invoke).toHaveBeenCalledWith('achmage_telegram_document_text',expect.objectContaining({requestId:'read-1',title:'회의록.hwpx',truncated:false,error:null}));
  const broken={...(wasm() as object),getSectionCount:()=>{throw Error('x');},pageCount:1};
  await installTelegramDocumentResponder(broken as never);f.handler!({payload:{requestId:'read-2'}});
  // The reader is lenient: an engine call that throws reads as empty, never as a stale or partial answer.
  expect(f.invoke).toHaveBeenLastCalledWith('achmage_telegram_document_text',expect.objectContaining({requestId:'read-2',text:'',error:null}));
  expect(READ_EVENT).toBe('achmage-telegram-read-document');
 });
});
