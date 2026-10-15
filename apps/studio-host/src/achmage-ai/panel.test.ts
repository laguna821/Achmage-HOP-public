import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import type { AiState, AiAction } from './bridge';
import type { DocumentTemplate } from './document-templates';
const documentGuard=vi.hoisted(()=>({ applyToc:undefined as unknown as (...args:unknown[])=>Promise<unknown>, current:true, blank:false, applyWhole:vi.fn().mockResolvedValue({paragraphs:3,removedLayout:['foot']}), applyRestyle:vi.fn(), apply:vi.fn().mockResolvedValue(undefined), applyStructured:vi.fn().mockResolvedValue(undefined), capture:{before:'원문',selection:'same',command:{}}, structured:{identity:{documentEpoch:1,changeSeq:0,documentSha256:'fixture'},selection:'same',range:{section:0,startParagraph:0,paragraphCount:1},beforeParagraphs:[{text:'',paraFormat:{},charFormats:[]}],allParagraphs:[],controls:'[]'} }));
const fontGuard=vi.hoisted(()=>({available:vi.fn().mockResolvedValue(new Set(['함초롬바탕']))}));
const templateGuard=vi.hoisted(()=>({current:undefined as DocumentTemplate|undefined}));
const structureGuard=vi.hoisted(()=>({unsupported:false,Error:undefined as (new (message:string)=>Error)|undefined}));
const kordocGuard=vi.hoisted(()=>({prepare:vi.fn().mockResolvedValue(['함초롬바탕']),create:vi.fn().mockResolvedValue({pages:3,warnings:[]})}));
const wholeGuard=vi.hoisted(()=>({capture:vi.fn()}));
vi.mock('./whole-document-context',()=>({captureWholeDocumentContext:(...args:unknown[])=>wholeGuard.capture(...args)}));
vi.mock('./kordoc-authoring',async importOriginal=>{const actual=await importOriginal<typeof import('./kordoc-authoring')>();return {...actual,prepareKordocAuthoring:(...args:unknown[])=>kordocGuard.prepare(...args),createKordocDocument:(...args:unknown[])=>kordocGuard.create(...args)};});
vi.mock('./template-picker',()=>({installDocumentTemplates:()=>({current:()=>templateGuard.current,dispose:()=>{}})}));
vi.mock('../core/desktop-local-fonts',()=>({ensureDesktopFontsAvailable:(families:Iterable<string>)=>fontGuard.available(families),resolveDesktopFont:()=>null,getDesktopFonts:()=>['함초롬바탕']}));
vi.mock('./document',()=>({ AiDocument:class { identity(){return {current:documentGuard.current};} capture(){return documentGuard.capture;} captureInsertion(){return {before:'',selection:'same',insertion:{}};} isCurrent(){return documentGuard.current;} isStructuredCurrent(){return documentGuard.current;} apply(...args:unknown[]){return documentGuard.apply(...args);} applyStructured(...args:unknown[]){return documentGuard.applyStructured(...args);} isBlank(){return documentGuard.blank;} applyWholeDocument(...args:unknown[]){return documentGuard.applyWhole(...args);} applyRestyle(...args:unknown[]){return documentGuard.applyRestyle(...args);} applyTocRefresh(...args:unknown[]){return documentGuard.applyToc(...args);} dispose(){} } }));
// Only target capture/font inventory are boundary doubles. Routing and response parser remain real.
vi.mock('./document-intent',async importOriginal=>{const actual=await importOriginal<typeof import('./document-intent')>();return {...actual,prepareStructuredEdit:()=>{if(structureGuard.unsupported){throw new (structureGuard.Error!)('표·필드·그림 등 개체가 있는 문서는 구조 편집을 지원하지 않습니다.');}return ({capture:documentGuard.structured,prompt:'typed fixture prompt',notices:[],styleContext:templateGuard.current?structuredClone(templateGuard.current):undefined})},decodeStructuredResponse:(text:string,options:Parameters<typeof actual.decodeStructuredResponse>[1])=>actual.decodeStructuredResponse(text,{...options,availableFonts:['함초롬바탕','신명조']})};});
vi.mock('./inline',()=>({ installInlineEditor:()=>()=>{} }));
vi.mock('./runtime-tools',()=>({ installRuntimeTools:()=>()=>{} }));
vi.mock('./telegram-settings',()=>({ installTelegramSettings:()=>()=>{} }));
vi.mock('../achmage-research',()=>({ installResearchExtension:()=>()=>{} }));
import { installAiPanel, type PanelDeps, type PanelOptions } from './panel';
import { StructureUnsupportedError } from './structured-edit';
import { PANEL_ASK_EVENT, PANEL_RESTYLE_EVENT, PANEL_STATUS_EVENT, PANEL_TOC_EVENT, type PanelStatus } from './panel-events';
import { CHAT_STORAGE_KEY } from './panel-state';
import { BUILTIN_DOCUMENT_TEMPLATES } from './document-templates';

// Small DOM boundary double; production event handlers and bridge state transitions run unchanged.
class Element extends EventTarget {
  children:Element[]=[];parentElement:Element|null=null;className='';id='';textContent='';value='';checked=false;disabled=false;hidden=false;readOnly=false;dataset:Record<string,string>={};attrs=new Map<string,string>();
  onclick:(()=>unknown)|null=null;onchange:(()=>unknown)|null=null;onkeydown:((e:KeyboardEvent)=>unknown)|null=null;
  onpointerdown:unknown;onpointermove:unknown;onpointerup:unknown;onpointercancel:unknown;
  style={setProperty:vi.fn()};classes=new Set<string>();
  classList={toggle:(name:string,on:boolean)=>{on?this.classes.add(name):this.classes.delete(name);return on;}};
  get innerHTML(){return '';}
  set innerHTML(markup:string){this.children=[];for(const match of markup.matchAll(/<(\w+)([^>]*?)>/g)){const el=new Element();for(const a of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)){const key=a[1],value=a[2]??'';el.setAttribute(key,value);if(key==='class')el.className=value;if(key==='hidden')el.hidden=true;if(key.startsWith('data-'))el.dataset[key.slice(5)]=value;}this.append(el);}}
  append(...elements:Element[]){for(const el of elements){el.remove();el.parentElement=this;this.children.push(el);}}
  before(el:Element){const parent=this.parentElement;if(parent){el.remove();el.parentElement=parent;parent.children.splice(parent.children.indexOf(this),0,el);}}
  remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(e=>e!==this);this.parentElement=null;}}
  replaceChildren(){for(const el of this.children)el.parentElement=null;this.children=[];}
  setAttribute(key:string,value:string){this.attrs.set(key,value);}getAttribute(key:string){return this.attrs.get(key)??null;}
  all():Element[]{return this.children.flatMap(el=>[el,...el.all()]);}
  querySelectorAll(selector:string):Element[]{return this.all().filter(el=>{if(selector.startsWith('.'))return el.className.split(/\s+/).includes(selector.slice(1));const m=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);return !!m&&el.attrs.has(m[1])&&(m[2]===undefined||el.attrs.get(m[1])===m[2]);});}
  querySelector(selector:string){return this.querySelectorAll(selector)[0]??null;}
  focus(){}setPointerCapture(){}getBoundingClientRect(){return{right:900};}
  async click(){if(!this.disabled)await this.onclick?.();}
}
class TestDocument extends EventTarget { hidden=false;root=new Element();area=new Element();menu=new Element();constructor(){super();this.root.append(this.area,this.menu);}createElement(){return new Element();}getElementById(id:string){return id==='editor-area'?this.area:id==='menu-bar'?this.menu:null;} }
let dom:TestDocument, state:AiState, action:ReturnType<typeof vi.fn<(generation:number,action:AiAction)=>Promise<AiState>>>, stop:()=>void;
const flush=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
const base=():AiState=>({generation:1,selectedProvider:'openai',providers:[{id:'openai',label:'OpenAI',available:true,authMethods:[]},{id:'gemini',label:'Gemini',available:false,authMethods:[]}],auth:{status:'signed_in',sessionGeneration:'s1'},usage:{},turn:{id:null,status:'idle'}});
const sentRequest=()=>{const value=action.mock.calls[0][1];if(value.type!=='send')throw new Error('expected send');return value;};
const panel=()=>dom.root.all().find(e=>e.className==='achmage-ai')!;
const q=(s:string)=>panel().querySelector(s)!;
const btn=(name:string)=>q(`[data-action="${name}"]`);
const event=(type:string,props:Record<string,unknown>={})=>Object.assign(new Event(type,{cancelable:true}),props);
beforeEach(()=>{vi.useFakeTimers();dom=new TestDocument();state=base();documentGuard.current=true;documentGuard.blank=false;documentGuard.applyWhole.mockReset().mockResolvedValue({paragraphs:3,removedLayout:['foot']});fontGuard.available.mockReset().mockResolvedValue(new Set(['함초롬바탕']));documentGuard.apply.mockReset().mockResolvedValue(undefined);documentGuard.applyStructured.mockReset().mockResolvedValue(undefined);const store=new Map<string,string>();vi.stubGlobal('document',dom);vi.stubGlobal('window',Object.assign(new EventTarget(),{setInterval,clearInterval}));vi.stubGlobal('localStorage',{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v),removeItem:(k:string)=>store.delete(k)});vi.stubGlobal('confirm',()=>true);action=vi.fn(async(_generation:number,change:AiAction)=>{state={...state,generation:state.generation+1};if(change.type==='send')state={...state,turn:{id:change.requestId,requestId:change.requestId,status:'running'}};if(change.type==='begin_login')state={...state,busy:true,auth:{status:'pending'}};return state;});});
afterEach(()=>{stop?.();vi.useRealTimers();vi.unstubAllGlobals();});
async function start(pageCount=1,options:PanelOptions={router:false,restoreSignIn:false},input?:unknown){const wasm={pageCount};stop=installAiPanel({wasm,input,eventBus:{on:()=>()=>{}},undo:vi.fn()} as unknown as PanelDeps,{state:async()=>state,action},options);await flush();return wasm;}
describe('actual AI panel handlers',()=>{
  beforeEach(()=>{templateGuard.current=undefined;kordocGuard.prepare.mockReset().mockResolvedValue(['함초롬바탕']);kordocGuard.create.mockReset().mockResolvedValue({pages:3,warnings:[]});wholeGuard.capture.mockReset().mockReturnValue({sections:[{index:0,paragraphs:[{index:0,text:'열린 문서의 고유 본문',tables:[]},{index:1,text:'',tables:[{controlIndex:0,charOffset:0,rowCount:1,colCount:2,cells:[{index:0,row:0,col:0,rowSpan:1,colSpan:1,paragraphs:[{index:0,text:'안건'}]},{index:1,row:0,col:1,rowSpan:1,colSpan:1,paragraphs:[{index:0,text:'검토'}]}]}]}]}],paragraphs:4,tables:1,chars:15});});
  it('sends long Korean requests intact through routing and document authoring',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);
    await start(0,{});
    const text='아래 내용을 보고서로 작성해줘: '+('한글 원문과 표 내용을 보존합니다.\n'.repeat(12000))+'마지막끝표식';
    q('.achmage-prompt').value=text;q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();
    // The router reads the instruction and a short look at the manuscript; the authoring turn gets all of it.
    const first=sentRequest();expect(first.prompt).toContain('아래 내용을 보고서로 작성해줘');expect(first.prompt.length).toBeLessThan(30000);
    state={...state,generation:state.generation+1,turn:{id:first.requestId,requestId:first.requestId,status:'completed',text:'{"action":"write_new_document","instruction":"보고서 작성","rich":true}'}};
    await vi.advanceTimersByTimeAsync(1500);await flush();
    const sends=action.mock.calls.map(c=>c[1]).filter(c=>c.type==='send');
    expect(sends).toHaveLength(2);expect(sends[1].prompt).toContain('마지막끝표식');expect(sends[1].prompt).toContain(JSON.stringify(text).slice(1,-1));
  });
  it('typesets a long pasted manuscript into the template as written, without an authoring model turn',async()=>{
    // 2026-10-15 user report: "아래 텍스트를 선택한 템플릿으로 만들어" + 25 pages (122,486 bytes).
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);
    await start(0,{});
    const manuscript='2026년 사업 추진 보고\n\n'+Array.from({length:400},(_,i)=>`${i+1}. 추진 배경\n제목과 본문을 바탕 12pt로 비교한 결과를 정리했다. 문단 ${i+1}.`).join('\n\n');
    const text='아래 텍스트를 선택한 템플릿으로 만들어\n\n'+manuscript;
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(32768);
    q('.achmage-prompt').value=text;q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();
    const first=sentRequest();expect(first.prompt.length).toBeLessThan(30000);
    state={...state,generation:state.generation+1,turn:{id:first.requestId,requestId:first.requestId,status:'completed',text:'{"action":"write_new_document","instruction":"원고를 서식으로","rich":false}'}};
    await vi.advanceTimersByTimeAsync(1500);await flush();
    expect(action.mock.calls.map(c=>c[1]).filter(c=>c.type==='send')).toHaveLength(1);
    expect(kordocGuard.create).toHaveBeenCalledTimes(1);
    const markdown=kordocGuard.create.mock.calls[0][0] as string;
    expect(markdown.startsWith('# 2026년 사업 추진 보고')).toBe(true);expect(markdown).toContain('## 추진 배경');expect(markdown).toContain('문단 400.');
    expect(q('.achmage-message').textContent).toContain('문장은 그대로');
  });
  it.each(['양식을 바꿨는데 바뀐 양식대로 표지 목차 등이 전부 적용될 수 있게 만들어봐','양식을 바꿨는데 바뀐 양식대로 표지 목차 등이 전부 적용될 수 있게 만들어봐. 현재 한글에 작성한 문서 내용 전체 기준으로'])('typesets the currently open whole document for the reported restyling request without any model call: %s',async instruction=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);await start();
    q('.achmage-prompt').value=instruction;
    q('.achmage-prompt').dispatchEvent(event('input'));
    await btn('send').click();await flush();
    expect(wholeGuard.capture).toHaveBeenCalledTimes(1);expect(action.mock.calls.some(call=>call[1].type==='send')).toBe(false);
    expect(kordocGuard.create).toHaveBeenCalledTimes(1);const markdown=kordocGuard.create.mock.calls[0][0] as string;expect(markdown).toContain('열린 문서의 고유 본문');expect(markdown).toContain('| 안건 | 검토 |');
    expect(q('.achmage-message').textContent).toContain('AI가 글을 다시 쓰지 않고');expect(documentGuard.applyStructured).not.toHaveBeenCalled();
  });
  it('asks the model only for the changed blocks when the restyling request also changes the content, and keeps the rest as read',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);await start();
    q('.achmage-prompt').value='현재 문서 전체를 이 서식으로 바꾸면서 제목을 더 짧게 고쳐줘';q('.achmage-prompt').dispatchEvent(event('input'));
    await btn('send').click();await flush();const sent=sentRequest();
    expect(sent.prompt).toContain('[B1]');expect(sent.prompt).toContain('"kind":"block_patch"');expect(sent.prompt).toContain('| 안건 | 검토 |');expect(sent.prompt).toContain('"cover":true');
    state={...state,generation:3,turn:{id:sent.requestId,requestId:sent.requestId,status:'completed',text:'{"schemaVersion":1,"kind":"block_patch","changes":[{"replace":"B1","markdown":"# 고유 본문"}]}'}};await vi.advanceTimersByTimeAsync(1500);
    expect(kordocGuard.create).toHaveBeenCalledTimes(1);const markdown=kordocGuard.create.mock.calls[0][0] as string;expect(markdown).toContain('# 고유 본문');expect(markdown).not.toContain('열린 문서의 고유 본문');expect(markdown).toContain('| 안건 | 검토 |');
    expect(q('.achmage-message').textContent).toContain('나머지 블록은 원문 그대로');
  });
  it('masks personal identifiers in the document blocks before Markdown escaping can hide them from the detector',async()=>{
    // Escaping first turned "031)000-0000" into "031\\)000-0000", which no detector read as a phone number.
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);wholeGuard.capture.mockReturnValue({sections:[{index:0,paragraphs:[{index:0,text:'담당 hong_gildong@example.com',tables:[]},{index:1,text:'',tables:[{controlIndex:0,charOffset:0,rowCount:1,colCount:2,cells:[{index:0,row:0,col:0,rowSpan:1,colSpan:1,paragraphs:[{index:0,text:'031)000-0000'}]},{index:1,row:0,col:1,rowSpan:1,colSpan:1,paragraphs:[{index:0,text:'010.0000.0000'}]}]}]}]}],paragraphs:4,tables:1,chars:50});await start();
    q('.achmage-prompt').value='현재 문서 전체를 이 서식으로 바꾸면서 문장을 다듬어줘';q('.achmage-prompt').dispatchEvent(event('input'));
    await btn('send').click();await flush();const sent=sentRequest();
    for(const leak of ['000-0000','0000.0000','gildong','example.com'])expect(sent.prompt).not.toContain(leak);
    expect(sent.prompt).toContain('〔개인정보');
    state={...state,generation:3,turn:{id:sent.requestId,requestId:sent.requestId,status:'completed',text:JSON.stringify({schemaVersion:1,kind:'block_patch',changes:[{replace:'B1',markdown:'# 담당자 안내'}]})}};await vi.advanceTimersByTimeAsync(1500);
    // Unchanged blocks are rebuilt from the local original, values included; no "missing personal data" notice.
    const markdown=kordocGuard.create.mock.calls[0][0] as string;expect(markdown).toContain('# 담당자 안내');expect(markdown).toContain('031\\)000-0000');expect(markdown).toContain('010\\.0000.0000');
    expect(q('.achmage-message').textContent).not.toContain('빠졌습니다');
  });
  it('applies nothing when a changed block still carries a masking token after JSON decoding',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);await start();
    q('.achmage-prompt').value='현재 문서 전체를 이 서식으로 바꾸면서 문장을 다듬어줘';q('.achmage-prompt').dispatchEvent(event('input'));
    await btn('send').click();await flush();const sent=sentRequest();
    state={...state,generation:3,turn:{id:sent.requestId,requestId:sent.requestId,status:'completed',text:'{"schemaVersion":1,"kind":"block_patch","changes":[{"replace":"B1","markdown":"\\u3014개인정보7\\u3015 안내"}]}'}};await vi.advanceTimersByTimeAsync(1500);
    expect(kordocGuard.create).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('개인정보 표시');
  });
  it('typesets "문서 전체를 이 서식으로" with no AI sign-in and no routing turn',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);state={...base(),auth:{status:'signed_out',sessionGeneration:null}} as AiState;await start(1,{});
    q('.achmage-prompt').value='현재 문서 전체를 선택한 서식으로 바꿔줘';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();
    expect(action.mock.calls.some(call=>call[1].type==='send')).toBe(false);expect(kordocGuard.create).toHaveBeenCalledTimes(1);
    expect(q('.achmage-message').textContent).toContain('AI가 글을 다시 쓰지 않고');expect(q('.achmage-message').textContent).toContain('조판·적용');expect(q('.achmage-message').textContent).not.toMatch(/AI [0-9.]+초/);
    // Anything that needs a model still asks for a sign-in first.
    kordocGuard.create.mockClear();q('.achmage-prompt').value='현재 문서 전체를 이 서식으로 바꾸면서 요약해줘';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();
    expect(kordocGuard.create).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('먼저 AI 계정을 연결하세요');
  });
  it.each(['영어로 바꿔줘','더 공손하게 바꿔줘','띄어쓰기 맞춰줘','문장을 매끄럽게 해줘'])('sends a Ctrl+A whole-document edit that changes the wording to the model, never a silent restyle: %s',async instruction=>{
    templateGuard.current=undefined;await start();
    dom.dispatchEvent(event('achmage:request-whole-edit',{detail:{instruction}}));await flush();
    const sent=sentRequest();expect(sent.prompt).toContain('"kind":"block_patch"');expect(sent.prompt).toContain(instruction);expect(kordocGuard.create).not.toHaveBeenCalled();
  });
  it('keeps a translation asked together with a template change for the model, and a Ctrl+A "서식만" for the app',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);state={...base(),auth:{status:'signed_out',sessionGeneration:null}} as AiState;await start(1,{});
    q('.achmage-prompt').value='현재 문서 전체를 이 서식으로 바꾸고 영어로 바꿔줘';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();
    expect(kordocGuard.create).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('먼저 AI 계정을 연결하세요');
    templateGuard.current=undefined;dom.dispatchEvent(event('achmage:request-whole-edit',{detail:{instruction:'내용은 그대로 두고 서식만 정돈해줘'}}));await flush();
    expect(action.mock.calls.some(call=>call[1].type==='send')).toBe(false);expect(kordocGuard.create).toHaveBeenCalledTimes(1);
  });
  it('applies nothing when the model answers a changed-blocks request with something else',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);await start();
    q('.achmage-prompt').value='현재 문서 전체를 이 서식으로 바꾸면서 문장을 다듬어줘';q('.achmage-prompt').dispatchEvent(event('input'));
    await btn('send').click();await flush();const sent=sentRequest();
    state={...state,generation:3,turn:{id:sent.requestId,requestId:sent.requestId,status:'completed',text:'# 요약본'}};await vi.advanceTimersByTimeAsync(1500);
    expect(kordocGuard.create).not.toHaveBeenCalled();expect(documentGuard.applyWhole).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('적용하지 않았습니다');
  });
  it('does not ask a provider to reconstruct a source that cannot be read losslessly',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);wholeGuard.capture.mockImplementation(()=>{throw Error('그림 보존을 확인하지 못했습니다');});await start();
    q('.achmage-prompt').value='현재 문서 전체를 선택한 서식으로 다시 만들어줘';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();
    expect(action).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('그림 보존');
  });
  it('keeps captured multi-paragraph inline editing on its exact range even when a template is selected',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);await start();
    const capture={before:'첫 문단\n둘째 문단',selection:'same',multi:{identity:{}}};
    dom.dispatchEvent(event('achmage:request-edit',{detail:{capture,instruction:'선택한 본문을 간결하게 바꿔줘'}}));await flush();
    const sent=sentRequest();expect(sent.prompt).toContain('각 문단은 줄바꿈');expect(sent.prompt).toContain('첫 문단');expect(wholeGuard.capture).not.toHaveBeenCalled();
    state={...state,generation:3,turn:{id:sent.requestId,requestId:sent.requestId,status:'completed',text:'첫째\n둘째'}};await vi.advanceTimersByTimeAsync(1500);
    expect(documentGuard.apply).toHaveBeenCalledWith(capture,'첫째\n둘째');expect(documentGuard.applyStructured).not.toHaveBeenCalled();
  });
  it('routes the reported selected-template meeting request to Kordoc rather than plain chat or restricted structured edits',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[2]);await start();q('.achmage-prompt').value='서식을 바꿨어 이번에는 지금 선택한 서식으로 한두페이지짜리 회의자료를 표와 함께 만들어보자';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();
    const sent=sentRequest();expect(sent.prompt).toContain('kordoc');expect(sent.prompt).toContain('한림대');expect(sent.prompt).not.toContain('typed fixture');expect(kordocGuard.prepare).toHaveBeenCalledTimes(1);
    state={...state,generation:3,turn:{id:sent.requestId,requestId:sent.requestId,status:'completed',text:'# 회의자료\n\n|안건|내용|\n|---|---|\n|검토|별|'}};await vi.advanceTimersByTimeAsync(1500);
    expect(kordocGuard.create).toHaveBeenCalledTimes(1);expect(kordocGuard.create.mock.calls[0][3]).toBeUndefined();expect(documentGuard.applyStructured).not.toHaveBeenCalled();expect(documentGuard.apply).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('기존 문서');
  });
  it('refreshes contents page numbers from the right-click menu without any AI turn',async()=>{
    documentGuard.applyToc=vi.fn().mockResolvedValue({entries:2,pages:[3,4]});await start();
    dom.dispatchEvent(event(PANEL_TOC_EVENT));await flush();
    expect(documentGuard.applyToc).toHaveBeenCalledTimes(1);expect(action).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('목차 2줄');
  });
  it('refuses document generation from a fill-in-only form pack without any AI turn or document change (gate C L16)',async()=>{
    templateGuard.current={...structuredClone(BUILTIN_DOCUMENT_TEMPLATES[2]),name:'구매 신청서 (공용 초안)',pack:{id:'hallym-purchase.request',strategy:'fixed',group:'로컬 서식 팩 · 구매'}};await start();
    q('.achmage-prompt').value='서식을 바꿨어 이번에는 지금 선택한 서식으로 한두페이지짜리 구매 신청서를 표와 함께 만들어보자';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();
    expect(action).not.toHaveBeenCalled();expect(kordocGuard.prepare).not.toHaveBeenCalled();expect(kordocGuard.create).not.toHaveBeenCalled();expect(documentGuard.applyWhole).not.toHaveBeenCalled();
    expect(q('.achmage-message').textContent).toContain('빈 양식 채우기 전용');expect(q('.achmage-message').textContent).toContain('빈 양식 열기');
  });
  it('typesets without a contents page, and says so, when the document has no chapter headings',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);await start();
    kordocGuard.create.mockImplementation(async(_t,_tmp,_c,inPlace)=>{await inPlace(new Uint8Array([7]));return {placement:'current',pages:1,warnings:[]};});
    q('.achmage-prompt').value='현재 문서 전체를 선택한 서식으로 바꿔줘';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();
    expect(kordocGuard.create.mock.calls[0][1].layout).toMatchObject({cover:true,toc:false});expect(documentGuard.applyWhole.mock.calls[0][2]).toEqual({hideFirstPage:true,toc:false});
    expect(q('.achmage-message').textContent).toContain('장 제목을 찾지 못해 목차 없이 조판했습니다');
  });
  it('applies the reported restyling request to the open window as one Ctrl+Z step and discloses replaced layout',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);wholeGuard.capture.mockReturnValue({sections:[{index:0,paragraphs:[{index:0,text:'사업 결과 보고',tables:[]},{index:1,text:'Ⅰ. 추진 배경',tables:[]},{index:2,text:'본문 문장입니다.',tables:[]}]}],paragraphs:3,tables:0,chars:20});await start();
    kordocGuard.create.mockImplementation(async(_t,_tmp,current,inPlace)=>{expect(current()).toBe(true);const notices=await inPlace(new Uint8Array([7]));return {placement:'current',pages:3,warnings:notices};});
    q('.achmage-prompt').value='양식을 바꿨는데 바뀐 양식대로 표지 목차 등이 전부 적용될수 있게 만들어봐';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();
    expect(action.mock.calls.some(call=>call[1].type==='send')).toBe(false);
    expect(documentGuard.applyWhole).toHaveBeenCalledTimes(1);expect(documentGuard.applyWhole.mock.calls[0][0]).toEqual({current:true});expect(documentGuard.applyWhole.mock.calls[0][1]).toEqual(new Uint8Array([7]));expect(documentGuard.applyWhole.mock.calls[0][2]).toEqual({hideFirstPage:true,toc:true});
    expect(q('.achmage-message').textContent).toContain('현재 문서를');expect(q('.achmage-message').textContent).toContain('Ctrl+Z');expect(q('.achmage-message').textContent).toContain('꼬리말');
  });
  it('fills a blank open document with a template document instead of opening another window',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[2]);documentGuard.blank=true;await start();
    q('.achmage-prompt').value='회의자료를 표와 함께 만들어보자';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();const sent=sentRequest();
    expect(wholeGuard.capture).not.toHaveBeenCalled();
    state={...state,generation:3,turn:{id:sent.requestId,requestId:sent.requestId,status:'completed',text:'# 회의자료'}};await vi.advanceTimersByTimeAsync(1500);
    expect(typeof kordocGuard.create.mock.calls[0][3]).toBe('function');
  });
  it('explains an in-place limit when the result had to open in a new window',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);kordocGuard.create.mockResolvedValue({placement:'new-window',pages:3,warnings:[],fallbackReason:'여러 구역으로 나뉜 문서는 현재 창에서 통째로 바꾸지 않습니다.'});await start();
    q('.achmage-prompt').value='현재 문서 전체를 선택한 서식으로 다시 만들어줘';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();
    expect(q('.achmage-message').textContent).toContain('여러 구역');expect(q('.achmage-message').textContent).toContain('새 창');
  });  it('routes an inline whole-document edit (Ctrl+A with tables) to in-place restyling, with the default template when none is chosen',async()=>{
    templateGuard.current=undefined;await start();
    dom.dispatchEvent(event('achmage:request-whole-edit',{detail:{instruction:'더 간결하게 공문 어투로 바꿔줘'}}));await flush();
    const sent=sentRequest();expect(wholeGuard.capture).toHaveBeenCalledTimes(1);expect(sent.prompt).toContain('kordoc');expect(sent.prompt).toContain('더 간결하게 공문 어투로');expect(sent.prompt).toContain('열린 문서의 고유 본문');
    kordocGuard.create.mockImplementation(async(_t,template,_c,inPlace)=>{expect(template.name).toBe(BUILTIN_DOCUMENT_TEMPLATES[0].name);await inPlace(new Uint8Array([1]));return {placement:'current',pages:2,warnings:[]};});
    state={...state,generation:3,turn:{id:sent.requestId,requestId:sent.requestId,status:'completed',text:'{"schemaVersion":1,"kind":"block_patch","changes":[{"replace":"B1","markdown":"# 고유 본문"}]}'}};await vi.advanceTimersByTimeAsync(1500);
    expect(documentGuard.applyWhole).toHaveBeenCalledTimes(1);expect(q('.achmage-message').textContent).toContain('현재 문서를');expect(kordocGuard.create.mock.calls[0][0]).toContain('| 안건 | 검토 |');
  });  it('does not spend a provider request when the document engine cannot start',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);kordocGuard.prepare.mockRejectedValue(Error('엔진 설치 실패'));await start();q('.achmage-prompt').value='선택한 서식으로 회의자료를 만들어보자';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();expect(action).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('엔진 설치 실패');
  });
  it('creates a template document from home and invalidates it when a document is opened',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);const wasm=await start(0);
    q('.achmage-prompt').value='회의자료를 표와 함께 만들어보자';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();
    const sent=sentRequest();expect(sent.prompt).toContain('kordoc');
    kordocGuard.create.mockImplementation(async(_text,_template,current)=>{expect(current()).toBe(true);wasm.pageCount=1;expect(current()).toBe(false);return{pages:3,warnings:[]};});
    state={...state,generation:3,turn:{id:sent.requestId,requestId:sent.requestId,status:'completed',text:'# 회의자료'}};await vi.advanceTimersByTimeAsync(1500);
    expect(kordocGuard.create).toHaveBeenCalledTimes(1);
  });
  const structuredPlan={schemaVersion:1,operation:'replace_paragraphs',paragraphs:[{runs:[{text:'제목',fontFamily:'함초롬바탕',fontSizePt:15,bold:true,spacingPercent:-5}]},{runs:[{text:'둘째 본문',fontFamily:'함초롬바탕',fontSizePt:10.5,bold:false,spacingPercent:3}]}]};
  const tablePlan=()=>({schemaVersion:2,operation:'replace_paragraphs',styles:{tableCell:{fontFamily:'신명조',fontSizePt:11,bold:false,spacingPercent:0}},blocks:[{type:'table',rows:[[{runs:[{text:'실제 표 셀',style:'tableCell'}],paragraphFormat:{alignment:'center',lineSpacingPercent:180}}]]}]});
  async function sendStructured(){await start();q('.achmage-prompt').value='글꼴과 자간을 적용해서 두 문단 수정해줘';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();return sentRequest();}
  function completeStructured(requestId:string,text=JSON.stringify(structuredPlan)){state={...state,generation:state.generation+1,turn:{id:requestId,requestId,status:'completed',text}};}
  it('renders validated structured history as body text while preserving the original plan for reuse',async()=>{
    const sent=await sendStructured();completeStructured(sent.requestId);await vi.advanceTimersByTimeAsync(1500);
    const visible=q('.achmage-history').children[1].children[1].textContent;
    expect(visible).toBe('제목\n\n둘째 본문');expect(visible).not.toContain('schemaVersion');
    const saved=JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY)!);expect(saved[1].text).toBe(JSON.stringify(structuredPlan));
  });
  it('hides incomplete structured streaming output without hiding ordinary chat streaming',async()=>{
    const sent=await sendStructured();state={...state,generation:3,turn:{id:sent.requestId,requestId:sent.requestId,status:'running',text:'{"schemaVersion":1,"paragraphs":['}};await vi.advanceTimersByTimeAsync(500);
    expect(q('.achmage-answer').hidden).toBe(true);expect(q('.achmage-answer').textContent).toBe('');expect(documentGuard.applyStructured).not.toHaveBeenCalled();
    stop();state=base();action.mockClear();await start();q('.achmage-prompt').value='오늘은 어떤 날인가요?';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();const chat=sentRequest();state={...state,generation:3,turn:{id:chat.requestId,requestId:chat.requestId,status:'running',text:'답변 작성 중'}};await vi.advanceTimersByTimeAsync(500);
    expect(q('.achmage-answer').hidden).toBe(false);expect(q('.achmage-answer').textContent).toBe('답변 작성 중');
  });
  it.each(['글꼴과 자간을 적용하고 표도 만들어줘','표를 만들어줘'])('routes actual table plan to structured apply once rather than pipe text: %s',async prompt=>{
    fontGuard.available.mockResolvedValue(new Set(['신명조']));
    await start();q('.achmage-prompt').value=prompt;q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();
    const sent=sentRequest();expect(sent.prompt).toBe('typed fixture prompt');completeStructured(sent.requestId,JSON.stringify(tablePlan()));await vi.advanceTimersByTimeAsync(1500);
    expect(documentGuard.apply).not.toHaveBeenCalled();expect(documentGuard.applyStructured).toHaveBeenCalledTimes(1);expect(documentGuard.applyStructured.mock.calls[0][1].paragraphs[0].table[0][0].runs[0].text).toBe('실제 표 셀');expect(fontGuard.available).toHaveBeenCalledWith(['신명조']);expect(q('.achmage-history').children[1].children[1].textContent).toBe('실제 표 셀');
  });
  it('checks fonts inside table cells before any document mutation',async()=>{
    const sent=await sendStructured();completeStructured(sent.requestId,JSON.stringify(tablePlan()));await vi.advanceTimersByTimeAsync(1000);expect(fontGuard.available).toHaveBeenCalledWith(['신명조']);expect(documentGuard.applyStructured).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('사용할 수 없는 글꼴');
  });
  it('uses the template snapshot captured for the request even if current preference changes before completion',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);for(const role of Object.values(templateGuard.current.roles)){role.fontFamily='함초롬바탕';role.lineSpacingPercent=175;}const sent=await sendStructured();templateGuard.current.roles.tableCell.lineSpacingPercent=350;
    completeStructured(sent.requestId,JSON.stringify(tablePlan()));await vi.advanceTimersByTimeAsync(1000);expect(documentGuard.applyStructured).toHaveBeenCalledTimes(1);expect(documentGuard.applyStructured.mock.calls[0][1].paragraphs[0].table[0][0].paragraphFormat.lineSpacingPercent).toBe(175);
  });
  it('automatically applies one validated styled plan and never pastes its JSON as plain text',async()=>{
    const sent=await sendStructured();expect(sent.prompt).toBe('typed fixture prompt');completeStructured(sent.requestId);await vi.advanceTimersByTimeAsync(2000);
    expect(documentGuard.applyStructured).toHaveBeenCalledTimes(1);expect(documentGuard.applyStructured).toHaveBeenCalledWith(documentGuard.structured,structuredPlan);expect(documentGuard.apply).not.toHaveBeenCalled();expect(panel().querySelector('.achmage-proposal')).toBeNull();expect(q('.achmage-message').textContent).toContain('Ctrl+Z');
    await vi.advanceTimersByTimeAsync(2000);expect(documentGuard.applyStructured).toHaveBeenCalledTimes(1);
  });
  it('does not apply partial streamed JSON, wrong request completion, or failed completion',async()=>{
    const sent=await sendStructured();state={...state,generation:3,turn:{id:sent.requestId,requestId:sent.requestId,status:'running',text:JSON.stringify(structuredPlan)}};await vi.advanceTimersByTimeAsync(500);expect(documentGuard.applyStructured).not.toHaveBeenCalled();
    completeStructured('different-request');await vi.advanceTimersByTimeAsync(500);expect(documentGuard.applyStructured).not.toHaveBeenCalled();
    state={...state,generation:state.generation+1,turn:{id:sent.requestId,requestId:sent.requestId,status:'error',text:JSON.stringify(structuredPlan)}};await vi.advanceTimersByTimeAsync(500);expect(documentGuard.applyStructured).not.toHaveBeenCalled();
    completeStructured(sent.requestId);await vi.advanceTimersByTimeAsync(500);expect(documentGuard.applyStructured).toHaveBeenCalledTimes(1);
  });
  it('rejects a structured late completion after account generation changes',async()=>{
    const sent=await sendStructured();state={...state,auth:{status:'signed_in',sessionGeneration:'new-account'}};completeStructured(sent.requestId);await vi.advanceTimersByTimeAsync(1500);expect(documentGuard.applyStructured).not.toHaveBeenCalled();expect(documentGuard.apply).not.toHaveBeenCalled();
  });
  it('rejects structured completion after document identity or selection drift',async()=>{
    const sent=await sendStructured();documentGuard.current=false;completeStructured(sent.requestId);await vi.advanceTimersByTimeAsync(1500);expect(documentGuard.applyStructured).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('자동 편집을 멈췄습니다');
  });
  it('rejects invalid styled output without falling back to plain text or retrying completed output',async()=>{
    const sent=await sendStructured();completeStructured(sent.requestId,'서식을 적용했습니다.');await vi.advanceTimersByTimeAsync(1500);expect(documentGuard.applyStructured).not.toHaveBeenCalled();expect(documentGuard.apply).not.toHaveBeenCalled();expect(q('.achmage-message').dataset.tone).toBe('error');
  });
  it('applies a duplicate completion only once while asynchronous document commit is pending',async()=>{
    let finish!:()=>void;documentGuard.applyStructured.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));const sent=await sendStructured();completeStructured(sent.requestId);await vi.advanceTimersByTimeAsync(2000);expect(documentGuard.applyStructured).toHaveBeenCalledTimes(1);finish();await flush();await vi.advanceTimersByTimeAsync(1000);expect(documentGuard.applyStructured).toHaveBeenCalledTimes(1);
  });
  it('reports transaction rejection and never claims success or retries the same completion',async()=>{
    documentGuard.applyStructured.mockRejectedValue(new Error('복구된 서식 실패'));const sent=await sendStructured();completeStructured(sent.requestId);await vi.advanceTimersByTimeAsync(2000);expect(documentGuard.applyStructured).toHaveBeenCalledTimes(1);expect(q('.achmage-message').textContent).toBe('복구된 서식 실패');expect(q('.achmage-message').dataset.tone).toBe('error');
  });
  it('cancelled structured request cannot be revived by its later completed notification',async()=>{
    const sent=await sendStructured();await btn('cancel-turn').click();completeStructured(sent.requestId);await vi.advanceTimersByTimeAsync(1500);expect(documentGuard.applyStructured).not.toHaveBeenCalled();
  });
  it('requires successful actual font availability rather than catalog metadata alone',async()=>{
    fontGuard.available.mockResolvedValue(new Set());const sent=await sendStructured();completeStructured(sent.requestId);await vi.advanceTimersByTimeAsync(1500);expect(fontGuard.available).toHaveBeenCalledWith(['함초롬바탕']);expect(documentGuard.applyStructured).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('사용할 수 없는 글꼴');
  });
  it('rechecks document identity after asynchronous font preparation',async()=>{
    let finish!:(v:Set<string>)=>void;fontGuard.available.mockImplementation(()=>new Promise<Set<string>>(resolve=>{finish=resolve;}));const sent=await sendStructured();completeStructured(sent.requestId);await vi.advanceTimersByTimeAsync(500);expect(fontGuard.available).toHaveBeenCalledTimes(1);documentGuard.current=false;finish(new Set(['함초롬바탕']));await flush();expect(documentGuard.applyStructured).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('바뀌어');
  });
  it('does not mutate a disposed editor after delayed font preparation succeeds',async()=>{
    let finish!:(v:Set<string>)=>void;fontGuard.available.mockImplementation(()=>new Promise<Set<string>>(resolve=>{finish=resolve;}));const sent=await sendStructured();completeStructured(sent.requestId);await vi.advanceTimersByTimeAsync(500);stop();finish(new Set(['함초롬바탕']));await flush();expect(documentGuard.applyStructured).not.toHaveBeenCalled();
  });
  it('rechecks account generation independently while document remains unchanged during font loading',async()=>{
    let finish!:(v:Set<string>)=>void;fontGuard.available.mockImplementation(()=>new Promise<Set<string>>(resolve=>{finish=resolve;}));const sent=await sendStructured();completeStructured(sent.requestId);await vi.advanceTimersByTimeAsync(500);state={...state,generation:state.generation+1,auth:{status:'signed_in',sessionGeneration:'changed-during-font-load'}};await vi.advanceTimersByTimeAsync(500);expect(documentGuard.current).toBe(true);finish(new Set(['함초롬바탕']));await flush();expect(documentGuard.applyStructured).not.toHaveBeenCalled();
  });
  it('applies an explicit writing request once at the captured caret without another click',async()=>{
    await start();q('.achmage-prompt').value='여기 화면에 보이는 새 문서에 단편 소설 3줄을 써봐';
    q('.achmage-prompt').dispatchEvent(event('input'));expect(q('.achmage-writing-hint').hidden).toBe(false);
    await btn('send').click();const request=sentRequest();expect(request.prompt).toContain('현재 커서 위치');expect(request.prompt).not.toContain('원문:');
    state={...state,generation:3,turn:{id:request.requestId,requestId:request.requestId,status:'completed',text:'첫째\n둘째\n셋째'}};
    await vi.advanceTimersByTimeAsync(1500);
    expect(documentGuard.apply).toHaveBeenCalledTimes(1);
    expect(documentGuard.apply).toHaveBeenCalledWith(expect.objectContaining({insertion:{}}),'첫째\n둘째\n셋째');
    expect(panel().querySelector('.achmage-proposal')).toBeNull();expect(q('.achmage-composer').hidden).toBe(false);
    expect(q('.achmage-message').dataset.tone).toBe('success');
  });
  it('closes to hidden/zero layout participation and reopens without losing draft',async()=>{await start();q('.achmage-prompt').value='작성 중';await btn('toggle').click();expect(panel().hidden).toBe(true);const opener=dom.menu.children[0];expect(opener.getAttribute('aria-expanded')).toBe('false');await opener.click();expect(panel().hidden).toBe(false);expect(q('.achmage-prompt').value).toBe('작성 중');});
  it('keeps the IME input editable and Enter non-sending during composition',async()=>{await start();q('.achmage-prompt').value='한글';dom.dispatchEvent(event('compositionstart'));q('.achmage-prompt').dispatchEvent(event('keydown',{key:'Enter',shiftKey:false,isComposing:true}));await flush();expect(action).not.toHaveBeenCalled();expect(q('.achmage-prompt').readOnly).toBe(false);dom.dispatchEvent(event('compositionend'));q('.achmage-prompt').dispatchEvent(event('keydown',{key:'Enter',shiftKey:false,isComposing:false}));await flush();expect(action).toHaveBeenCalledTimes(1);});
  it('stores one literal response across repeated polls and restores no document proposal',async()=>{await start();q('.achmage-prompt').value='질문';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();const request=sentRequest();state={...state,generation:state.generation+1,turn:{id:request.requestId,requestId:request.requestId,status:'completed',text:'<img src=x onerror=evil()>'}};await vi.advanceTimersByTimeAsync(1500);const saved=JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY)!);expect(saved.map((v:{role:string})=>v.role)).toEqual(['user','assistant']);expect(q('.achmage-history').children[1].children[1].textContent).toContain('<img');expect(panel().querySelector('.achmage-proposal')).toBeNull();expect(documentGuard.apply).not.toHaveBeenCalled();});
  it('never applies a late completion after account change',async()=>{await start();q('.achmage-prompt').value='수정';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();const sent=sentRequest();state={...state,generation:3,auth:{status:'signed_in',sessionGeneration:'s2'},turn:{id:sent.requestId,requestId:sent.requestId,status:'completed',text:'결과'}};await vi.advanceTimersByTimeAsync(1000);expect(documentGuard.apply).not.toHaveBeenCalled();});
  it('does not overwrite a document changed while the response was pending',async()=>{await start();q('.achmage-prompt').value='고쳐줘';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();const sent=sentRequest();documentGuard.current=false;state={...state,generation:3,turn:{id:sent.requestId,requestId:sent.requestId,status:'completed',text:'결과'}};await vi.advanceTimersByTimeAsync(1000);expect(documentGuard.apply).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('자동 편집을 멈췄습니다');});
  it('sends only the actual catalog model and supported effort',async()=>{state={...base(),modelCatalogStatus:'ready',models:[{id:'catalog-default',label:'Actual model',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}]};await start();expect(q('.achmage-model').value).toBe('catalog-default');expect(q('.achmage-effort').value).toBe('high');expect(btn('tools').hidden).toBe(true);q('.achmage-effort').value='low';q('.achmage-prompt').value='질문';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();expect(sentRequest()).toMatchObject({model:'catalog-default',reasoningEffort:'low'});});
  it('pending login remains polled and cancellable while panel is closed',async()=>{state={...base(),auth:{status:'signed_out'}};await start();await q('[data-provider="openai"]').click();await btn('toggle').click();expect(btn('cancel-login').disabled).toBe(false);state={...state,generation:4,busy:false,auth:{status:'signed_in',sessionGeneration:'s1'}};await vi.advanceTimersByTimeAsync(500);expect(q('.achmage-login').hidden).toBe(true);expect(panel().hidden).toBe(true);});
  it('at launch reselects the provider chosen last time and picks up its existing sign-in without a login',async()=>{
    localStorage.setItem('achmage.hop.provider.v1','gemini');
    state={...base(),selectedProvider:'openai',auth:{status:'signed_out'},providers:base().providers.map(p=>({...p,available:true}))};
    action.mockImplementation(async(_gen,change)=>{if(change.type==='select_provider')state={...state,generation:state.generation+1,selectedProvider:change.provider,auth:{status:'signed_out'}};else state={...state,generation:state.generation+1,auth:{status:'signed_in',sessionGeneration:'s1'}};return state;});
    await start(1,{router:false});await vi.advanceTimersByTimeAsync(1500);await flush();
    const kinds=action.mock.calls.map(c=>c[1].type);
    expect(kinds).toEqual(['select_provider','restore_connection']);expect((action.mock.calls[0][1] as {provider?:string}).provider).toBe('gemini');
    expect(kinds).not.toContain('begin_login');
    localStorage.removeItem('achmage.hop.provider.v1');
  });
  it('does not expose unavailable provider as actionable login',async()=>{state={...base(),auth:{status:'signed_out'}};await start();expect(q('[data-provider="gemini"]').disabled).toBe(true);await q('[data-provider="gemini"]').click();expect(action).not.toHaveBeenCalled();});
  it('waits for provider restore and never opens login for an already restored account',async()=>{state={...base(),selectedProvider:'gemini',auth:{status:'signed_out'}};action.mockImplementation(async()=>{state={...state,generation:2,selectedProvider:'openai',commandPending:true,busy:true};return state;});await start();await q('[data-provider="openai"]').click();expect(action).toHaveBeenCalledTimes(1);state={...state,generation:3,commandPending:false,busy:false,auth:{status:'signed_in',sessionGeneration:'restored'}};await vi.advanceTimersByTimeAsync(1000);expect(action).toHaveBeenCalledTimes(1);expect(q('.achmage-login').hidden).toBe(true);});
  it('waits for provider ACK then starts login only once',async()=>{state={...base(),selectedProvider:'gemini',auth:{status:'signed_out'}};action.mockImplementation(async(_gen,change)=>{state={...state,generation:state.generation+1,selectedProvider:'openai',commandPending:change.type==='select_provider',busy:true,auth:{status:change.type==='begin_login'?'pending':'signed_out'}};return state;});await start();await q('[data-provider="openai"]').click();state={...state,generation:3,commandPending:false,busy:false};await vi.advanceTimersByTimeAsync(1500);expect(action.mock.calls.map(call=>call[1].type)).toEqual(['select_provider','begin_login']);});
  it('signs Claude in with an Anthropic Console account when that method is chosen',async()=>{state={...base(),selectedProvider:'gemini',providers:[...base().providers,{id:'claude',label:'Claude',available:true,authMethods:[]}],auth:{status:'signed_out'}};action.mockImplementation(async(_gen,change)=>{state={...state,generation:state.generation+1,selectedProvider:'claude',commandPending:change.type==='select_provider',busy:true,auth:{status:change.type.startsWith('begin_')?'pending':'signed_out'}};return state;});await start();q('.achmage-claude-method-select').value='console';await q('[data-provider="claude"]').click();state={...state,generation:3,commandPending:false,busy:false};await vi.advanceTimersByTimeAsync(1500);expect(action.mock.calls.map(call=>call[1].type)).toEqual(['select_provider','begin_console_login']);});
  it('tells the inline popover that its request is working, then finished or failed with the reason (T03)',async()=>{
    const statuses:PanelStatus[]=[];dom.addEventListener(PANEL_STATUS_EVENT,e=>statuses.push((e as CustomEvent<PanelStatus>).detail));await start();
    const capture={before:'원문',selection:'same',command:{}};
    dom.dispatchEvent(event('achmage:request-edit',{detail:{capture,instruction:'간결하게'}}));await flush();
    expect(statuses.some(s=>s.working)).toBe(true);expect(statuses.some(s=>s.message?.tone==='error')).toBe(false);
    const first=sentRequest();state={...state,generation:3,turn:{id:first.requestId,requestId:first.requestId,status:'completed',text:'결과'}};await vi.advanceTimersByTimeAsync(1500);
    expect(documentGuard.apply).toHaveBeenCalledTimes(1);expect(statuses.at(-1)?.working).toBe(false);expect(statuses.some(s=>s.message?.tone==='error')).toBe(false);
    statuses.length=0;action.mockClear();
    dom.dispatchEvent(event('achmage:request-edit',{detail:{capture,instruction:'다시'}}));await flush();
    const second=sentRequest();state={...state,generation:5,turn:{id:second.requestId,requestId:second.requestId,status:'error',message:'응답 시간이 초과되었습니다.'}};await vi.advanceTimersByTimeAsync(600);
    expect(statuses).toContainEqual({working:false,final:true,message:{text:'요청을 끝내지 못했습니다. 응답 시간이 초과되었습니다. 사이드 패널에서 다시 시도할 수 있습니다.',tone:'error'}});
  });
  it('Gemini: lists the official agy models, hides reasoning effort and sends the chosen model (T14)',async()=>{state={...base(),selectedProvider:'gemini',models:[{id:'gemini-a',label:'Gemini A'},{id:'gemini-b',label:'Gemini B'}]} as AiState;await start();expect(q('.achmage-model-label').hidden).toBe(false);expect(q('.achmage-model').children.map(o=>o.value)).toEqual(['gemini-a','gemini-b']);expect(q('.achmage-effort-label').hidden).toBe(true);q('.achmage-model').value='gemini-b';q('.achmage-prompt').value='질문';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();expect(sentRequest()).toMatchObject({model:'gemini-b'});expect(sentRequest()).not.toHaveProperty('reasoningEffort');action.mockClear();await btn('refresh').click();expect(action.mock.calls[0]?.[1]).toEqual({type:'refresh_models'});});
  it('Claude: no invented model list — one official-default line, no effort, nothing extra sent (T14)',async()=>{state={...base(),selectedProvider:'claude',models:[]} as AiState;await start();expect(q('.achmage-model-label').hidden).toBe(true);expect(q('.achmage-model-status').textContent).toBe('공식 기본 모델을 사용합니다.');expect(q('.achmage-effort-label').hidden).toBe(true);q('.achmage-prompt').value='질문';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();const sent=sentRequest();expect(sent).not.toHaveProperty('model');expect(sent).not.toHaveProperty('reasoningEffort');action.mockClear();await btn('refresh').click();expect(action.mock.calls.some(call=>call[1].type==='refresh_models')).toBe(false);});
  it('sends only the model currently advertised and selected in the picker',async()=>{state={...base(),models:[{id:'observed-model',label:'현재 모델'}]} as AiState;await start();expect(q('.achmage-model-label').hidden).toBe(false);q('.achmage-prompt').value='질문';q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();expect(sentRequest().model).toBe('observed-model');});
});
describe('model-routed chat messages',()=>{
  const sentAt=(i:number)=>{const value=action.mock.calls.filter(call=>call[1].type==='send')[i]?.[1];if(!value||value.type!=='send')throw new Error('expected send '+i);return value;};
  const sends=()=>action.mock.calls.filter(call=>call[1].type==='send').length;
  const complete=async(requestId:string,text:string)=>{state={...state,generation:state.generation+5,turn:{id:requestId,requestId,status:'completed',text}};await vi.advanceTimersByTimeAsync(1500);};
  const ask=async(text:string)=>{q('.achmage-prompt').value=text;q('.achmage-prompt').dispatchEvent(event('input'));await btn('send').click();await flush();};
  const chat=()=>panel().querySelector('.achmage-history')!.children.map(e=>e.children[1]?.textContent);
  beforeEach(()=>{templateGuard.current=undefined;kordocGuard.prepare.mockReset().mockResolvedValue(['함초롬바탕']);kordocGuard.create.mockReset().mockResolvedValue({pages:3,warnings:[]});wholeGuard.capture.mockReset().mockReturnValue({sections:[{index:0,paragraphs:[{index:0,text:'열린 문서의 고유 본문',tables:[]},{index:1,text:'',tables:[{controlIndex:0,charOffset:0,rowCount:1,colCount:2,cells:[{index:0,row:0,col:0,rowSpan:1,colSpan:1,paragraphs:[{index:0,text:'안건'}]},{index:1,row:0,col:1,rowSpan:1,colSpan:1,paragraphs:[{index:0,text:'검토'}]}]}]}]}],paragraphs:4,tables:1,chars:15});});
  it('lets the model choose whole-document recomposition for the reported free-form request, then runs the template engine',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[2]);await start(1,{});
    const reported='지금 바꾼 서식에 맞춰서 제목이랑 목차 등등 다 생기게 몇장짜리로 표랑 섞어서 문서 전체를 다시써서 길게 뻥튀기해줘';
    expect(q('.achmage-writing-hint').hidden).toBe(true);
    await ask(reported);const router=sentAt(0);
    expect(router.prompt).toContain('[HOP 요청 해석]');expect(router.prompt).toContain(JSON.stringify(reported));expect(router.prompt).toContain('recompose_document');
    await complete(router.requestId,'{"action":"recompose_document","instruction":"현재 문서 전체를 한림대 일송 서식으로 제목·목차·표를 넣어 길게 다시 써줘"}');
    expect(sends()).toBe(2);const work=sentAt(1);expect(wholeGuard.capture).toHaveBeenCalledTimes(1);expect(work.prompt).toContain('열린 문서의 고유 본문');expect(work.prompt).toContain('요청 해석');
    expect(chat()).toContain(reported);expect(chat().some(t=>t?.includes('다시 구성합니다'))).toBe(true);expect(chat().some(t=>t?.includes('"action"'))).toBe(false);
    await complete(work.requestId,'{"schemaVersion":1,"kind":"block_patch","changes":[{"replace":"B1-B2","markdown":"# 정렬 시험 문서\\n\\n## 첫째 장\\n\\n본문"}]}');
    expect(kordocGuard.create).toHaveBeenCalledTimes(1);expect(kordocGuard.create.mock.calls[0][0]).toContain('## 첫째 장');expect(documentGuard.applyStructured).not.toHaveBeenCalled();
  });
  it('answers questions in one turn without touching the document and sends recent conversation as context',async()=>{
    await start(1,{});await ask('이 문서의 핵심이 뭐야?');const first=sentAt(0);
    await complete(first.requestId,'정렬을 원본 한글과 비교하는 시험 문서입니다.');
    expect(sends()).toBe(1);expect(chat()).toContain('정렬을 원본 한글과 비교하는 시험 문서입니다.');expect(documentGuard.apply).not.toHaveBeenCalled();
    await ask('그럼 아까 말한 걸 한 줄로 줄이면?');expect(sentAt(1).prompt).toContain('정렬을 원본 한글과 비교하는 시험 문서입니다.');
  });
  it('hides a streaming operation reply and offers clarification choices that run without another routing turn',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);await start(1,{});await ask('이거 좀 정리해줘');const router=sentAt(0);
    state={...state,generation:state.generation+5,turn:{id:router.requestId,requestId:router.requestId,status:'running',text:'{"action":"cla'}};await vi.advanceTimersByTimeAsync(600);
    expect(q('.achmage-answer').hidden).toBe(true);
    await complete(router.requestId,'{"action":"clarify","question":"문서 전체를 다시 구성할까요, 새 문서로 정리할까요?","options":[{"label":"현재 문서 다시 구성","action":"recompose_document"},{"label":"새 문서로 작성","action":"write_new_document"}]}');
    expect(chat()).toContain('문서 전체를 다시 구성할까요, 새 문서로 정리할까요?');
    const box=panel().querySelector('.achmage-clarify')!;expect(box.hidden).toBe(false);expect(box.children.map(b=>b.textContent)).toEqual(['현재 문서 다시 구성','새 문서로 작성']);
    await box.children[0].click();await flush();expect(sends()).toBe(2);expect(sentAt(1).prompt).toContain('열린 문서의 고유 본문');
  });
  it('refuses an operation the document cannot support instead of guessing another one',async()=>{
    await start(1,{});await ask('선택한 문단 글꼴을 바꿔줘');
    await complete(sentAt(0).requestId,'{"action":"format_selection","instruction":"글꼴 변경"}');
    expect(sends()).toBe(1);expect(q('.achmage-message').textContent).toContain('선택되지 않았습니다');expect(documentGuard.applyStructured).not.toHaveBeenCalled();
  });
  it('records a failed generation in the chat and retries the same work without another routing turn',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);await start(1,{});await ask('문서 전체를 길게 다시 써줘');
    await complete(sentAt(0).requestId,'{"action":"recompose_document","instruction":"길게 다시 쓰기"}');const work=sentAt(1);
    state={...state,generation:state.generation+5,turn:{id:work.requestId,requestId:work.requestId,status:'error',message:'응답 시간이 초과되었습니다.',text:'# 일부'}};await vi.advanceTimersByTimeAsync(600);
    expect(chat().some(t=>t?.startsWith('요청을 끝내지 못했습니다. 응답 시간이 초과되었습니다.'))).toBe(true);expect(kordocGuard.create).not.toHaveBeenCalled();
    const box=panel().querySelector('.achmage-clarify')!;expect(box.children.map(b=>b.textContent)).toEqual(['다시 시도']);
    await box.children[0].click();await flush();expect(sends()).toBe(3);expect(sentAt(2).prompt).toBe(work.prompt);expect(sentAt(2).requestId).not.toBe(work.requestId);
    await complete(sentAt(2).requestId,'{"schemaVersion":1,"kind":"block_patch","changes":[{"replace":"B1-B2","markdown":"# 정렬 시험 문서\\n\\n## 첫째 장\\n\\n본문"}]}');expect(kordocGuard.create).toHaveBeenCalledTimes(1);expect(box.hidden).toBe(true);
  });
  it('never sends personal identifiers and restores them before the chat or the document sees the reply',async()=>{
    await start(1,{});await ask('담당 연락처 010-1234-5678 넣어서 안내문 써줘');const router=sentAt(0);
    expect(router.prompt).not.toContain('010-1234-5678');expect(router.prompt).toContain('〔개인정보1〕');
    expect(q('.achmage-message').textContent).toContain('개인정보 1건(전화번호)을 가리고 보냈습니다');
    await complete(router.requestId,'안내문에는 〔개인정보1〕을 담당 연락처로 넣겠습니다.');
    expect(chat()).toContain('안내문에는 010-1234-5678을 담당 연락처로 넣겠습니다.');expect(chat().some(t=>t?.includes('〔개인정보'))).toBe(false);
  });
  it('restores masked values in a document edit and refuses replies with tokens it never sent',async()=>{
    await start();q('.achmage-prompt').value='여기 화면에 보이는 새 문서에 연락처 010-9999-8888 넣어서 안내문 3줄을 써봐';q('.achmage-prompt').dispatchEvent(event('input'));
    await btn('send').click();await flush();const work=sentAt(0);expect(work.prompt).not.toContain('010-9999-8888');
    await complete(work.requestId,'문의: 〔개인정보1〕\n둘째\n셋째');
    expect(documentGuard.apply).toHaveBeenCalledWith(expect.objectContaining({insertion:{}}),'문의: 010-9999-8888\n둘째\n셋째');
    documentGuard.apply.mockClear();q('.achmage-prompt').value='여기 화면에 보이는 새 문서에 연락처 010-9999-8888 넣어서 안내문 3줄을 써봐';q('.achmage-prompt').dispatchEvent(event('input'));
    await btn('send').click();await flush();await complete(sentAt(1).requestId,'문의: 〔개인정보5〕');
    expect(documentGuard.apply).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('〔개인정보5〕');
  });
  it('shows the stage with elapsed seconds, flags a stalled reply and reports AI and apply time separately',async()=>{
    let now=1000;vi.spyOn(performance,'now').mockImplementation(()=>now);
    await start();q('.achmage-prompt').value='여기 화면에 보이는 새 문서에 단편 소설 3줄을 써봐';q('.achmage-prompt').dispatchEvent(event('input'));
    await btn('send').click();await flush();const work=sentAt(0);
    now+=25_000;state={...state,generation:state.generation+5,turn:{id:work.requestId,requestId:work.requestId,status:'running'}};await vi.advanceTimersByTimeAsync(600);
    expect(q('.achmage-pending-label').textContent).toBe('답변을 준비하고 있어요 · 25초 · AI가 내용을 구상하고 있어요');
    state={...state,generation:state.generation+5,turn:{id:work.requestId,requestId:work.requestId,status:'running',text:'첫째'}};await vi.advanceTimersByTimeAsync(600);
    now+=31_000;state={...state,generation:state.generation+5};await vi.advanceTimersByTimeAsync(600);
    expect(q('.achmage-pending-label').textContent).toContain('31초째 새 내용이 없습니다');expect(btn('cancel-turn').classes.has('is-emphasized')).toBe(true);
    state={...state,busy:true,generation:state.generation+5};await vi.advanceTimersByTimeAsync(600);
    q('.achmage-prompt').value='또 보내기';q('.achmage-prompt').dispatchEvent(event('keydown',{key:'Enter',shiftKey:false,isComposing:false}));await flush();expect(q('.achmage-message').textContent).toBe('앞선 요청을 처리하고 있습니다. 끝날 때까지 기다리거나 ■ 버튼으로 중지하세요.');
    state={...state,busy:false};now+=2_000;await complete(work.requestId,'첫째\n둘째\n셋째');
    expect(q('.achmage-message').textContent).toMatch(/문서에 반영했습니다\. Ctrl\+Z로 되돌릴 수 있습니다\. \(AI 58초 · 적용 0\.0초\)$/);
  });
  it('inserts the previous answer without another model turn, and a new conversation stops sending old turns',async()=>{
    await start(1,{},{getSelection:()=>null,getCursorPosition:()=>({sectionIndex:0,paragraphIndex:0,charOffset:0})});await ask('회의 안내 문구 하나 제안해줘');await complete(sentAt(0).requestId,'다음 주 회의는 10시에 시작합니다.');
    await ask('이거 문서에 넣어줘');expect(sentAt(1).prompt).toContain('"lastAnswer":"다음 주 회의는 10시에 시작합니다."');
    await complete(sentAt(1).requestId,'{"action":"insert_answer"}');
    expect(sends()).toBe(2);expect(documentGuard.apply).toHaveBeenCalledWith(expect.objectContaining({insertion:{}}),'다음 주 회의는 10시에 시작합니다.');
    expect(q('.achmage-message').textContent).toContain('직전 답변을 커서 위치에 넣었습니다');
    await btn('new-conversation').click();await ask('새 질문');const fresh=sentAt(2).prompt;
    expect(fresh).not.toContain('회의 안내 문구');expect(fresh).toContain('"lastAnswer":null');
  });
  it('stops a routed edit when the caret moved while the model was deciding (review HIGH 1)',async()=>{
    let caret={sectionIndex:0,paragraphIndex:0,charOffset:0};
    const wasm=await start(1,{},{getSelection:()=>null,getCursorPosition:()=>caret}) as unknown as Record<string,unknown>;
    Object.assign(wasm,{getSectionCount:()=>1,getParagraphCount:()=>4,getParagraphLength:()=>2,getTextRange:()=>'본문',getControls:()=>[]});
    await ask('이 문단 공문체로 바꿔줘');
    caret={sectionIndex:0,paragraphIndex:3,charOffset:2};
    await complete(sentAt(0).requestId,'{"action":"edit_selection","instruction":"공문체로"}');
    expect(sends()).toBe(1);expect(q('.achmage-message').textContent).toContain('커서');expect(q('.achmage-prompt').value).toBe('이 문단 공문체로 바꿔줘');
  });
  it('never escalates a routed body edit into a template recomposition (review MED 3)',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);structureGuard.unsupported=true;structureGuard.Error=StructureUnsupportedError;
    try{
      const wasm=await start(1,{}) as unknown as Record<string,unknown>;
      Object.assign(wasm,{getSectionCount:()=>1,getParagraphCount:()=>2,getParagraphLength:()=>2,getTextRange:()=>'본문',getControls:()=>[]});
      await ask('문서 전체 맞춤법 고쳐줘');
      await complete(sentAt(0).requestId,'{"action":"edit_whole_body","instruction":"맞춤법"}');
      expect(sends()).toBe(1);expect(kordocGuard.create).not.toHaveBeenCalled();expect(q('.achmage-message').textContent).toContain('다시 구성하려면 그렇게 요청해 주세요');
    }finally{structureGuard.unsupported=false;}
  });
  it('sends inline caret requests through the router even when the edit toggle is on (review MED 5)',async()=>{
    await start(1,{});q('.achmage-edit-mode').checked=true;
    dom.dispatchEvent(Object.assign(new Event(PANEL_ASK_EVENT),{detail:{instruction:'앞 내용에 이어지는 문단을 써줘'}}));await flush();
    expect(sentAt(0).prompt).toContain('[HOP 요청 해석]');
  });
  it('asks before a whole-document rewrite the user did not scope, and keeps the selected template unless another is named (review MED 6)',async()=>{
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);await start(1,{});await ask('요약해줘');
    await complete(sentAt(0).requestId,'{"action":"recompose_document","templateId":"builtin-press","instruction":"보도자료로 재구성"}');
    expect(sends()).toBe(1);const box=panel().querySelector('.achmage-clarify')!;expect(box.children.map(b=>b.textContent)).toEqual(['진행','취소']);
    expect(chat().some(t=>t?.includes("'보고서' 서식으로 다시 구성합니다")&&t.includes('확인합니다'))).toBe(true);
    await box.children[1].click();expect(sends()).toBe(1);expect(q('.achmage-message').textContent).toContain('취소');
  });
  it('re-checks a clarification choice against the current caret before running it (review MED 7)',async()=>{
    let caret={sectionIndex:0,paragraphIndex:0,charOffset:0};templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);
    await start(1,{},{getSelection:()=>null,getCursorPosition:()=>caret});await ask('이거 좀 정리해줘');
    await complete(sentAt(0).requestId,'{"action":"clarify","question":"어떻게 할까요?","options":[{"label":"문서 다시 구성","action":"recompose_document"},{"label":"새 문서","action":"write_new_document"}]}');
    caret={sectionIndex:0,paragraphIndex:2,charOffset:0};
    await panel().querySelector('.achmage-clarify')!.children[0].click();await flush();
    expect(sends()).toBe(1);expect(q('.achmage-message').textContent).toContain('바뀌었습니다');
  });
  it('shows a JSON-looking answer that is not an operation as the answer',async()=>{
    await start(1,{});await ask('JSON 예시 보여줘');await complete(sentAt(0).requestId,'{"name":"홍길동","age":30}');
    expect(chat()).toContain('{"name":"홍길동","age":30}');expect(sends()).toBe(1);
  });
  it('restyles from the template window without any model call or sign-in (T08)',async()=>{
    fontGuard.available.mockImplementation(async(families:Iterable<string>)=>new Set(families));
    documentGuard.applyRestyle.mockReset().mockResolvedValue({paragraphs:5,summary:'제목 1 · 본문 4',kept:{frontMatter:0,layoutTables:1,nestedTables:0}});
    state={...state,auth:{status:'signed_out'} as AiState['auth']};templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);await start(1,{});
    dom.dispatchEvent(new Event(PANEL_RESTYLE_EVENT));await flush();await flush();
    expect(documentGuard.applyRestyle).toHaveBeenCalledTimes(1);expect(sends()).toBe(0);
    expect(q('.achmage-message').textContent).toContain('서식만 적용했습니다');expect(q('.achmage-message').textContent).toContain('디자인 표 1개');
    templateGuard.current=undefined;dom.dispatchEvent(new Event(PANEL_RESTYLE_EVENT));await flush();
    expect(documentGuard.applyRestyle).toHaveBeenCalledTimes(1);expect(q('.achmage-message').textContent).toContain('서식을 선택해 주세요');
  });
  it('runs a routed restyle locally: one routing turn, no generation turn',async()=>{
    fontGuard.available.mockImplementation(async(families:Iterable<string>)=>new Set(families));
    documentGuard.applyRestyle.mockReset().mockResolvedValue({paragraphs:2,summary:'본문 2',kept:{frontMatter:0,layoutTables:0,nestedTables:0}});
    templateGuard.current=structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]);await start(1,{});await ask('내용은 그대로 두고 양식만 이 서식으로 맞춰줘');
    await complete(sentAt(0).requestId,'{"action":"restyle_document","instruction":"서식만 맞춤"}');await flush();
    expect(sends()).toBe(1);expect(documentGuard.applyRestyle).toHaveBeenCalledTimes(1);expect(chat().some(t=>t?.includes('서식만 적용합니다(AI 없이)'))).toBe(true);
  });
  it('keeps explicit UI requests on the local route without a routing turn',async()=>{
    await start(1,{});q('.achmage-edit-mode').checked=true;await ask('더 간결하게 고쳐줘');
    expect(sentAt(0).prompt).not.toContain('[HOP 요청 해석]');expect(sentAt(0).prompt).toContain('선택 본문');
  });
});
