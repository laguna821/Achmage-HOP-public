// path, url, os, child_process, stream and util, as Kordoc imports them: only from code the engine's requests never
// reach (none of it is in the Node bundle), so every call fails loudly.
import { unavailable } from './unavailable.mjs';

export const sep='/',delimiter=':';
export const basename=/* @__PURE__ */unavailable('path.basename'),dirname=/* @__PURE__ */unavailable('path.dirname'),extname=/* @__PURE__ */unavailable('path.extname'),isAbsolute=/* @__PURE__ */unavailable('path.isAbsolute'),
 join=/* @__PURE__ */unavailable('path.join'),relative=/* @__PURE__ */unavailable('path.relative'),resolve=/* @__PURE__ */unavailable('path.resolve');
export const fileURLToPath=/* @__PURE__ */unavailable('url.fileURLToPath'),pathToFileURL=/* @__PURE__ */unavailable('url.pathToFileURL');
export const homedir=/* @__PURE__ */unavailable('os.homedir'),hostname=/* @__PURE__ */unavailable('os.hostname'),platform=/* @__PURE__ */unavailable('os.platform');
export const execFile=/* @__PURE__ */unavailable('child_process.execFile'),execFileSync=/* @__PURE__ */unavailable('child_process.execFileSync'),fork=/* @__PURE__ */unavailable('child_process.fork');
export const pipeline=/* @__PURE__ */unavailable('stream.pipeline');
export class Readable{constructor(){unavailable('stream.Readable')();}}
export const format=/* @__PURE__ */unavailable('util.format'),promisify=/* @__PURE__ */unavailable('util.promisify');
export default {sep,delimiter,basename,dirname,extname,isAbsolute,join,relative,resolve,fileURLToPath,pathToFileURL,homedir,hostname,platform,execFile,execFileSync,fork,pipeline,Readable,format,promisify};
