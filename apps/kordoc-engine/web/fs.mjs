// No file system in the WebView worker. The lookups on the engine's path (existsSync, readFile) miss the way a
// missing file does in Node; the rest of what Kordoc imports is never reached and fails loudly.
import { unavailable } from './unavailable.mjs';

const missing=(path,syscall='open')=>Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${String(path)}'`),{code:'ENOENT',errno:-2,syscall,path:String(path)});
export function existsSync(){return false;}
export function readFileSync(path){throw missing(path);}
export function statSync(path){throw missing(path,'stat');}
export async function readFile(path){throw missing(path);}
export async function stat(path){throw missing(path,'stat');}
export const constants={};
export const closeSync=/* @__PURE__ */unavailable('fs.closeSync'),createReadStream=/* @__PURE__ */unavailable('fs.createReadStream'),createWriteStream=/* @__PURE__ */unavailable('fs.createWriteStream'),
 lstatSync=/* @__PURE__ */unavailable('fs.lstatSync'),mkdirSync=/* @__PURE__ */unavailable('fs.mkdirSync'),mkdtempSync=/* @__PURE__ */unavailable('fs.mkdtempSync'),openSync=/* @__PURE__ */unavailable('fs.openSync'),
 readSync=/* @__PURE__ */unavailable('fs.readSync'),readlinkSync=/* @__PURE__ */unavailable('fs.readlinkSync'),realpathSync=/* @__PURE__ */unavailable('fs.realpathSync'),rmSync=/* @__PURE__ */unavailable('fs.rmSync'),
 watch=/* @__PURE__ */unavailable('fs.watch'),writeFileSync=/* @__PURE__ */unavailable('fs.writeFileSync'),
 copyFile=/* @__PURE__ */unavailable('fs.copyFile'),mkdir=/* @__PURE__ */unavailable('fs.mkdir'),open=/* @__PURE__ */unavailable('fs.open'),readdir=/* @__PURE__ */unavailable('fs.readdir'),realpath=/* @__PURE__ */unavailable('fs.realpath'),
 rename=/* @__PURE__ */unavailable('fs.rename'),unlink=/* @__PURE__ */unavailable('fs.unlink'),writeFile=/* @__PURE__ */unavailable('fs.writeFile');
export const promises={readFile,stat,copyFile,mkdir,open,readdir,realpath,rename,unlink,writeFile};
export default {existsSync,readFileSync,statSync,constants,promises};
