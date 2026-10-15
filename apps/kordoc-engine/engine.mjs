import { markdownToHwpx, renderDocument, validateHwpx, agencyNames, agencyStyle, AGENCY_COMMON_NAME, normalizeGongmunPreset } from 'kordoc';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import MarkdownIt from 'markdown-it';
import { createHash } from 'node:crypto';
import { charHeights, repairCover } from './cover-repair.mjs';
import { normalizeLook, markExtendedHeadings, applyDocumentStyleXml, resolveGongmunOptions, prepareGongmunMarkdown, finishGongmunXml, insertContentsPage, paragraphSignature, repeatTableHeaderRows, addFootnoteAutoNumbers } from './hanmark-styles.mjs';

export const ENGINE={name:'kordoc',version:'4.21.31',sourceCommit:'f4e95b069d4f916365e5a13b5e6fc7b23f3f5c7c',auditedReferenceCommit:'1b860e9a606f4ce04f948092b174d998ce256bdc',packageIntegrity:'sha512-xtoznlbsQNbW4tsCXDLzhxRIBJNCROUSa/RDu8tL3Bzdju1YXAmgIaRXr/0I7ihTpjbnc1MT0OGZSxyFr7hRWg=='};
export const LIMITS={inputBytes:16*1024*1024,responseBytes:32*1024*1024,zipBytes:8*1024*1024,expandedBytes:32*1024*1024,pages:100,markdownBytes:null};
const ROLES=['title','heading','body','tableHeader','tableCell'],HP='http://www.hancom.co.kr/hwpml/2011/paragraph',HH='http://www.hancom.co.kr/hwpml/2011/head';
export const PRESETS=['official','report','plan','notice','minutes','gaejosik','press','ministry','bangchim'];
export const FRONT_PRESETS=['report','plan','gaejosik','ministry','bangchim'];
export const AGENCY_PRESETS=['report','plan','ministry','gaejosik','press'];
const NATIVE_TOC_PRESETS=['gaejosik','ministry','bangchim'];
const declaredFonts=value=>{const found=new Set();const visit=v=>{if(!v||typeof v!=='object')return;for(const [k,x]of Object.entries(v)){if(k==='font'&&typeof x==='string')found.add(x);else visit(x);}};visit(value);return [...found].sort();};
export function capabilities(){
 if(PRESETS.some(p=>normalizeGongmunPreset(p)!==p))fail('설치 엔진의 문서 종류가 고정 계약과 다릅니다.');
 return {engine:ENGINE,operations:['generate','render','validate'],limits:LIMITS,presets:[...PRESETS],coverPresets:[...FRONT_PRESETS],tocPresets:[...FRONT_PRESETS],coverTocPresets:[...FRONT_PRESETS],agencyPresets:[...AGENCY_PRESETS],agencies:[AGENCY_COMMON_NAME,...agencyNames()].map(name=>{const s=agencyStyle(name),effective={report:s.report??agencyStyle(AGENCY_COMMON_NAME).report,press:s.press??agencyStyle(AGENCY_COMMON_NAME).press,band:s.band??agencyStyle(AGENCY_COMMON_NAME).band};return {name,reportAvailable:!!s.report,pressAvailable:!!s.press,reportUsesCommonFallback:!s.report,style:structuredClone(s),fontFamilies:declaredFonts(effective),fontFamiliesByPreset:Object.fromEntries(AGENCY_PRESETS.map(p=>[p,declaredFonts(p==='press'?effective.press:effective.report)])),fontFamiliesScope:'agency-declared-including-common-fallback-not-all-preset-fonts'};}),agencyRoleOverrides:[...ROLES],tocPageNumbers:false,ocr:false,network:false};
}
const md=new MarkdownIt({html:false,linkify:false}),htmlAware=new MarkdownIt({html:true,linkify:false});
const fail=(m)=>{throw Error(m);};
function object(v,keys,required=keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||required.some(k=>!Object.hasOwn(v,k)))fail('잘못되거나 지원하지 않는 요청 속성입니다.');return v;}
function string(v,max=1000){if(typeof v!=='string'||(max!==null&&Buffer.byteLength(v)>max)||!v.isWellFormed()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v))fail('문자열 범위를 확인하세요.');return v;}
const children=(n,name)=>Array.from(n.childNodes??[]).filter(x=>x.nodeType===1&&(!name||x.localName===name));
const descendants=(n,name)=>Array.from(n.getElementsByTagNameNS('*',name));
const xml=(s)=>{if(/<!DOCTYPE|<!ENTITY/i.test(s))fail('XML 선언은 지원하지 않습니다.');const doc=new DOMParser({onError:(level,message)=>{if(level!=='warning')fail('잘못된 XML: '+message);}}).parseFromString(s,'text/xml');return doc;};
const serialize=(n)=>new XMLSerializer().serializeToString(n);
export function parseTemplate(t){
 object(t,['schemaVersion','id','name','category','provenance','description','roles','layout','look'],['schemaVersion','id','name','category','provenance','description','roles']);
 if(t.schemaVersion!==1||!['general','government','education','press','personal'].includes(t.category)||!['sample','personal'].includes(t.provenance))fail('템플릿 종류가 올바르지 않습니다.');
 string(t.id,100);string(t.name,320);string(t.description,4000);object(t.roles,ROLES);
 const roles={};for(const r of ROLES){const s=object(t.roles[r],['fontFamily','fontSizePt','bold','spacingPercent','alignment','lineSpacingPercent']);string(s.fontFamily,320);if(!s.fontFamily.trim()||/["'<>;,\\]/u.test(s.fontFamily)||typeof s.fontSizePt!=='number'||s.fontSizePt<5||s.fontSizePt>72||!Number.isInteger(s.fontSizePt*100)||typeof s.bold!=='boolean'||!Number.isInteger(s.spacingPercent)||Math.abs(s.spacingPercent)>50||!['left','center','right','justify'].includes(s.alignment)||!Number.isInteger(s.lineSpacingPercent)||s.lineSpacingPercent<50||s.lineSpacingPercent>500)fail('역할 서식이 올바르지 않습니다.');roles[r]={...s};}
 const l=t.layout??{enginePreset:t.category==='government'?'official':t.category==='press'?'press':'report',cover:t.category==='general'||t.category==='education',toc:t.category==='general'||t.category==='education',paper:'A4',orientation:'portrait',sampleMarkdown:'# '+t.name};
 object(l,['enginePreset','cover','toc','sampleMarkdown','paper','orientation','agency','agencyRoleOverrides'],['enginePreset','cover','toc','sampleMarkdown','paper','orientation']);string(l.sampleMarkdown,LIMITS.markdownBytes);
 if(!PRESETS.includes(l.enginePreset)||typeof l.cover!=='boolean'||typeof l.toc!=='boolean'||!['A4','A3','B4','B5','Letter'].includes(l.paper)||!['portrait','landscape'].includes(l.orientation))fail('문서 구성 값이 올바르지 않습니다.');
 if((l.cover||l.toc)&&!FRONT_PRESETS.includes(l.enginePreset))fail('이 프리셋은 현재 표지·목차 구성을 지원하지 않습니다.');
 if(l.agency!==undefined){string(l.agency,200);if(![AGENCY_COMMON_NAME,...agencyNames()].includes(l.agency))fail('설치 엔진에 없는 기관 서식입니다.');if(!AGENCY_PRESETS.includes(l.enginePreset))fail('이 문서 종류에는 기관 서식을 적용할 수 없습니다.');}
 if(l.agencyRoleOverrides!==undefined&&(!l.agency||!Array.isArray(l.agencyRoleOverrides)||l.agencyRoleOverrides.some(r=>!ROLES.includes(r))||new Set(l.agencyRoleOverrides).size!==l.agencyRoleOverrides.length))fail('기관 서식에서 덮어쓸 역할을 확인하세요.');
 if(t.look===undefined)return {...t,roles,layout:{...l}};
 // A HanMark look keeps Kordoc's own layout of the document type; it cannot be combined with an agency style.
 const look=normalizeLook(t.look);
 if(l.agency!==undefined)fail('기관 서식과 HanMark 서식은 함께 쓸 수 없습니다.');
 if(look.kind==='document'&&(l.cover||l.toc))fail('문서 스타일 템플릿은 표지·목차를 만들지 않습니다.');
 if(look.kind==='gongmun'&&l.enginePreset!==look.preset)fail('템플릿의 문서 종류와 서식 종류가 다릅니다.');
 return {...t,roles,layout:{...l},look};
}
/** Block role marks use U+E100…U+EFFF (3,840 blocks, about 150 pages); bold marks keep U+F000…U+F7FF. */
const MAX_BLOCK_MARKS=0xf000-0xe100;
/** Mark only newly generated input. No existing document is rewritten by role IDs. */
function markMarkdown(source){
 if(/[\ue000-\uf8ff]/u.test(source))fail('역할 식별 예약 문자는 입력에 사용할 수 없습니다.');
 const tokens=md.parse(source,{}),lines=source.split('\n'),edits=new Map(),marks=new Map();let currentRow=-1,rowOffset=0,cellRole='tableCell',heading=false;
 const add=(row,offset,role,content)=>{if(marks.size>=MAX_BLOCK_MARKS)fail('문서 블록이 너무 많습니다.');const mark=String.fromCodePoint(0xe100+marks.size);marks.set(mark,{role,content});const e=edits.get(row)??[];e.push({offset,mark});edits.set(row,e);};
 for(let i=0;i<tokens.length;i++){const t=tokens[i];
  if(['fence','code_block','html_block'].includes(t.type))fail('템플릿 역할 적용은 코드 블록/HTML을 아직 지원하지 않습니다.');
  if(t.type==='tr_open'){currentRow=t.map[0];rowOffset=0;}
  if(t.type==='th_open')cellRole='tableHeader';if(t.type==='td_open')cellRole='tableCell';
  if(t.type!=='inline')continue;
  if(t.children?.some(c=>['image','html_inline'].includes(c.type)))fail('이 생성 경로는 외부 이미지·HTML을 불러오지 않습니다.');
  const previous=tokens[i-1];heading=previous?.type==='heading_open';
  const row=t.map?.[0]??currentRow;if(row<0)fail('원문 역할 위치를 확인하지 못했습니다.');
  const content=t.content.split('\n')[0],from=t.map?0:rowOffset;let offset=lines[row].indexOf(content,from);
  if(!content){offset=lines[row].indexOf('|',from)+1;if(offset<=0)fail('빈 표 셀 위치를 확인하지 못했습니다.');}
  if(offset<0)fail('원문 역할 위치를 확인하지 못했습니다.');
  const plain=(t.children??[]).filter(c=>['text','code_inline','softbreak','hardbreak'].includes(c.type)).map(c=>c.type.endsWith('break')?' ':c.content).join('');
  add(row,offset,heading?(previous.tag==='h1'?'title':'heading'):t.map?'body':cellRole,plain);
  if(!t.map)rowOffset=offset+content.length;
 }
 for(const [row,items]of edits)for(const e of items.sort((a,b)=>b.offset-a.offset))lines[row]=lines[row].slice(0,e.offset)+e.mark+lines[row].slice(e.offset);
 const strongMarks=new Map();let serial=0;
 const marked=lines.join('\n').replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g,(whole,delimiter,content)=>{
  if(serial>=1024)fail('강조 구간이 너무 많습니다.');const start=String.fromCodePoint(0xf000+serial*2),end=String.fromCodePoint(0xf001+serial*2);
  const candidate=delimiter+start+content+end+delimiter;let depth=0,startSeen=false,endSeen=false;
  for(const c of md.parseInline(candidate,{})[0].children??[]){if(c.type==='strong_open')depth++;if(c.type==='strong_close')depth--;if(c.type==='text'){if(c.content.includes(start))startSeen=depth>0;if(c.content.includes(end))endSeen=depth>0;}}
  if(!startSeen||!endSeen)return whole;strongMarks.set(start,1);strongMarks.set(end,-1);serial++;return candidate;
 });
 // Verify markers are in actual strong tokens in their full paragraph context (escaped/intraword delimiters are literals).
 const accepted=new Set();for(const token of md.parse(marked,{})){let depth=0;for(const c of token.children??[]){if(c.type==='strong_open')depth++;if(c.type==='strong_close')depth--;if(c.type==='text'&&depth>0)for(const char of c.content)if(strongMarks.has(char))accepted.add(char);}}
 let cleaned=marked;for(const [char]of strongMarks)if(!accepted.has(char)){cleaned=cleaned.split(char).join('');strongMarks.delete(char);}
 const explicitStrongCount=tokens.reduce((n,t)=>n+(t.children??[]).filter(c=>c.type==='strong_open').length,0);
 if(strongMarks.size!==explicitStrongCount*2)fail('이 강조 구간의 경계를 확인하지 못했습니다. 여러 줄 강조는 한 줄 안으로 정리하세요.');
 return {markdown:cleaned,marks,strongMarks};
}
async function boundedZip(bytes){
 if(bytes.length>LIMITS.zipBytes)fail('HWPX 파일이 8MiB를 넘습니다.');
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
 if(end<0||bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0)fail('단일 ZIP 형식이 아닙니다.');
 const count=bytes.readUInt16LE(end+10),centralSize=bytes.readUInt32LE(end+12),centralOffset=bytes.readUInt32LE(end+16);
 if(count>2048||centralOffset+centralSize!==end)fail('ZIP 항목 범위를 확인하지 못했습니다.');
 let offset=centralOffset,expanded=0;const names=new Set();
 for(let i=0;i<count;i++){if(offset+46>end||bytes.readUInt32LE(offset)!==0x02014b50)fail('ZIP 중앙 목록이 올바르지 않습니다.');
  const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),size=bytes.readUInt32LE(offset+24),nameLen=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32);if(flags&1||![0,8].includes(method)||size===0xffffffff)fail('암호화/ZIP64/압축 형식은 지원하지 않습니다.');
  const next=offset+46+nameLen+extra+comment;if(next>end)fail('ZIP 항목 범위를 넘었습니다.');const name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(offset+46,offset+46+nameLen));
  if(names.has(name)||name.startsWith('/')||name.includes('\\')||name.split('/').includes('..'))fail('중복되거나 잘못된 ZIP 경로입니다.');names.add(name);expanded+=size;if(expanded>LIMITS.expandedBytes)fail('압축 해제 크기 제한을 넘습니다.');offset=next;
 }
 if(offset!==end)fail('ZIP 중앙 목록의 크기가 다릅니다.');const z=await JSZip.loadAsync(bytes);let total=0;
 const entries=Object.entries(z.files);if(entries.length>2048)fail('ZIP 항목이 너무 많습니다.');
 for(const [name,f]of entries){if(name.startsWith('/')||name.includes('\\')||name.split('/').includes('..')||f.unsafeOriginalName&&f.unsafeOriginalName!==name)fail('ZIP 경로가 올바르지 않습니다.');const size=f._data?.uncompressedSize??0;total+=size;if(size>LIMITS.expandedBytes||total>LIMITS.expandedBytes)fail('압축 해제 크기 제한을 넘습니다.');}
 return z;
}
function nextId(parent,name){return Math.max(-1,...children(parent,name).map(n=>Number(n.getAttribute('id'))))+1;}
function cloneStyle(parent,name,oldId,change,cache,key){if(cache.has(key))return cache.get(key);const source=children(parent,name).find(n=>n.getAttribute('id')===oldId);if(!source)fail('생성 스타일 참조가 없습니다.');const n=source.cloneNode(true),id=nextId(parent,name);n.setAttribute('id',String(id));change(n);parent.appendChild(n);parent.setAttribute('itemCnt',String(children(parent,name).length));cache.set(key,String(id));return String(id);}
/**
 * Kordoc writes no version.xml. Hancom 2024 prints its plain paragraph margins as physical HWPUNIT, but a
 * package without xmlVersion >= 1.4 is read by rhwp (HOP's editor) as legacy 2x units, so indents and
 * paragraph spacing showed at half size and stayed halved when applied into the open document.
 * Compared with Hancom 2024 printouts of test documents. The generator is named honestly.
 */
const VERSION_XML='<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="Achmage HOP (Kordoc 4.21.31)" appVersion="1"/>';
function ensureVersionXml(zip){if(!zip.file('version.xml'))zip.file('version.xml',VERSION_XML);}
async function applyRoles(bytes,template,marks,strongMarks){
 const zip=await boundedZip(bytes),head=xml(await zip.file('Contents/header.xml').async('string')),sec=xml(await zip.file('Contents/section0.xml').async('string'));
 const charParent=descendants(head,'charProperties')[0],paraParent=descendants(head,'paraProperties')[0],fontFaces=descendants(head,'fontface');
 if(!charParent||!paraParent||fontFaces.length!==7)fail('생성 스타일 테이블이 올바르지 않습니다.');
 const charCache=new Map(),paraCache=new Map(),fontCache=new Map(),assigned=new Map();let firstBody;
 const fontIds=(name)=>{if(fontCache.has(name))return fontCache.get(name);const ids=fontFaces.map(ff=>{let f=children(ff,'font').find(f=>f.getAttribute('face')===name);if(!f){f=children(ff,'font')[0]?.cloneNode(true);if(!f)fail('글꼴 테이블이 비었습니다.');f.setAttribute('id',String(nextId(ff,'font')));f.setAttribute('face',name);ff.appendChild(f);ff.setAttribute('fontCnt',String(children(ff,'font').length));}return f.getAttribute('id');});fontCache.set(name,ids);return ids;};
 const stylePara=(p,role)=>{if(template.layout.agency&&!(template.layout.agencyRoleOverrides??[]).includes(role))return;const s=template.roles[role];const old=p.getAttribute('paraPrIDRef');p.setAttribute('paraPrIDRef',cloneStyle(paraParent,'paraPr',old,n=>{const a=children(n,'align')[0],l=children(n,'lineSpacing')[0];if(!a||!l)fail('문단 스타일 요소가 없습니다.');a.setAttribute('horizontal',s.alignment.toUpperCase());l.setAttribute('type','PERCENT');l.setAttribute('value',String(s.lineSpacingPercent));},paraCache,old+':'+role));
  for(const r of children(p,'run')){const old=r.getAttribute('charPrIDRef');r.setAttribute('charPrIDRef',cloneStyle(charParent,'charPr',old,n=>{n.setAttribute('height',String(Math.round(s.fontSizePt*100)));const ref=children(n,'fontRef')[0],sp=children(n,'spacing')[0];if(!ref||!sp)fail('글자 스타일 요소가 없습니다.');const ids=fontIds(s.fontFamily);['hangul','latin','hanja','japanese','other','symbol','user'].forEach((lang,i)=>{ref.setAttribute(lang,ids[i]);sp.setAttribute(lang,String(s.spacingPercent));});if(!s.bold){for(const bold of children(n,'bold'))n.removeChild(bold);n.removeAttribute('bold');}else if(!children(n,'bold').length)n.appendChild(head.createElementNS(HH,'hh:bold'));},charCache,old+':'+role));}
 };
 for(const t of descendants(sec,'t')){let content=t.textContent??'',role;
  for(const [mark,info]of marks)if(content.includes(mark)){if(role&&role!==info.role)fail('문단 역할이 겹칩니다.');role=info.role;assigned.set(mark,(assigned.get(mark)??0)+1);content=content.split(mark).join('');}
  if(role){if(children(t).length)fail('역할 표시가 복합 개체와 겹칩니다.');t.textContent=content;let p=t.parentNode;while(p&&p.localName!=='p')p=p.parentNode;if(!p)fail('본문 문단이 없습니다.');stylePara(p,role);if(role!=='title'&&!firstBody){let top=p;while(top.parentNode!==sec.documentElement)top=top.parentNode;firstBody=top;}}
 }
 for(const [mark]of marks)if(!assigned.has(mark))fail('생성 중 원문 역할이 사라졌습니다.');
 // Explicit Markdown strong is independent of a role's default bold. Restore only marked runs after role defaults.
 let strongDepth=0;const seenStrong=new Set();
 for(const t of descendants(sec,'t')){let text='',bold=false;for(const char of t.textContent??''){const delta=strongMarks.get(char);if(delta){strongDepth+=delta;seenStrong.add(char);if(strongDepth<0||strongDepth>1)fail('강조 경계가 올바르지 않습니다.');}else{text+=char;if(strongDepth>0)bold=true;}}
  if(text!==t.textContent){if(children(t).length)fail('강조 경계에 복합 개체가 있습니다.');t.textContent=text;}
  if(bold&&text){const run=t.parentNode;if(run.localName!=='run')fail('강조 글자 구간을 확인하지 못했습니다.');const old=run.getAttribute('charPrIDRef');run.setAttribute('charPrIDRef',cloneStyle(charParent,'charPr',old,n=>{if(!children(n,'bold').length)n.appendChild(head.createElementNS(HH,'hh:bold'));},charCache,old+':explicitStrong'));}
 }
 if(strongDepth!==0||[...strongMarks.keys()].some(c=>!seenStrong.has(c)))fail('강조 구간을 생성 결과에서 확인하지 못했습니다.');
 const warnings=[];
 if(template.layout.toc&&!NATIVE_TOC_PRESETS.includes(template.layout.enginePreset)){
  const headings=[...marks.values()].filter(v=>v.role==='heading');if(!headings.length)fail('목차에는 소제목이 필요합니다.');
  if(!firstBody)fail('목차 뒤 본문 위치가 없습니다.');
  const make=(text,role,breakBefore=false)=>{const p=sec.createElementNS(HP,'hp:p');p.setAttribute('id',String(900000+descendants(sec,'p').length));p.setAttribute('paraPrIDRef','0');p.setAttribute('styleIDRef','0');if(breakBefore)p.setAttribute('pageBreak','1');const r=sec.createElementNS(HP,'hp:run');r.setAttribute('charPrIDRef','0');const t=sec.createElementNS(HP,'hp:t');t.textContent=text;r.appendChild(t);p.appendChild(r);stylePara(p,role);sec.documentElement.insertBefore(p,firstBody);};
  make('목차','heading',template.layout.cover);for(const h of headings)make(h.content,'body');firstBody.setAttribute('pageBreak','1');warnings.push('목차는 소제목 목록입니다. 자동 쪽번호 필드는 아직 제공하지 않습니다.');
 }
 for(const n of descendants(sec,'linesegarray'))n.parentNode.removeChild(n);
 zip.file('Contents/header.xml',serialize(head));zip.file('Contents/section0.xml',serialize(sec));zip.file('Preview/PrvText.txt',descendants(sec,'t').map(t=>t.textContent).join('\n'));
 zip.file('mimetype','application/hwp+zip',{compression:'STORE'});ensureVersionXml(zip);for(const f of Object.values(zip.files))f.date=new Date('2000-01-01T00:00:00Z');
 return {bytes:Buffer.from(await zip.generateAsync({type:'uint8array',compression:'DEFLATE'})),warnings};
}
function safeSvg(svg){const d=xml(svg);for(const n of [d.documentElement,...Array.from(d.getElementsByTagName('*'))]){if(['script','foreignObject','iframe','object','embed','animate','set'].includes(n.localName)||n.localName==='style'&&/@import|url\(/i.test(n.textContent??''))fail('미리보기에 실행 가능한 요소가 있습니다.');for(const a of Array.from(n.attributes??[])){if(/^on/i.test(a.name)||/(?:href|src)$/i.test(a.name)&&a.value&&!a.value.startsWith('#')&&!/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(a.value)||/url\(\s*["']?(?:https?:|file:|\/\/)/i.test(a.value))fail('미리보기의 외부 참조를 지원하지 않습니다.');}}return svg;}
export async function renderBytes(bytes){
 const z=await boundedZip(bytes);const validation=await validateHwpx(bytes);if(!validation.ok)fail('HWPX 검증 실패: '+validation.issues.map(x=>x.message).join('; ').slice(0,1000));
 const rendered=await renderDocument(bytes,{format:'svg',reflow:true,maxImageBytes:4*1024*1024});
 // A long document is still generated in full; only the first LIMITS.pages pages get an SVG preview.
 if(rendered.assets.length<1)fail('미리보기 쪽을 만들지 못했습니다.');
 const pageCount=rendered.assets.length,pages=rendered.assets.slice(0,LIMITS.pages).map(a=>({svg:safeSvg(String(a.data)),width:a.width,height:a.height}));
 const head=xml(await z.file('Contents/header.xml').async('string')),charStyles=new Map(descendants(head,'charPr').map(n=>[n.getAttribute('id'),n])),fontFaces=new Map(descendants(head,'fontface').map(n=>[n.getAttribute('lang').toLowerCase(),new Map(children(n,'font').map(f=>[f.getAttribute('id'),f.getAttribute('face')]))])),fontFamilies=new Set();
 for(const [name,f]of Object.entries(z.files))if(/^Contents\/section\d+\.xml$/.test(name)){const s=xml(await f.async('string'));for(const run of descendants(s,'run')){const cp=charStyles.get(run.getAttribute('charPrIDRef'));if(!cp)fail('문서 글자 스타일 참조를 확인하지 못했습니다.');const ref=children(cp,'fontRef')[0];if(!ref)fail('문서 글꼴 참조를 확인하지 못했습니다.');for(const lang of ['hangul','latin','hanja','japanese','other','symbol','user']){const family=fontFaces.get(lang)?.get(ref.getAttribute(lang));if(!family)fail('문서의 사용 글꼴을 확인하지 못했습니다.');fontFamilies.add(family);}}}
 return {engine:ENGINE,hwpxBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),pages,pageCount,warnings:rendered.scene.warnings??[],validation,fontFamilies:[...fontFamilies].sort(),fontFamiliesScope:'all-language-font-references-of-used-run-charPr'};
}
/** Same input guard as the role path: no raw HTML, no external images (nothing is fetched). */
function guardLookMarkdown(source){
 if(/[-]/u.test(source))fail('역할 식별 예약 문자는 입력에 사용할 수 없습니다.');
 // Parsed with HTML recognition on, so raw tags are found instead of passing through as text.
 for(const t of htmlAware.parse(source,{})){if(t.type==='html_block'||t.children?.some(c=>c.type==='html_inline'))fail('이 생성 경로는 HTML을 지원하지 않습니다.');if(t.children?.some(c=>['image','html_inline'].includes(c.type)))fail('이 생성 경로는 외부 이미지·HTML을 불러오지 않습니다.');}
}
const FINISH_LABELS={markers:'항목 부호',tableHeader:'표 머리행 색',title:'제목 크기',chapter:'절 제목','cover':'표지','cover.removeInfoBox':'표지 정보 상자','cover.barColors':'표지 선 색','cover.lines':'표지 글자','cover.removeBodyTitle':'본문 제목 상자'};
/** HanMark look: Kordoc's own layout of the document type plus the style's options and finishing. */
/** Kordoc's cover date and info box label widths (cover-repair.mjs); bytes are returned as they were when nothing matches. */
async function repairGeneratedCover(raw){
 const zip=await boundedZip(raw),heights=charHeights(await zip.file('Contents/header.xml').async('string'));let changed=false;
 for(const name of Object.keys(zip.files).filter(n=>/^Contents\/section\d+\.xml$/.test(n))){const r=repairCover(await zip.file(name).async('string'),heights);if(r.dates||r.labels){zip.file(name,r.xml);changed=true;}}
 if(!changed)return raw;
 zip.file('mimetype','application/hwp+zip',{compression:'STORE'});ensureVersionXml(zip);for(const f of Object.values(zip.files))f.date=new Date('2000-01-01T00:00:00Z');
 return Buffer.from(await zip.generateAsync({type:'uint8array',compression:'DEFLATE'}));
}
async function generateWithLook(template,markdown){
 const l=template.layout,look=template.look,warnings=[],notices=[];guardLookMarkdown(markdown);
 const title=/^\s{0,3}#[ \t]+\S/mu.test(markdown),chapters=/^\s{0,3}##[ \t]+\S/mu.test(markdown);
 if(l.cover&&!title)fail('표지를 만들려면 # 제목이 필요합니다.');
 if(l.toc&&!chapters)fail('목차에는 소제목이 필요합니다.');
 let zip,header,sections;
 const load=async raw=>{zip=await boundedZip(raw);header=await zip.file('Contents/header.xml').async('string');sections=Object.keys(zip.files).filter(n=>/^Contents\/section\d+\.xml$/.test(n)).sort();if(!sections.length)fail('생성 문서에 본문 구역이 없습니다.');};
 if(look.kind==='document'){
  const marked=markExtendedHeadings(markdown,look.profile);
  await load(Buffer.from(await markdownToHwpx(marked.markdown,{page:{size:l.paper,orientation:l.orientation},warnings})));
  if(look.profile){if(sections.length!==1)fail('문서 스타일은 한 구역 문서에만 적용합니다.');const styled=applyDocumentStyleXml(header,await zip.file(sections[0]).async('string'),look.profile,marked.markers);header=styled.header;zip.file(sections[0],styled.section);}
 }else{
  const {options,closing}=resolveGongmunOptions(look,l,new Date());
  const native=NATIVE_TOC_PRESETS.includes(look.preset);options.toc=l.toc&&native;options.autoFit??=false;
  const prepared=prepareGongmunMarkdown(markdown,{preset:look.preset,numbering:options.numbering,h2Marker:options.h2Marker,...look.outline,closing});
  await load(await repairGeneratedCover(Buffer.from(await markdownToHwpx(prepared.markdown,{gongmun:options,page:{size:l.paper,orientation:l.orientation},warnings}))));
  const spec={...look.finish,paragraphs:prepared.paragraphs.some(h=>h.depth>0)?prepared.paragraphs:undefined,closing:closing?.date?{key:paragraphSignature(closing.date)}:undefined,fitFrames:true},missed=new Set();
  for(const name of sections){const done=finishGongmunXml(await zip.file(name).async('string'),header,spec);header=done.header;zip.file(name,done.section);done.missed.forEach(m=>missed.add(m));}
  // Markers, table headers and chapters can simply be absent from a short text; only a missed cover or title is a real loss.
  const lost=[...missed].filter(m=>m.startsWith('cover')?l.cover&&look.finish?.cover:m==='title'&&look.finish?.title&&title);
  if(lost.length)notices.push('기관 서식 일부를 적용하지 못했습니다: '+[...new Set(lost.map(m=>FINISH_LABELS[m]??m))].join(', '));
  if(l.toc&&!native){if(sections.length!==1)fail('목차는 한 구역 문서에만 넣을 수 있습니다.');const done=insertContentsPage(await zip.file(sections[0]).async('string'),header,prepared.chapters,{afterCover:l.cover,marker:options.h2Marker??'roman'});header=done.header;zip.file(sections[0],done.section);notices.push('목차는 소제목 목록입니다. 자동 쪽번호 필드는 아직 제공하지 않습니다.');}
  if(l.toc&&native)notices.push('목차는 Kordoc 원본 구성입니다. 자동 쪽번호 필드는 제공하지 않습니다.');
 }
 const texts=[];
 for(const name of sections){let s=await zip.file(name).async('string');s=repeatTableHeaderRows(s).xml;s=addFootnoteAutoNumbers(s).xml;
  // Metrics changed after Kordoc's layout: drop its line cache so editors lay the text out again.
  s=s.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g,'').replace(/<hp:linesegarray\/>/g,'');zip.file(name,s);for(const m of s.matchAll(/<hp:t>([^<]*)<\/hp:t>/g))texts.push(m[1]);}
 zip.file('Contents/header.xml',header);xml(header);for(const name of sections)xml(await zip.file(name).async('string'));
 zip.file('Preview/PrvText.txt',texts.join('\n'));zip.file('mimetype','application/hwp+zip',{compression:'STORE'});ensureVersionXml(zip);for(const f of Object.values(zip.files))f.date=new Date('2000-01-01T00:00:00Z');
 const bytes=Buffer.from(await zip.generateAsync({type:'uint8array',compression:'DEFLATE'})),result=await renderBytes(bytes);
 const quiet=look.kind==='gongmun'?look.quietEngineNotes??[]:[],engineNotes=[...new Set(warnings.filter(w=>!quiet.some(q=>w.startsWith(q))))];
 return {...result,warnings:[...engineNotes,...notices,...result.warnings,'미리보기는 Kordoc 조판 결과입니다. 로컬 글꼴 유무와 HOP/한글의 조판 결과는 다를 수 있습니다.']};
}
export async function generateDocument(templateValue,markdown){
 const template=parseTemplate(templateValue);string(markdown,LIMITS.markdownBytes);if(!markdown.trim())fail('본문을 입력하세요.');
 if(template.look)return generateWithLook(template,markdown);
 const marked=markMarkdown(markdown),warnings=[];
 if(template.layout.cover&&![...marked.marks.values()].some(m=>m.role==='title'))fail('표지를 만들려면 # 제목이 필요합니다.');
 const l=template.layout,b=template.roles.body;
 if(l.toc&&![...marked.marks.values()].some(m=>m.role==='heading'))fail('목차에는 소제목이 필요합니다.');
 const gongmun={preset:l.enginePreset,cover:l.cover,toc:l.toc&&NATIVE_TOC_PRESETS.includes(l.enginePreset),autoFit:false,...(l.agency?{agency:l.agency}:{bodyPt:b.fontSizePt,lineSpacing:b.lineSpacingPercent,fonts:{body:b.fontFamily,heading:template.roles.heading.fontFamily,table:template.roles.tableCell.fontFamily}})};
 const generated=await repairGeneratedCover(Buffer.from(await markdownToHwpx(marked.markdown,{gongmun,page:{size:l.paper,orientation:l.orientation},warnings})));
 if(l.agency&&l.enginePreset!=='press'&&!agencyStyle(l.agency).report)warnings.push(`기관 ${l.agency}: 보고서 실측 규칙이 없어 공통 서식을 사용합니다.`);
 if(l.agency)warnings.push(`기관 ${l.agency}의 엔진 기본 서식을 사용합니다. 명시한 역할만 덮어씁니다: ${(l.agencyRoleOverrides??[]).join(', ')||'없음'}. 공식 제출 수용 인증은 아닙니다.`);
 if(l.toc&&NATIVE_TOC_PRESETS.includes(l.enginePreset))warnings.push('목차는 Kordoc 원본 구성입니다. 자동 쪽번호 필드는 제공하지 않습니다.');
 const styled=await applyRoles(generated,template,marked.marks,marked.strongMarks),result=await renderBytes(styled.bytes);
 return {...result,warnings:[...warnings,...styled.warnings,...result.warnings,'미리보기는 Kordoc 조판 결과입니다. 로컬 글꼴 유무와 HOP/한글의 조판 결과는 다를 수 있습니다.']};
}
export async function handleRequest(value){
 const q=object(value,['id','op','template','markdown','hwpxBase64'],['id','op']);string(q.id,100);if(!q.id)fail('요청 ID가 필요합니다.');
 if(q.op==='capabilities'){object(q,['id','op']);return capabilities();}
 if(q.op==='generate'){object(q,['id','op','template','markdown']);return generateDocument(q.template,q.markdown);}
 if(q.op==='render'||q.op==='validate'){object(q,['id','op','hwpxBase64']);string(q.hwpxBase64,12*1024*1024);if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(q.hwpxBase64))fail('base64 데이터가 올바르지 않습니다.');const bytes=Buffer.from(q.hwpxBase64,'base64');await boundedZip(bytes);if(q.op==='validate')return {engine:ENGINE,sha256:createHash('sha256').update(bytes).digest('hex'),validation:await validateHwpx(bytes)};return renderBytes(bytes);}
 fail('지원하지 않는 작업입니다.');
}
