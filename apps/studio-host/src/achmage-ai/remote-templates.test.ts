import {describe,expect,it} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {BUILTIN_DOCUMENT_TEMPLATES,parseDocumentTemplate,templateLayout} from './document-templates';
import {kordocAuthoringPrompt} from './kordoc-authoring';
// The Telegram gateway makes documents without a window, so Rust embeds the built-in templates and
// the panel's prompt for each. This test keeps that copy identical; UPDATE_REMOTE_TEMPLATES=1 rewrites it.
const target=fileURLToPath(new URL('../../../desktop/src-tauri/src/achmage_telegram/remote-templates.json',import.meta.url));
const REQUEST='사용자 요청: ';
function specs(){
 return BUILTIN_DOCUMENT_TEMPLATES.map(t=>{
  const template=parseDocumentTemplate(t);template.layout=templateLayout(template);
  const prompt=kordocAuthoringPrompt('',template),at=prompt.lastIndexOf('\n'+REQUEST);
  if(at<0||prompt.slice(at+1)!==REQUEST+'""')throw Error('패널 프롬프트의 마지막 줄이 사용자 요청이 아닙니다.');
  return {id:t.id,name:t.name,description:t.description,template,promptPrefix:prompt.slice(0,at)};
 });
}
describe('remote templates for the Telegram gateway',()=>{
 it('match the built-in templates and the panel prompt',()=>{
  const json=JSON.stringify({schemaVersion:1,templates:specs()},null,1)+'\n';
  if(process.env.UPDATE_REMOTE_TEMPLATES==='1')writeFileSync(target,json);
  expect(readFileSync(target,'utf8').replace(/\r\n/g,'\n')).toBe(json);
 });
});
