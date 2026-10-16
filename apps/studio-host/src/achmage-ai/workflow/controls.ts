import {checkboxTargets} from '../checkbox-edit';
import {bridgeFor,DocumentMap,type DocNode,type Handle} from './document-map';
import type {ToolCall} from './protocol';
type TableCall=Extract<ToolCall,{tool:'table'}>;
export type ControlOperation={kind:'table';node:DocNode;call:TableCall}|{kind:'checkbox';checked:boolean;table?:DocNode;before:string;changed:number};
const tableKey=(t:ReturnType<typeof checkboxTargets>[number])=>JSON.stringify([t.sec,t.para,t.ci,t.inCell,t.tablePara,t.tableCi,t.cellIdx,t.cellPara]);
const within=(t:ReturnType<typeof checkboxTargets>[number],node?:DocNode)=>!node||t.inCell&&t.sec===node.address.section&&t.tablePara===node.address.paragraph&&t.tableCi===node.address.control;
function targets(engine:Handle){return checkboxTargets(bridgeFor(engine));}
function signature(engine:Handle){return JSON.stringify(targets(engine).map(t=>[tableKey(t),t.value]));}
export function prepareControl(map:DocumentMap,call:ToolCall):ControlOperation {
 if(call.tool==='checkbox'){
  const table=call.tableId?map.target(call.tableId):undefined;if(table&&table.kind!=='table')throw Error('표 ID를 지정하세요.');
  const all=targets(map.engine),found=all.filter(t=>within(t,table));if(!found.length)throw Error('이 범위에 실제 체크박스 개체가 없습니다. 문자형 표시는 read로 확인하세요.');
  return {kind:'checkbox',checked:call.checked,table:table&&structuredClone(table),before:signature(map.engine),changed:found.filter(t=>t.value!==(call.checked?1:0)).length};
 }
 if(call.tool!=='table')throw Error('지원하는 표 작업이 아닙니다.');
 const node=map.target(call.id);if(node.kind!=='table')throw Error('표 ID를 지정하세요.');
 return {kind:'table',node:structuredClone(node),call:{...call}};
}
export function executeControl(engine:Handle,op:ControlOperation):void {
 if(op.kind==='checkbox'){
  if(signature(engine)!==op.before)throw Error('체크박스 원본 상태가 바뀌었습니다.');
  const all=targets(engine),expected=new Map(all.map(t=>[tableKey(t),within(t,op.table)?(op.checked?1:0):t.value]));
  for(const t of all.filter(t=>within(t,op.table)&&t.value!==expected.get(tableKey(t)))){
   const value=JSON.stringify({value:op.checked?1:0});const result=t.inCell?engine.setFormValueInCell(t.sec!,t.tablePara!,t.tableCi!,t.cellIdx!,t.cellPara!,t.ci!,value):engine.setFormValue(t.sec!,t.para!,t.ci!,value);
   if(JSON.parse(result).ok!==true)throw Error('체크박스 변경을 확인하지 못했습니다.');
  }
  const after=targets(engine);if(after.length!==all.length||after.some(t=>!expected.has(tableKey(t))||expected.get(tableKey(t))!==t.value))throw Error('체크박스 결과가 요청과 다릅니다.');return;
 }
 const {node,call:c}=op,a=node.address,args=[a.section,a.paragraph,a.control!] as const;
 const before=JSON.parse(engine.getTableDimensions(...args));if(before.rowCount!==node.rows||before.colCount!==node.cols)throw Error('표 구조가 바뀌었습니다.');
 const count=c.count??1;if(!Number.isSafeInteger(count)||count<1||count>1000)throw Error('한 작업에서 처리할 행·열은 1~1000개입니다.');
 const check=(result:string)=>{if(JSON.parse(result).ok!==true)throw Error('표 엔진이 요청을 거절했습니다. 병합된 셀과 범위를 확인하세요.');};
 const row=c.operation.endsWith('rows'),size=row?before.rowCount:before.colCount;
 if(['insert_rows','insert_columns','delete_rows','delete_columns'].includes(c.operation)){
  const i=c.index;if(i===undefined||!Number.isSafeInteger(i)||i<0)throw Error('행·열 index가 필요합니다.');
  const inserting=c.operation.startsWith('insert_');
  if(inserting?i>size:i+count>size||count>=size)throw Error('표 범위를 벗어나거나 마지막 행·열까지 삭제할 수 없습니다.');
  for(let n=0;n<count;n++){
   if(inserting){const at=i===size?size-1+n:i;const after=i===size;check(row?engine.insertTableRow(...args,at,after):engine.insertTableColumn(...args,at,after));}
   else check(row?engine.deleteTableRow(...args,i):engine.deleteTableColumn(...args,i));
  }
  const after=JSON.parse(engine.getTableDimensions(...args));if((row?after.rowCount:after.colCount)!==size+(inserting?count:-count))throw Error('행·열 개수 검증에 실패했습니다.');
 }else if(c.operation==='merge'||c.operation==='split'){
  const r=c.startRow??c.index,col=c.startCol;if(r===undefined||col===undefined||r>=before.rowCount||col>=before.colCount)throw Error('시작 행·열이 필요합니다.');
  if(c.operation==='split')check(engine.splitTableCell(...args,r,col));
  else {const er=c.endRow,ec=c.endCol;if(er===undefined||ec===undefined||er<r||ec<col||er>=before.rowCount||ec>=before.colCount)throw Error('병합할 끝 범위를 확인하세요.');check(engine.mergeTableCells(...args,r,col,er,ec));}
 }else throw Error('지원하는 행·열 작업을 지정하세요.');
}
