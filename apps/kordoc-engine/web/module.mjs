// createRequire for the WebView worker. The one module Kordoc loads this way (cfb) becomes a static import at build
// time, so anything else asked for at run time is missing.
export function createRequire(){return id=>{throw Object.assign(new Error(`Cannot find module '${id}'`),{code:'MODULE_NOT_FOUND'});};}
export default {createRequire};
