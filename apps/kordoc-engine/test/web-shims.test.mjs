// The WebView worker's replacements for node:zlib, node:crypto and node:events behave like the Node modules on the
// cases the closure meets: compressed data of many shapes, truncation, size limits, trailing bytes, both digests on
// text and bytes, and listener order with once, prepend, removal and unhandled errors.
import {test} from 'node:test';import assert from 'node:assert/strict';import realZlib from 'node:zlib';import realCrypto from 'node:crypto';import RealEmitter from 'node:events';import {createRequire} from 'node:module';
import * as zlib from '../web/zlib.mjs';import * as crypto from '../web/crypto.mjs';
const Emitter=createRequire(import.meta.url)('../web/events.cjs');
const outcome=fn=>{try{return {value:Buffer.from(fn()).toString('base64')};}catch(e){return {error:e.code??e.name};}};
let seed=7;const random=n=>{const b=Buffer.alloc(n);for(let i=0;i<n;i++){seed=(seed*1103515245+12345)>>>0;b[i]=seed>>>24;}return b;};
const samples=[Buffer.alloc(0),Buffer.from('가'.repeat(5000)),random(100),random(70000),Buffer.concat([random(3000),Buffer.alloc(300000,65)]),Buffer.from(JSON.stringify({a:Array.from({length:4000},(_,i)=>i)}))];
test('inflate matches node:zlib, including truncation, limits and trailing bytes',()=>{
 for(const s of samples){
  for(const level of [0,1,6,9]){const raw=realZlib.deflateRawSync(s,{level}),wrapped=realZlib.deflateSync(s,{level});assert.deepEqual(outcome(()=>zlib.inflateRawSync(raw)),outcome(()=>realZlib.inflateRawSync(raw)));assert.deepEqual(outcome(()=>zlib.inflateSync(wrapped)),outcome(()=>realZlib.inflateSync(wrapped)));}
  const raw=realZlib.deflateRawSync(s);
  if(raw.length>4){const cut=raw.subarray(0,raw.length-3);assert.deepEqual(outcome(()=>zlib.inflateRawSync(cut)),outcome(()=>realZlib.inflateRawSync(cut)));}
  const trailing=Buffer.concat([raw,Buffer.from('trailing bytes')]);assert.deepEqual(outcome(()=>zlib.inflateRawSync(trailing)),outcome(()=>realZlib.inflateRawSync(trailing)));
  if(s.length>1000)for(const maxOutputLength of [Math.floor(s.length/2),s.length])assert.deepEqual(outcome(()=>zlib.inflateRawSync(raw,{maxOutputLength})),outcome(()=>realZlib.inflateRawSync(raw,{maxOutputLength})));
 }
 const garbage=random(200);assert.deepEqual(outcome(()=>zlib.inflateRawSync(garbage)),outcome(()=>realZlib.inflateRawSync(garbage)));assert.deepEqual(outcome(()=>zlib.inflateSync(garbage)),outcome(()=>realZlib.inflateSync(garbage)));
 assert.equal(outcome(()=>zlib.inflateRawSync(new Uint8Array(realZlib.deflateRawSync(samples[3])))).value,samples[3].toString('base64'));
});
test('createHash matches node:crypto for sha1 and sha256',()=>{
 for(const alg of ['sha1','sha256','SHA256'])for(const data of ['','한글 문서 abc',samples[3],new Uint8Array(samples[2])]){assert.equal(crypto.createHash(alg).update(data).digest('hex'),realCrypto.createHash(alg).update(data).digest('hex'));assert.deepEqual(crypto.createHash(alg).update(data).digest(),realCrypto.createHash(alg).update(data).digest());}
 assert.equal(crypto.createHash('sha256').update('a').update(samples[2]).update('끝').digest('base64'),realCrypto.createHash('sha256').update('a').update(samples[2]).update('끝').digest('base64'));
 assert.throws(()=>crypto.createHash('md5'));assert.throws(()=>crypto.createCipheriv('aes-128-ecb'));
});
test('EventEmitter matches node:events',()=>{
 function trace(Ctor){const log=[],e=new Ctor(),a=()=>log.push('a'),b=()=>{log.push('b');e.removeListener('x',a);},c=()=>log.push('c');e.on('x',a);e.on('x',b);e.prependListener('x',c);e.once('x',()=>log.push('once'));e.emit('x');e.emit('x');e.on('removeListener',t=>log.push('removed:'+t));e.removeAllListeners('x');log.push(String(e.listenerCount('x')),String(Ctor.listenerCount(e,'removeListener')));for(const er of [new Error('boom'),'plain'])try{e.emit('error',er);}catch(err){log.push('threw:'+err.message);}return log;}
 assert.deepEqual(trace(Emitter),trace(RealEmitter));
});
