/// <reference types="node" />
import { describe,it,expect,vi } from 'vitest';
import { ImageDocument,validateGeneratedImage } from './image-document';
import { EventBus } from '@upstream/core/event-bus';
import type { RhwpDocumentStateV1 } from '@upstream/document-agent/types';
const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1kAAAAASUVORK5CYII=','base64'));
const state={schemaVersion:1,format:'hwpx',documentEpoch:1,changeSeq:0,dirty:false,pageCount:1,documentSha256:'a'} as RhwpDocumentStateV1;
describe('generated-image document ownership',()=>{
  it('passes copied bytes to the existing placement mode and cancels before stale pointer delivery',()=>{
    let current=true;const surface=new EventTarget(), enter=vi.fn(),cancel=vi.fn(), downstream=vi.fn(),bus=new EventBus();
    const helper=new ImageDocument({identity:()=>state,owns:()=>current},{enterImagePlacementMode:enter},surface as HTMLElement,bus,()=>{},cancel);
    helper.begin(helper.capture(),{bytes:png,mime:'image/png',width:1,height:1});expect(enter).toHaveBeenCalledOnce();expect(enter.mock.calls[0][0]).not.toBe(png);
    surface.addEventListener('mouseup',downstream);current=false;surface.dispatchEvent(new Event('mouseup',{cancelable:true}));expect(downstream).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalledOnce();helper.dispose();
  });
  it('rejects a delayed decoder result after document replacement without entering placement',async()=>{
    let current=true;const enter=vi.fn(), helper=new ImageDocument({identity:()=>state,owns:()=>current},{enterImagePlacementMode:enter},new EventTarget() as HTMLElement,new EventBus(),()=>{},()=>{});
    await expect(helper.prepare(state,{bytes:png,mime:'image/png'},async image=>{current=false;return{...image,width:1,height:1};})).rejects.toThrow();expect(enter).not.toHaveBeenCalled();helper.dispose();
  });
  it('rejects type spoofing, invalid dimensions and missing documents',()=>{
    expect(()=>validateGeneratedImage({bytes:png,mime:'image/jpeg'})).toThrow();
    const helper=new ImageDocument({identity:()=>({...state,pageCount:0}),owns:()=>true},{enterImagePlacementMode:vi.fn()},new EventTarget() as HTMLElement,new EventBus(),()=>{},()=>{});
    expect(()=>helper.capture()).toThrow();expect(()=>helper.begin(state,{bytes:png,mime:'image/png',width:0,height:2})).toThrow();helper.dispose();
  });
});
