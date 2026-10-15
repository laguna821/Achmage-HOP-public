import type { AiDocument } from './document';
import type { InputHandler } from '@/upstream/editor';
import type { EventBus } from '@/upstream/core';
import type { RhwpDocumentStateV1 } from '@/upstream/document-agent';
import { cancelImagePlacement } from '@/upstream/editor';

export interface GeneratedImage { bytes: Uint8Array; mime: 'image/png'|'image/jpeg'|'image/webp' }
export interface DecodedImage extends GeneratedImage { width: number; height: number }
export function validateGeneratedImage(image: GeneratedImage): void {
  const b=image.bytes;
  if (!(b instanceof Uint8Array) || b.length < 12 || b.length > 20*1024*1024) throw new Error('이미지는 20 MiB 이하의 PNG/JPEG/WebP여야 합니다.');
  const match=image.mime==='image/png' ? [137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v) : image.mime==='image/jpeg' ? b[0]===255 && b[1]===216 && b[2]===255 : image.mime==='image/webp' && String.fromCharCode(...b.slice(0,4))==='RIFF' && String.fromCharCode(...b.slice(8,12))==='WEBP';
  if (!match) throw new Error('이미지 형식과 바이트가 일치하지 않습니다.');
}
export async function decodeGeneratedImage(image: GeneratedImage): Promise<DecodedImage> {
  validateGeneratedImage(image);
  const copy=new Uint8Array(image.bytes), url=URL.createObjectURL(new Blob([copy],{type:image.mime}));
  try {
    const img=new Image();
    await new Promise<void>((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error('이미지 파일을 해석하지 못했습니다.'));img.src=url;});
    validateDimensions(img.naturalWidth,img.naturalHeight);
    return {bytes:copy,mime:image.mime,width:img.naturalWidth,height:img.naturalHeight};
  } finally { URL.revokeObjectURL(url); }
}
function validateDimensions(w:number,h:number):void {
  if (!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<1||h<1||w>16384||h>16384||w*h>64*1024*1024) throw new Error('이미지 크기가 지원 범위를 넘습니다.');
}
/** The actual upstream placement operation owns insertion and shared Undo, not this helper. */
export class ImageDocument {
  private pending: RhwpDocumentStateV1|null=null;
  private unsubscribe: (()=>void)[]=[];
  constructor(private doc: Pick<AiDocument,'identity'|'owns'>, private input: Pick<InputHandler,'enterImagePlacementMode'>, private surface: HTMLElement, eventBus: EventBus, private notify: (message:string)=>void=()=>{}, private cancel=()=>cancelImagePlacement.call(input)) {
    for(const event of ['document-mutated','document-loaded','document-opened']) this.unsubscribe.push(eventBus.on(event,()=>{if(this.pending&&!this.doc.owns(this.pending))this.stop('문서가 바뀌어 그림 배치를 취소했습니다.');}));
    surface.addEventListener('mousedown',this.beforePointer,true); surface.addEventListener('mouseup',this.beforePointer,true);
    surface.addEventListener('keydown',this.beforeKey,true);
  }
  capture(): RhwpDocumentStateV1 { const state=this.doc.identity(); if(state.pageCount<1)throw new Error('그림을 넣을 문서를 먼저 여세요.');return {...state}; }
  async prepare(identity: RhwpDocumentStateV1, image: GeneratedImage, decode=decodeGeneratedImage): Promise<void> {
    if(!this.doc.owns(identity))throw new Error('이미지를 요청한 문서가 바뀌었습니다.');
    const decoded=await decode(image); this.begin(identity,decoded);
  }
  begin(identity: RhwpDocumentStateV1, image: DecodedImage): void {
    validateGeneratedImage(image);validateDimensions(image.width,image.height);
    if(!this.doc.owns(identity))throw new Error('이미지를 요청한 문서가 바뀌었습니다.');
    if(this.pending)this.stop();
    this.pending={...identity};
    const ext=({ 'image/png':'png','image/jpeg':'jpg','image/webp':'webp' } as const)[image.mime];
    try {this.input.enterImagePlacementMode(new Uint8Array(image.bytes),ext,image.width,image.height,'AI-generated.'+ext);}
    catch(error){this.pending=null;throw error;}
    this.notify('문서에서 그림을 놓을 위치를 클릭하거나 드래그하세요. Esc로 취소합니다.');
  }
  private beforePointer=(event:Event):void=>{
    if(this.pending&&!this.doc.owns(this.pending)){event.preventDefault();event.stopImmediatePropagation();this.stop('문서가 바뀌어 그림 배치를 취소했습니다.');}
  };
  private beforeKey=(event:KeyboardEvent):void=>{if(event.key==='Escape')this.stop();};
  stop(message=''):void {if(this.pending){this.pending=null;this.cancel();}if(message)this.notify(message);}
  dispose():void {this.stop();this.unsubscribe.forEach(fn=>fn());this.surface.removeEventListener('mousedown',this.beforePointer,true);this.surface.removeEventListener('mouseup',this.beforePointer,true);this.surface.removeEventListener('keydown',this.beforeKey,true);}
}
