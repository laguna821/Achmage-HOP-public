// The parts of `process` that the closure's browser-safe paths touch; nothing here reaches the operating system.
const process={
 env:{},argv:[],browser:true,title:'browser',platform:'browser',version:'',versions:{},
 nextTick(fn,...args){queueMicrotask(()=>fn(...args));},
 cwd:()=>'/',emitWarning(){},
 on(){return process;},once(){return process;},off(){return process;},removeListener(){return process;},emit(){return false;},
};
export default process;
export const {env,nextTick,browser,platform,version,versions}=process;
