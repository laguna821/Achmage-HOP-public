/// <reference types="node" />
import {describe,it,expect,vi} from 'vitest';
import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';
const invokeMock=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke:invokeMock}));
import {generateKordocDocument,kordocDocumentBytes,kordocPageDataUrl,queuedKordocRequest,getKordocCapabilities,type KordocTransport} from './kordoc-engine';
import {templateLayout} from './document-templates';
import {roleTemplateFixture} from './document-template-fixture';
const source=()=>{const t=roleTemplateFixture();t.layout=templateLayout(t);return t;};
const actual:KordocTransport=async input=>{const child=spawnSync(process.execPath,['worker.mjs','--once'],{cwd:resolve(process.cwd(),'../kordoc-engine'),input:JSON.stringify(input)+'\n',encoding:'utf8',maxBuffer:32*1024*1024});expect(child.status).toBe(0);expect(child.stderr).toBe('');return JSON.parse(child.stdout);};
describe('fixed Kordoc bridge result',()=>{
 it('serializes at most four native requests, freezes queued inputs and never retries a failed invocation',async()=>{
  const releases:Array<(value:unknown)=>void>=[];invokeMock.mockReset();invokeMock.mockImplementation(()=>new Promise(resolve=>releases.push(resolve)));
  const original={id:'second',op:'capabilities'},one=queuedKordocRequest({id:'first',op:'capabilities'}),two=queuedKordocRequest(original),three=queuedKordocRequest({id:'third',op:'capabilities'}),four=queuedKordocRequest({id:'fourth',op:'capabilities'});original.id='changed';
  await expect(queuedKordocRequest({id:'fifth',op:'capabilities'})).rejects.toThrow('대기');await vi.waitFor(()=>expect(invokeMock).toHaveBeenCalledTimes(1));
  releases.shift()!('one');await one;await vi.waitFor(()=>expect(invokeMock).toHaveBeenCalledTimes(2));expect(invokeMock.mock.calls[1][1].input.id).toBe('second');
  releases.shift()!('two');await two;await vi.waitFor(()=>expect(invokeMock).toHaveBeenCalledTimes(3));releases.shift()!('three');await three;await vi.waitFor(()=>expect(invokeMock).toHaveBeenCalledTimes(4));releases.shift()!('four');await four;
  invokeMock.mockRejectedValueOnce(Error('another window busy')).mockResolvedValueOnce('recovered');await expect(queuedKordocRequest({id:'fail',op:'capabilities'})).rejects.toThrow('busy');await expect(queuedKordocRequest({id:'next',op:'capabilities'})).resolves.toBe('recovered');expect(invokeMock).toHaveBeenCalledTimes(6);
 });
 it('validates actual worker bytes and produces image-only preview URLs without altering the template',async()=>{const t=source(),before=JSON.stringify(t),r=await generateKordocDocument({template:t,markdown:t.layout!.sampleMarkdown},actual);expect(r.pages.length).toBeGreaterThanOrEqual(3);expect(kordocDocumentBytes(r).slice(0,2)).toEqual(new Uint8Array([80,75]));expect(kordocPageDataUrl(r.pages[0])).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);expect(JSON.stringify(t)).toBe(before);});
 it('rejects stale ID and changed bytes rather than presenting a successful preview',async()=>{const t=source(),input={template:t,markdown:t.layout!.sampleMarkdown};await expect(generateKordocDocument(input,async q=>({...await actual(q) as object,id:'different'}))).rejects.toThrow('ID');await expect(generateKordocDocument(input,async q=>{const r=await actual(q) as {result:{sha256:string}};r.result.sha256='0'.repeat(64);return r;})).rejects.toThrow('해시');});
 it('surfaces exact unsupported-generation errors with no fallback document',async()=>{const t=source();t.layout!.enginePreset='press';await expect(generateKordocDocument({template:t,markdown:t.layout!.sampleMarkdown},actual)).rejects.toThrow('표지');});
});

it('reads actual agency capabilities and rejects corrupted metadata',async()=>{const c=await getKordocCapabilities(actual);expect(c.presets).toHaveLength(9);expect(c.agencies).toHaveLength(53);expect(c.agencies.filter(a=>a.reportUsesCommonFallback)).toHaveLength(10);expect(c.agencies[0].fontFamiliesByPreset.press.length).toBeGreaterThan(0);await expect(getKordocCapabilities(async q=>{const r=await actual(q) as {result:{agencies:Array<{fontFamilies:string[]}>}};r.result.agencies[0].fontFamilies=[];return r;})).rejects.toThrow('기관');});
it('sends selected agency and only explicit role overrides through the real worker with used-font metadata',async()=>{const t=source();t.layout={...t.layout!,enginePreset:'press',cover:false,toc:false,agency:'행정안전부',agencyRoleOverrides:['body']};t.roles.body.fontFamily='신명조';const r=await generateKordocDocument({template:t,markdown:'# 기관 제목\n\n본문 검증'},actual);expect(r.fontFamilies).toContain('신명조');expect(r.fontFamiliesScope).toBe('all-language-font-references-of-used-run-charPr');expect(r.warnings.some(w=>w.includes('행정안전부'))).toBe(true);await expect(generateKordocDocument({template:t,markdown:'본문'},async q=>{const r=await actual(q) as {result:{fontFamilies:string[]}};r.result.fontFamilies=[];return r;})).rejects.toThrow('글꼴');});
