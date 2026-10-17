// Kordoc engine runtime for the desktop bundle: this Node binary plus the engine's audited dependency closure
// bundled into one worker file, executed once in isolation (capabilities, generate, validate, and the same
// document from the unbundled closure must match byte for byte) before it is published to
// apps/desktop/src-tauri/resources. The same closure is also bundled as the WebView worker (kordoc-web/), which
// must answer the same requests with the same lines while run without Node's globals. Never touches source or a
// running copy. Works on Windows, macOS, Linux.
// Usage (repository root, after `pnpm install --frozen-lockfile` (Vite brings rolldown) and
// `pnpm --dir apps/kordoc-engine install --frozen-lockfile --ignore-workspace --no-optional --ignore-scripts`):
//   node scripts/achmage/prepare-kordoc-runtime.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const PACKAGING_REVISION='pnpm-closure-rolldown-bundle-v6-web-no-protected-readers';
const script=fileURLToPath(import.meta.url);
const root=path.resolve(path.dirname(script),'../..');
const source=path.join(root,'apps/kordoc-engine');
const dest=path.join(root,'apps/desktop/src-tauri/resources');
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function inside(base,p){const r=path.relative(base,p);return r!==''&&!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);}
function own(p){if(!inside(root,path.resolve(p)))throw Error('Build output escaped workspace');return p;}
if(Number(process.versions.node.split('.')[0])!==24)throw Error('Pinned Node24 required');
const pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
if(pkg.dependencies.kordoc!=='4.21.31')throw Error('Engine pin changed; review before packaging');
const run=own(path.join(root,'target/achmage/kordoc-packaging',new Date().toISOString().replaceAll(':','-')+'-'+crypto.randomBytes(4).toString('hex')));
const stage=path.join(run,'bundle'),engine=path.join(stage,'kordoc-engine'),runtime=path.join(stage,'runtime');
// The audited closure is assembled outside the published bundle; only its one-file build ships.
const closure=path.join(run,'closure','kordoc-engine');
fs.mkdirSync(engine,{recursive:true});fs.mkdirSync(runtime,{recursive:true});fs.mkdirSync(closure,{recursive:true});
const sourceModules=fs.realpathSync(path.join(source,'node_modules'));
const graph=[],skipped=[];
function resolvePackage(from,name){
 if(!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name))throw Error('Invalid package name');
 let current=from;
 while(true){const candidate=path.join(current,'node_modules',name,'package.json');if(fs.existsSync(candidate)){const dir=fs.realpathSync(path.dirname(candidate));if(!inside(sourceModules,dir))throw Error('Dependency escaped owned node_modules: '+name);return dir;}const parent=path.dirname(current);if(parent===current)break;current=parent;}
 return null;
}
const nodes=new Map(), byName=new Map();
function discover(name,from,optional=false){
 const real=resolvePackage(from,name);if(!real){if(optional){skipped.push({from:path.relative(source,from),optional:name});return null;}throw Error('Missing installed dependency: '+name);}
 if(!byName.has(name))byName.set(name,new Set());byName.get(name).add(real);
 if(nodes.has(real))return real;
 const meta=JSON.parse(fs.readFileSync(path.join(real,'package.json'),'utf8'));
 const node={name,real,meta,deps:[]};nodes.set(real,node);
 const required={...meta.dependencies},optionalDeps={...meta.optionalDependencies};
 for(const [peer,version] of Object.entries(meta.peerDependencies??{})){if(!(peer in required)&&!(peer in optionalDeps)){if(meta.peerDependenciesMeta?.[peer]?.optional)optionalDeps[peer]=version;else required[peer]=version;}}
 for(const dep of Object.keys(optionalDeps))delete required[dep];
 for(const dep of Object.keys(required).sort()){const target=discover(dep,real);node.deps.push({name:dep,real:target});}
 for(const dep of Object.keys(optionalDeps).sort()){const target=discover(dep,real,true);if(target)node.deps.push({name:dep,real:target});}
 return real;
}
const rootDeps=Object.keys(pkg.dependencies).sort().map(name=>({name,real:discover(name,source)}));
const copied=new Map(),edges=[];
function materialize(name,real,consumer,ancestors=[]){
 // Globally unique package names are hoisted once. Conflicting versions are local
 // to every consumer, so an ancestor can never shadow a different expected version.
 const to=byName.get(name).size===1?path.join(closure,'node_modules',name):path.join(consumer,'node_modules',name);
 if(copied.has(to)){if(copied.get(to)!==real)throw Error('Deployment identity collision');return to;}
 if(ancestors.includes(real))throw Error('Conflicting dependency cycle requires explicit support: '+name);
 const n=nodes.get(real);own(to);fs.mkdirSync(to,{recursive:true});copied.set(to,real);
 fs.cpSync(real,to,{recursive:true,dereference:true,filter:p=>{const rel=path.relative(real,p);return rel!=='node_modules'&&!rel.startsWith('node_modules'+path.sep);}});
 graph.push({name:n.meta.name,version:n.meta.version,source:path.relative(root,real).replaceAll('\\','/'),destination:path.relative(path.dirname(closure),to).replaceAll('\\','/')});
 for(const dep of n.deps){const target=materialize(dep.name,dep.real,to,[...ancestors,real]);edges.push({from:to,name:dep.name,target});}
 return to;
}
function auditEdges(){for(const edge of edges){let current=edge.from,found=null;while(true){const candidate=path.join(current,'node_modules',edge.name,'package.json');if(fs.existsSync(candidate)){found=path.dirname(candidate);break;}const parent=path.dirname(current);if(parent===current)break;current=parent;}if(found!==edge.target)throw Error('Deployed dependency resolution differs: '+edge.name);}}

try{
 for(const name of fs.readdirSync(source).sort())if(name.endsWith('.mjs')||name==='package.json'||name==='pnpm-lock.yaml')fs.copyFileSync(path.join(source,name),path.join(closure,name));
 fs.cpSync(path.join(source,'web'),path.join(closure,'web'),{recursive:true});
 for(const dep of rootDeps)materialize(dep.name,dep.real,closure);
 auditEdges();
 // One file instead of ~4,000 (most of them source maps and code the engine never loads), built with the
 // rolldown that Vite already installs. kordoc loads cfb through createRequire, which a bundler cannot follow,
 // so that call becomes a static import. The optional OCR modules stay absent, as in the closure.
 const fromVite=createRequire(createRequire(path.join(root,'apps/studio-host/package.json')).resolve('vite/package.json'));
 const rolldownPath=fromVite.resolve('rolldown'),{rolldown}=await import(pathToFileURL(rolldownPath).href);
 // The engine reads only the HWPX documents it generates. Kordoc's decryption of password-protected and
 // distribution-restricted (배포용) HWP 5, HWP 3 and HWPX documents is left out of both bundles: those top-level
 // functions become ones that refuse, the code they used drops out, and the bundles are checked for its traces.
 const PROTECTED_READERS=['decryptHwpxInPlace','decryptDistributePayload','decryptViewText','findViewTextSections','findViewTextSectionsLenient','decryptPasswordStream','decryptHwp3Document'];
 const PROTECTED_TRACES=['DISTRIBUTE_DOC_DATA','ViewText','aes-128-ecb','xmlenc#aes256-cbc','createCipheriv','createDecipheriv','pbkdf2Sync'];
 const leftOut=new Set();
 const noProtectedReaders={name:'kordoc-no-protected-readers',transform(code,id){if(!/[\\/]kordoc[\\/]dist[\\/]/.test(id))return null;let out=code,changed=false;for(const name of PROTECTED_READERS){const pattern=new RegExp('^(async )?function '+name+'\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}\\n','gm'),found=out.match(pattern)?.length??0;if(!found)continue;if(found!==1)throw Error('Kordoc defines '+name+' more than once: review before packaging');out=out.replace(pattern,(_,isAsync)=>(isAsync??'')+'function '+name+'() {\n  throw new Error("이 문서 엔진은 암호가 걸리거나 배포용으로 보호된 문서를 읽지 않습니다.");\n}\n');leftOut.add(name);changed=true;}return changed?{code:out,map:null}:null;}};
 function assertLeftOut(file){const built=fs.readFileSync(file,'utf8'),traces=PROTECTED_TRACES.filter(trace=>built.includes(trace));if(traces.length)throw Error('Protected-document reader left in '+path.basename(file)+': '+traces.join(', '));}
 const cfbStatic={name:'kordoc-cfb-static',transform(code,id){if(!/[\\/]kordoc[\\/]dist[\\/]/.test(id)||!/require\d*\("cfb"\)/.test(code))return null;return {code:'import __kordocCfb from "cfb";\n'+code.replace(/require\d*\("cfb"\)/g,'__kordocCfb'),map:null};}};
 const bundler=await rolldown({input:path.join(closure,'worker.mjs'),platform:'node',cwd:closure,logLevel:'silent',plugins:[noProtectedReaders,cfbStatic],external:['onnxruntime-node','sharp']});
 await bundler.write({file:path.join(engine,'worker.mjs'),format:'esm',minify:true,sourcemap:false,codeSplitting:false});await bundler.close();
 {const built=fs.readFileSync(path.join(engine,'worker.mjs'),'utf8');if([root,root.replaceAll('\\','/')].some(p=>built.includes(p)))throw Error('Build path embedded in the worker');}
 // The WebView worker (web-worker.mjs) from the same closure. Node built-ins become the replacements in web/, and
 // JSZip and readable-stream stay the builds the Node bundle uses: JSZip's browser field would swap in its prebuilt
 // dist, which has no nodeStream, and Kordoc reads ZIP entries through nodeStream.
 const web=path.join(stage,'kordoc-web'),shim=name=>path.join(closure,'web',name),modules=path.join(closure,'node_modules');
 const builtins={buffer:path.join(modules,'buffer/index.js'),events:shim('events.cjs'),crypto:shim('crypto.mjs'),zlib:shim('zlib.mjs'),fs:shim('fs.mjs'),'fs/promises':shim('fs.mjs'),module:shim('module.mjs'),process:shim('process.mjs')};
 for(const name of ['path','url','os','child_process','stream','stream/promises','util'])builtins[name]=shim('node-misc.mjs');
 const webModules={...builtins,...Object.fromEntries(Object.entries(builtins).map(([name,file])=>['node:'+name,file])),'buffer/index.js':builtins.buffer,jszip:path.join(modules,'jszip/lib/index.js'),'readable-stream':path.join(modules,'readable-stream/readable-browser.js')};
 for(const file of new Set(Object.values(webModules)))if(!fs.existsSync(file))throw Error('WebView worker module missing: '+path.relative(closure,file));
 const webBundler=await rolldown({input:path.join(closure,'web-worker.mjs'),platform:'browser',cwd:closure,logLevel:'silent',plugins:[{name:'kordoc-web-modules',resolveId:id=>webModules[id]??null},noProtectedReaders,cfbStatic]});
 await webBundler.write({file:path.join(web,'engine-worker.js'),format:'iife',minify:true,sourcemap:false,codeSplitting:false});await webBundler.close();
 {const built=fs.readFileSync(path.join(web,'engine-worker.js'),'utf8');if([root,root.replaceAll('\\','/')].some(p=>built.includes(p)))throw Error('Build path embedded in the WebView worker');}
 if(PROTECTED_READERS.some(name=>!leftOut.has(name)))throw Error('Kordoc protected-document readers changed: '+PROTECTED_READERS.filter(name=>!leftOut.has(name)).join(', '));
 assertLeftOut(path.join(engine,'worker.mjs'));assertLeftOut(path.join(web,'engine-worker.js'));
 // Document generation never goes online: the WebView worker must not contain a network API.
 {const built=fs.readFileSync(path.join(web,'engine-worker.js'),'utf8'),network=[/\bfetch\s*\(/,/XMLHttpRequest/,/\bWebSocket\b/,/\bEventSource\b/,/\bsendBeacon\b/,/\bimportScripts\s*\(/].filter(p=>p.test(built));if(network.length)throw Error('Network API in the WebView worker: '+network.join(', '));}
 for(const name of ['package.json','pnpm-lock.yaml'])fs.copyFileSync(path.join(source,name),path.join(engine,name));
 // kordoc's NOTICE points to licence texts in its own THIRD_PARTY folder: they travel with the bundle.
 {const kordoc=path.join(closure,'node_modules','kordoc'),licenses=path.join(engine,'licenses','kordoc');fs.mkdirSync(licenses,{recursive:true});
  for(const name of fs.readdirSync(kordoc))if(/^(licen[cs]e|notice)/i.test(name)||name==='THIRD_PARTY')fs.cpSync(path.join(kordoc,name),path.join(licenses,name),{recursive:true});}
 const bundlerVersion=JSON.parse(fs.readFileSync(path.join(path.dirname(rolldownPath),'..','package.json'),'utf8')).version;
 const nodeName=process.platform==='win32'?'node.exe':'node';const node=path.join(runtime,nodeName);fs.copyFileSync(process.execPath,node);
 if(process.platform!=='win32')fs.chmodSync(node,0o755);
 // Node.js is redistributed in the installers: its license (MIT plus its bundled components' notices) goes with it.
 fs.copyFileSync(path.join(root,'licenses/Node.js-v24.19.0-LICENSE.txt'),path.join(runtime,'LICENSE-Node.js.txt'));
 const env=Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','LANG','LC_ALL'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
 function request(q,dir=engine){const p=spawnSync(node,[path.join(dir,'worker.mjs'),'--once'],{cwd:dir,env,input:JSON.stringify(q)+'\n',encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:32*1024*1024});if(p.error||p.status!==0){fs.writeFileSync(path.join(run,'owned-worker-failure.json'),JSON.stringify({id:q.id,status:p.status,error:p.error?.code,stderr:p.stderr?.slice(0,8192)},null,2));throw Error('Packaged worker failed: '+q.id);}const v=JSON.parse(p.stdout);if(v.id!==q.id||v.ok!==true||v.result?.engine?.name!=='kordoc'||v.result.engine.version!=='4.21.31')throw Error('Invalid worker response: '+q.id);return v.result;}
 const capabilities=request({id:'package-capabilities',op:'capabilities'});
 const style=(size=11)=>({fontFamily:'함초롬바탕',fontSizePt:size,bold:false,spacingPercent:0,alignment:'left',lineSpacingPercent:160});
 const template={schemaVersion:1,id:'package-test',name:'배포 시험',category:'general',provenance:'personal',description:'소유 시험 초안',roles:{title:{...style(20),bold:true,alignment:'center'},heading:{...style(14),bold:true},body:style(),tableHeader:{...style(12),bold:true},tableCell:style(10)},layout:{enginePreset:'report',cover:true,toc:true,sampleMarkdown:'# 시험',paper:'A4',orientation:'portrait'}};
 const markdown='# 회의자료\n\n## 1. 개요\n\n배포 엔진 시험 본문입니다.\n\n## 2. 안건\n\n|항목|내용|\n|---|---|\n|일정|다음 주|';
 const generated=request({id:'package-generate',op:'generate',template,markdown});
 const bytes=Buffer.from(generated.hwpxBase64,'base64');if(crypto.createHash('sha256').update(bytes).digest('hex')!==generated.sha256||!generated.validation?.ok||generated.pages.length<3)throw Error('Generated integrity/structure invalid');
 const validated=request({id:'package-validate',op:'validate',hwpxBase64:generated.hwpxBase64});if(!validated.validation?.ok||validated.sha256!==generated.sha256)throw Error('Revalidation failed');
 const capabilitiesReference=request({id:'package-capabilities-closure',op:'capabilities'},closure);
 const reference=request({id:'package-generate-closure',op:'generate',template,markdown},closure);
 if(JSON.stringify(reference)!==JSON.stringify(generated)||JSON.stringify(capabilitiesReference)!==JSON.stringify(capabilities))throw Error('Bundled worker output differs from the audited closure');
 // The WebView worker, run without Node's Buffer, process or global (kordoc-web-check.mjs), must answer with the
 // same response lines as the Node worker.
 const rendered=request({id:'package-render',op:'render',hwpxBase64:generated.hwpxBase64});
 const webCases=[[{id:'package-capabilities',op:'capabilities'},capabilities],[{id:'package-generate',op:'generate',template,markdown},generated],[{id:'package-validate',op:'validate',hwpxBase64:generated.hwpxBase64},validated],[{id:'package-render',op:'render',hwpxBase64:generated.hwpxBase64},rendered]];
 const webRun=spawnSync(node,[path.join(root,'scripts/achmage/kordoc-web-check.mjs'),path.join(web,'engine-worker.js')],{cwd:run,env,input:JSON.stringify(webCases.map(([q])=>JSON.stringify(q))),encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:64*1024*1024});
 if(webRun.error||webRun.status!==0){fs.writeFileSync(path.join(run,'web-worker-failure.json'),JSON.stringify({status:webRun.status,error:webRun.error?.code,stderr:webRun.stderr?.slice(0,8192)},null,2));throw Error('WebView worker check failed');}
 const webLines=JSON.parse(webRun.stdout);
 for(const [i,[q,result]] of webCases.entries())if(webLines[i]!==JSON.stringify({id:q.id,ok:true,result}))throw Error('WebView worker output differs from the Node worker: '+q.id);
 fs.writeFileSync(path.join(run,'generated.hwpx'),bytes,{flag:'wx'});
 const tests={capabilities:true,generate:true,validate:true,closureIdentical:true,webWorkerIdentical:webCases.map(([q])=>q.op),sha256:generated.sha256,bytes:bytes.length,pages:generated.pages.length,validation:validated.validation,engine:capabilities.engine};
 fs.writeFileSync(path.join(run,'validation.json'),JSON.stringify(tests,null,2));
 function inventory(dir,prefix=''){const list=[];for(const name of fs.readdirSync(dir).sort()){const f=path.join(dir,name),relative=prefix+name,st=fs.lstatSync(f);if(st.isSymbolicLink())throw Error('Deployment link remaining');if(st.isDirectory())list.push(...inventory(f,relative+'/'));else if(st.isFile())list.push({path:relative,bytes:st.size,sha256:sha(f)});else throw Error('Unsupported deployment entry');}return list;}
 const files=inventory(stage);
 const manifest={packagingRevision:PACKAGING_REVISION,packagingScriptSha256:sha(script),engineVersion:'4.21.31',nodeVersion:process.version,platform:process.platform,architecture:process.arch,nodeSha256:sha(node),workerSha256:sha(path.join(engine,'worker.mjs')),lockSha256:sha(path.join(engine,'pnpm-lock.yaml')),engineFiles:Object.fromEntries(fs.readdirSync(engine).filter(n=>n.endsWith('.mjs')).sort().map(n=>[n,sha(path.join(engine,n))])),leftOut:{readers:PROTECTED_READERS,absentTraces:PROTECTED_TRACES,reason:'the engine reads only the HWPX documents it generates; decryption of password-protected and distribution-restricted documents is not part of either bundle'},bundler:{name:'rolldown',version:bundlerVersion,format:'esm',minify:true,shipped:'kordoc-engine/worker.mjs (the closure below is bundled into it; destinations are build-time paths)'},webWorker:{entry:'web-worker.mjs',format:'iife',platform:'browser',minify:true,sha256:sha(path.join(web,'engine-worker.js')),shipped:'kordoc-web/engine-worker.js (the studio build serves it as kordoc/engine-worker.js)',modules:Object.fromEntries(Object.entries(webModules).map(([name,file])=>[name,path.relative(closure,file).replaceAll('\\','/')]))},dependencyGraph:graph,dependencyEdgesVerified:edges.length,uniqueSourcePackages:nodes.size,optionalNotInstalled:skipped,files,generatedAt:new Date().toISOString(),validation:tests};
 manifest.bundleSha256=digest([manifest.packagingRevision,manifest.packagingScriptSha256,manifest.platform,manifest.architecture,files]);
 fs.writeFileSync(path.join(stage,'kordoc-runtime.json'),JSON.stringify(manifest,null,2));
 // Publish only after isolated bundle execution. Preserve previous build output, no recursive deletion.
 fs.mkdirSync(dest,{recursive:true});const previous=path.join(run,'previous-resources');fs.mkdirSync(previous);
 for(const name of ['kordoc-engine','kordoc-web','runtime','kordoc-runtime.json']){const target=own(path.join(dest,name));if(fs.existsSync(target))fs.renameSync(target,path.join(previous,name));fs.cpSync(path.join(stage,name),target,{recursive:true,dereference:false});}
 fs.writeFileSync(path.join(root,'target/achmage/kordoc-packaging-latest.json'),JSON.stringify({directory:run,bundleSha256:manifest.bundleSha256,packagingRevision:PACKAGING_REVISION,validation:tests},null,2));
 console.log(JSON.stringify({bundleSha256:manifest.bundleSha256,packagingRevision:PACKAGING_REVISION,directory:run,files:files.length,packages:graph.length,validation:tests}));
}catch(error){fs.writeFileSync(path.join(run,'failure.json'),JSON.stringify({message:String(error),packagingRevision:PACKAGING_REVISION},null,2));throw error;}
