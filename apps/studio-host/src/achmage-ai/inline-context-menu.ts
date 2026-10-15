import { ContextMenu, type ContextMenuItem } from '@/upstream/ui';

/** `choose` receives the right-click point so the inline editor opens next to the selection. */
export interface InlineMenuEntry { label:string; disabledReason?:string; choose(anchor:{x:number;y:number}):void }
type Entries=InlineMenuEntry|readonly InlineMenuEntry[]|null;
let provider:(()=>Entries)|null=null;
/** Only the current editor's inline controller supplies entries (one or several); no global document lookup. */
export function registerInlineMenuProvider(next:()=>Entries):()=>void {
  if(provider)throw Error('선택 편집 메뉴가 이미 연결되어 있습니다.');
  provider=next;return()=>{if(provider===next)provider=null;};
}

/** Local extension of the real HOP menu. Every original command and handler remains intact. */
export class AchmageContextMenu extends ContextMenu {
  private keyboard:((e:KeyboardEvent)=>void)|null=null;
  private menu:HTMLElement|null=null;
  private returnFocus:HTMLElement|null=null;
  override show(x:number,y:number,items:ContextMenuItem[]):void {
    this.hide();
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const existing=new Set(document.querySelectorAll('.context-menu'));
    super.show(x,y,items);
    const menu=Array.from(document.querySelectorAll<HTMLElement>('.context-menu')).find(el=>!existing.has(el));
    if(!menu)return;
    this.menu=menu;this.returnFocus=previous;
    const supplied=provider?.(),entries=supplied?(Array.isArray(supplied)?supplied:[supplied as InlineMenuEntry]):[];
    if(entries.length){
      const rows=entries.map(entry=>{
        const row=document.createElement('div');row.className='md-item achmage-context-ai';row.textContent=entry.label;
        if(entry.disabledReason){row.classList.add('disabled');row.title=entry.disabledReason;row.setAttribute('aria-disabled','true');}
        row.addEventListener('mousedown',e=>e.preventDefault());
        row.addEventListener('click',e=>{e.stopPropagation();if(entry.disabledReason)return;this.hide();entry.choose({x,y});});
        return row;
      });
      const sep=document.createElement('div');sep.className='md-sep';sep.setAttribute('role','separator');
      menu.prepend(...rows,sep);
    }
    menu.setAttribute('role','menu');menu.setAttribute('aria-label','문서 편집');
    const rows=Array.from(menu.querySelectorAll<HTMLElement>('.md-item'));
    for(const row of rows){row.setAttribute('role','menuitem');row.tabIndex=-1;row.addEventListener('mousedown',e=>e.preventDefault());if(row.classList.contains('disabled'))row.setAttribute('aria-disabled','true');}
    const enabled=()=>rows.filter(row=>!row.classList.contains('disabled'));
    this.keyboard=e=>{
      if(!this.menu||!['ArrowDown','ArrowUp','Home','End','Enter',' ','Tab','Escape'].includes(e.key))return;
      e.preventDefault();e.stopImmediatePropagation();
      if(e.key==='Tab'||e.key==='Escape'){this.hide();return;}
      const choices=enabled();if(!choices.length)return;
      const index=choices.indexOf(document.activeElement as HTMLElement);
      if(e.key==='Enter'||e.key===' '){if(index>=0)choices[index].click();else choices[0].focus();return;}
      const next=e.key==='Home'?0:e.key==='End'?choices.length-1:e.key==='ArrowUp'?(index<=0?choices.length-1:index-1):(index+1)%choices.length;
      choices[next].focus();
    };
    // Window capture runs before upstream/editor document listeners: ESC closes just this menu,
    // without also cancelling the editor's text selection underneath it.
    window.addEventListener('keydown',this.keyboard,true);
    // The additional row can make the upstream viewport correction stale.
    const rect=menu.getBoundingClientRect();
    menu.style.left=`${Math.max(0,Math.min(x,window.innerWidth-rect.width-2))}px`;
    menu.style.top=`${Math.max(0,Math.min(y,window.innerHeight-rect.height-2))}px`;
    // Retain editor focus for mouse selection; keyboard navigation focuses a menu item on demand.
  }
  override hide():void {
    const restore=this.menu?.contains(document.activeElement)&&this.returnFocus?.isConnected?this.returnFocus:null;
    if(this.keyboard)window.removeEventListener('keydown',this.keyboard,true);
    this.keyboard=null;this.menu=null;this.returnFocus=null;super.hide();restore?.focus();
  }
}
