// Kordoc engine runtime for the desktop bundle: this Node binary plus a link-free copy of the engine's
// dependency closure, executed once in isolation (capabilities, generate, validate) before it is published
// to apps/desktop/src-tauri/resources. Never touches source or a running copy. Works on Windows, macOS, Linux.
// Usage (repository root, after `pnpm --dir apps/kordoc-engine install --frozen-lockfile --ignore-workspace`):
//   node scripts/achmage/prepare-kordoc-runtime.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const PACKAGING_REVISION='pnpm-version-aware-closure-v3';
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
fs.mkdirSync(engine,{recursive:true});fs.mkdirSync(runtime,{recursive:true});
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
 const to=byName.get(name).size===1?path.join(engine,'node_modules',name):path.join(consumer,'node_modules',name);
 if(copied.has(to)){if(copied.get(to)!==real)throw Error('Deployment identity collision');return to;}
 if(ancestors.includes(real))throw Error('Conflicting dependency cycle requires explicit support: '+name);
 const n=nodes.get(real);own(to);fs.mkdirSync(to,{recursive:true});copied.set(to,real);
 fs.cpSync(real,to,{recursive:true,dereference:true,filter:p=>{const rel=path.relative(real,p);return rel!=='node_modules'&&!rel.startsWith('node_modules'+path.sep);}});
 graph.push({name:n.meta.name,version:n.meta.version,source:path.relative(root,real).replaceAll('\\','/'),destination:path.relative(stage,to).replaceAll('\\','/')});
 for(const dep of n.deps){const target=materialize(dep.name,dep.real,to,[...ancestors,real]);edges.push({from:to,name:dep.name,target});}
 return to;
}
function auditEdges(){for(const edge of edges){let current=edge.from,found=null;while(true){const candidate=path.join(current,'node_modules',edge.name,'package.json');if(fs.existsSync(candidate)){found=path.dirname(candidate);break;}const parent=path.dirname(current);if(parent===current)break;current=parent;}if(found!==edge.target)throw Error('Deployed dependency resolution differs: '+edge.name);}}

try{
 for(const name of fs.readdirSync(source).sort())if(name.endsWith('.mjs')||name==='package.json'||name==='pnpm-lock.yaml')fs.copyFileSync(path.join(source,name),path.join(engine,name));
 for(const dep of rootDeps)materialize(dep.name,dep.real,engine);
 auditEdges();
 const nodeName=process.platform==='win32'?'node.exe':'node';const node=path.join(runtime,nodeName);fs.copyFileSync(process.execPath,node);
 if(process.platform!=='win32')fs.chmodSync(node,0o755);
 // Node.js is redistributed in the installers: its license (MIT plus its bundled components' notices) goes with it.
 fs.copyFileSync(path.join(root,'licenses/Node.js-v24.19.0-LICENSE.txt'),path.join(runtime,'LICENSE-Node.js.txt'));
 const env=Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','LANG','LC_ALL'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
 function request(q){const p=spawnSync(node,[path.join(engine,'worker.mjs'),'--once'],{cwd:engine,env,input:JSON.stringify(q)+'\n',encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:32*1024*1024});if(p.error||p.status!==0){fs.writeFileSync(path.join(run,'owned-worker-failure.json'),JSON.stringify({id:q.id,status:p.status,error:p.error?.code,stderr:p.stderr?.slice(0,8192)},null,2));throw Error('Packaged worker failed: '+q.id);}const v=JSON.parse(p.stdout);if(v.id!==q.id||v.ok!==true||v.result?.engine?.name!=='kordoc'||v.result.engine.version!=='4.21.31')throw Error('Invalid worker response: '+q.id);return v.result;}
 const capabilities=request({id:'package-capabilities',op:'capabilities'});
 const style=(size=11)=>({fontFamily:'함초롬바탕',fontSizePt:size,bold:false,spacingPercent:0,alignment:'left',lineSpacingPercent:160});
 const template={schemaVersion:1,id:'package-test',name:'배포 시험',category:'general',provenance:'personal',description:'소유 시험 초안',roles:{title:{...style(20),bold:true,alignment:'center'},heading:{...style(14),bold:true},body:style(),tableHeader:{...style(12),bold:true},tableCell:style(10)},layout:{enginePreset:'report',cover:true,toc:true,sampleMarkdown:'# 시험',paper:'A4',orientation:'portrait'}};
 const generated=request({id:'package-generate',op:'generate',template,markdown:'# 회의자료\n\n## 1. 개요\n\n배포 엔진 시험 본문입니다.\n\n## 2. 안건\n\n|항목|내용|\n|---|---|\n|일정|다음 주|'});
 const bytes=Buffer.from(generated.hwpxBase64,'base64');if(crypto.createHash('sha256').update(bytes).digest('hex')!==generated.sha256||!generated.validation?.ok||generated.pages.length<3)throw Error('Generated integrity/structure invalid');
 const validated=request({id:'package-validate',op:'validate',hwpxBase64:generated.hwpxBase64});if(!validated.validation?.ok||validated.sha256!==generated.sha256)throw Error('Revalidation failed');
 fs.writeFileSync(path.join(run,'generated.hwpx'),bytes,{flag:'wx'});
 const tests={capabilities:true,generate:true,validate:true,sha256:generated.sha256,bytes:bytes.length,pages:generated.pages.length,validation:validated.validation,engine:capabilities.engine};
 fs.writeFileSync(path.join(run,'validation.json'),JSON.stringify(tests,null,2));
 function inventory(dir,prefix=''){const list=[];for(const name of fs.readdirSync(dir).sort()){const f=path.join(dir,name),relative=prefix+name,st=fs.lstatSync(f);if(st.isSymbolicLink())throw Error('Deployment link remaining');if(st.isDirectory())list.push(...inventory(f,relative+'/'));else if(st.isFile())list.push({path:relative,bytes:st.size,sha256:sha(f)});else throw Error('Unsupported deployment entry');}return list;}
 const files=inventory(stage);
 const manifest={packagingRevision:PACKAGING_REVISION,packagingScriptSha256:sha(script),engineVersion:'4.21.31',nodeVersion:process.version,platform:process.platform,architecture:process.arch,nodeSha256:sha(node),workerSha256:sha(path.join(engine,'worker.mjs')),lockSha256:sha(path.join(engine,'pnpm-lock.yaml')),engineFiles:Object.fromEntries(fs.readdirSync(engine).filter(n=>n.endsWith('.mjs')).sort().map(n=>[n,sha(path.join(engine,n))])),dependencyGraph:graph,dependencyEdgesVerified:edges.length,uniqueSourcePackages:nodes.size,optionalNotInstalled:skipped,files,generatedAt:new Date().toISOString(),validation:tests};
 manifest.bundleSha256=digest([manifest.packagingRevision,manifest.packagingScriptSha256,manifest.platform,manifest.architecture,files]);
 fs.writeFileSync(path.join(stage,'kordoc-runtime.json'),JSON.stringify(manifest,null,2));
 // Publish only after isolated bundle execution. Preserve previous build output, no recursive deletion.
 fs.mkdirSync(dest,{recursive:true});const previous=path.join(run,'previous-resources');fs.mkdirSync(previous);
 for(const name of ['kordoc-engine','runtime','kordoc-runtime.json']){const target=own(path.join(dest,name));if(fs.existsSync(target))fs.renameSync(target,path.join(previous,name));fs.cpSync(path.join(stage,name),target,{recursive:true,dereference:false});}
 fs.writeFileSync(path.join(root,'target/achmage/kordoc-packaging-latest.json'),JSON.stringify({directory:run,bundleSha256:manifest.bundleSha256,packagingRevision:PACKAGING_REVISION,validation:tests},null,2));
 console.log(JSON.stringify({bundleSha256:manifest.bundleSha256,packagingRevision:PACKAGING_REVISION,directory:run,files:files.length,packages:graph.length,validation:tests}));
}catch(error){fs.writeFileSync(path.join(run,'failure.json'),JSON.stringify({message:String(error),packagingRevision:PACKAGING_REVISION},null,2));throw error;}
