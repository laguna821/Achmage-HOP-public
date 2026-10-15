/** A discoverable toolbar entry over the same persisted theme commands as View. */
export function installThemeToggle(dispatch:(id:string)=>unknown):()=>void {
 const button=document.getElementById('achmage-theme-toggle');if(!button)return ()=>{};
 const icon=button.querySelector('.achmage-theme-icon')!,label=button.querySelector('.tb-label')!;
 const update=()=>{const dark=document.documentElement.dataset.themeEffective==='dark';label.textContent=dark?'다크':'라이트';button.title=dark?'현재 다크 테마 · 클릭하여 라이트로 전환':'현재 라이트 테마 · 클릭하여 다크로 전환';button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed',String(dark));icon.innerHTML='<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'+(dark?'<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>':'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>')+'</svg>';};
 button.onclick=()=>{dispatch(document.documentElement.dataset.themeEffective==='dark'?'view:theme-light':'view:theme-dark');};
 const observer=new MutationObserver(update);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme-effective']});update();
 return()=>{observer.disconnect();button.onclick=null;};
}
