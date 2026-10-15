import { describe, it, expect } from 'vitest';
import { McpConnection } from './mcp-connection';
import type { Action, McpResult } from './types';
const result: McpResult = { sourceId:'kosis',endpoint:'http://127.0.0.1/mcp',retrievedAt:'2026-10-14',resultSha256:'hash',result:{isError:true,content:[{text:'provider error'}]},sessionCloseConfirmed:true,untrusted:true,automaticRetry:false };
describe('explicit MCP connection',()=>{
  it('OAuth polls pending state without returning credentials and completes explicitly',async()=>{
    const pending:unknown[]=[];let polls=0;
    const c=new McpConnection(async a=>a.op==='oauth_start'?{jobId:'oauth'}:++polls===1?{status:'oauth_pending',login_browser_open:'브라우저에서 인증'}:{status:'mcp_completed',result:{authenticated:true}},async()=>{});
    expect(await c.run({op:'oauth_start',sourceId:'custom-mcp'},s=>pending.push(s))).toEqual({authenticated:true});
    expect(pending).toEqual([{status:'oauth_pending',login_browser_open:'브라우저에서 인증'}]);
  });
  it('preserves tool error data and does not retry',async()=>{
    const calls:Action[]=[];
    const c=new McpConnection(async a=>{ calls.push(a); return a.op==='mcp_call'?{jobId:'1'}:{status:'mcp_completed',result}; });
    expect(await c.run({op:'mcp_call',sourceId:'kosis',name:'search',arguments:{q:'한글'}})).toEqual(result);
    expect(calls.map(c=>c.op)).toEqual(['mcp_call','poll']);
  });
  it('cancels late start acknowledgement',async()=>{
    let resolve!:(v:unknown)=>void;const calls:Action[]=[];
    const c=new McpConnection(async a=>{calls.push(a);if(a.op==='mcp_list')return new Promise(r=>{resolve=r;});return {ok:true};});
    const started=c.run({op:'mcp_list',sourceId:'kosis'}); await Promise.resolve();await Promise.resolve();
    await c.cancel(); resolve({jobId:'late'});expect(await started).toBeUndefined();
    expect(calls).toContainEqual({op:'cancel',jobId:'late'});
  });
  it('drops a stale poll result after disposal',async()=>{
    let resolve!:(v:unknown)=>void;
    const c=new McpConnection(async a=>a.op==='mcp_list'?{jobId:'x'}:a.op==='poll'?new Promise(r=>{resolve=r;}):{ok:true});
    const pending=c.run({op:'mcp_list',sourceId:'kosis'});for(let i=0;i<6;i++)await Promise.resolve();
    c.dispose();resolve({status:'mcp_completed',result});expect(await pending).toBeUndefined();
  });
});
