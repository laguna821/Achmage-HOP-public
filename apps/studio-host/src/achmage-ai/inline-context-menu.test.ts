import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {AchmageContextMenu,registerInlineMenuProvider} from './inline-context-menu';
class El extends EventTarget {
 children:El[]=[];parentElement:El|null=null;className='';textContent='';title='';tabIndex=0;dataset:Record<string,string>={};attrs=new Map<string,string>();style={left:'',top:''};
 classList={contains:(s:string)=>this.className.split(' ').includes(s),add:(s:string)=>{this.className+=' '+s;}};
 appendChild(e:El){e.remove();e.parentElement=this;this.children.push(e);return e;}
 prepend(...es:El[]){for(const e of [...es].reverse()){e.remove();e.parentElement=this;this.children.unshift(e);}}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);this.parentElement=null;}
 querySelectorAll<T=El>(q:string):T[]{return this.children.flatMap(c=>[...(c.classList.contains(q.slice(1))?[c as T]:[]),...c.querySelectorAll<T>(q)]);}
 setAttribute(k:string,v:string){this.attrs.set(k,v);}getAttribute(k:string){return this.attrs.get(k)??null;}
 contains(e:unknown):boolean{return e===this||this.children.some(c=>c.contains(e));}
 get isConnected(){return doc.body.contains(this);}
 focus(){doc.activeElement=this;}
 click(){this.dispatchEvent(new Event('click',{cancelable:true}));}
 getBoundingClientRect(){return {width:230,height:this.children.length*24,left:0,right:230,top:0,bottom:200};}
}
class Doc extends EventTarget {
 body=new El();activeElement:El|null=null;
 createElement(){return new El();}createTextNode(text:string){const el=new El();el.textContent=text;return el;}
 querySelectorAll<T=El>(q:string):T[]{return this.body.querySelectorAll<T>(q);}
}
let doc:Doc,frames:Array<()=>void>,menu:AchmageContextMenu,editor:El,dispatch:ReturnType<typeof vi.fn>,clean:(()=>void)|undefined;
const key=(k:string)=>{const e=new Event('keydown',{cancelable:true});Object.defineProperty(e,'key',{value:k});window.dispatchEvent(e);return e;};
const show=()=>{menu.show(795,595,[{type:'command',commandId:'copy'},{type:'separator'},{type:'command',commandId:'delete'}]);frames.splice(0).forEach(f=>f());return doc.querySelectorAll<El>('.context-menu')[0];};
beforeEach(()=>{doc=new Doc();frames=[];vi.stubGlobal('document',doc);vi.stubGlobal('HTMLElement',El);vi.stubGlobal('window',Object.assign(new EventTarget(),{innerWidth:800,innerHeight:600}));vi.stubGlobal('requestAnimationFrame',(fn:()=>void)=>{frames.push(fn);return frames.length;});editor=new El();doc.body.appendChild(editor);editor.focus();dispatch=vi.fn();menu=new AchmageContextMenu({dispatch,isEnabled:(id:string)=>id!=='delete'} as never,{get:(id:string)=>({label:id})} as never);});
afterEach(()=>{menu.dispose();clean?.();clean=undefined;vi.unstubAllGlobals();});
describe('real upstream context menu plus local AI row',()=>{
 it('prepends AI inside the actual menu, preserves every upstream row and clamps after insertion',()=>{const choose=vi.fn();clean=registerInlineMenuProvider(()=>({label:'AI로 선택 영역 편집…',choose}));const el=show(),rows=el.querySelectorAll<El>('.md-item');expect(rows.map(x=>x.dataset.cmd??'ai')).toEqual(['ai','copy','delete']);expect(el.children[1].className).toBe('md-sep');expect(el.getAttribute('role')).toBe('menu');expect(el.style.left).toBe('568px');expect(el.style.top).toBe('478px');const down=new Event('mousedown',{cancelable:true});rows[0].dispatchEvent(down);expect(down.defaultPrevented).toBe(true);expect(doc.activeElement).toBe(editor);rows[0].click();expect(choose).toHaveBeenCalledOnce();expect(menu.isOpen).toBe(false);expect(dispatch).not.toHaveBeenCalled();});
 it('shows several local rows in order above one separator, each running its own action',()=>{const ai=vi.fn(),toc=vi.fn();clean=registerInlineMenuProvider(()=>[{label:'AI로 선택 영역 편집…',choose:ai},{label:'목차 쪽 번호 새로 고침 (AI 없이)',choose:toc}]);const el=show(),rows=el.querySelectorAll<El>('.md-item');expect(rows.slice(0,2).map(r=>r.textContent)).toEqual(['AI로 선택 영역 편집…','목차 쪽 번호 새로 고침 (AI 없이)']);expect(el.children[2].className).toBe('md-sep');rows[1].click();expect(toc).toHaveBeenCalledTimes(1);expect(ai).not.toHaveBeenCalled();});
 it('an empty list adds nothing to the upstream menu',()=>{clean=registerInlineMenuProvider(()=>[]);const el=show();expect(el.querySelectorAll<El>('.achmage-context-ai')).toHaveLength(0);});
 it('keeps upstream command execution and disabled items untouched',()=>{clean=registerInlineMenuProvider(()=>null);const el=show(),rows=el.querySelectorAll<El>('.md-item');rows[1].click();expect(dispatch).not.toHaveBeenCalled();rows[0].click();expect(dispatch).toHaveBeenCalledWith('copy');expect(menu.isOpen).toBe(false);});
 it('supports arrows/home/end/enter, skips disabled rows and restores editor focus',()=>{const choose=vi.fn();clean=registerInlineMenuProvider(()=>({label:'AI',choose}));const el=show(),rows=el.querySelectorAll<El>('.md-item');expect(key('ArrowDown').defaultPrevented).toBe(true);expect(doc.activeElement).toBe(rows[0]);key('ArrowUp');expect(doc.activeElement).toBe(rows[1]);key('Home');expect(doc.activeElement).toBe(rows[0]);key('End');expect(doc.activeElement).toBe(rows[1]);key('Home');key('Enter');expect(choose).toHaveBeenCalledOnce();expect(doc.activeElement).toBe(editor);expect(menu.isOpen).toBe(false);});
 it('Escape/Tab/outside click close without editing or discarding the selected text',()=>{clean=registerInlineMenuProvider(()=>({label:'AI',choose:()=>{throw Error('must not run');}}));show();key('ArrowDown');key('Escape');expect(menu.isOpen).toBe(false);expect(doc.activeElement).toBe(editor);show();key('ArrowDown');key('Tab');expect(menu.isOpen).toBe(false);show();doc.dispatchEvent(new Event('mousedown'));expect(menu.isOpen).toBe(false);expect(dispatch).not.toHaveBeenCalled();});
 it('unsupported selection is an accessible disabled first item with a concrete reason',()=>{const choose=vi.fn();clean=registerInlineMenuProvider(()=>({label:'AI',disabledReason:'표 셀은 지원하지 않습니다.',choose}));const el=show(),rows=el.querySelectorAll<El>('.md-item');expect(rows[0].title).toContain('표 셀');expect(rows[0].getAttribute('aria-disabled')).toBe('true');rows[0].click();expect(choose).not.toHaveBeenCalled();key('ArrowDown');expect(doc.activeElement).toBe(rows[1]);});
 it('each new menu captures again, removal restores the original menu and duplicate registration is rejected',()=>{const p=vi.fn(()=>({label:'AI',choose:vi.fn()}));clean=registerInlineMenuProvider(p);expect(()=>registerInlineMenuProvider(p)).toThrow('이미');show();show();expect(p).toHaveBeenCalledTimes(2);expect(doc.querySelectorAll('.context-menu')).toHaveLength(1);clean();clean=undefined;expect(show().querySelectorAll('.md-item')).toHaveLength(2);});
});
