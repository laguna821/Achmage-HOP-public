// Read only CMDS AST literals. Never eval source or load its configuration.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const source = process.argv[2], destination = path.resolve(__dirname, '..');
const text = fs.readFileSync(source, 'utf8');
function read(name) {
  let at=text.indexOf('=',text.indexOf('export const '+name))+1;
  function skip(){while(at<text.length && /\s/.test(text[at]))at++;}
  function word(){skip();const m=/^[\w-]+/.exec(text.slice(at));if(!m)throw Error('identifier');at+=m[0].length;return m[0];}
  function str(){const quote=text[at++];let out='';while(at<text.length){const c=text[at++];if(c===quote)return out;if(c==='\\'){const e=text[at++];if(![quote,'\\','n','r','t'].includes(e))throw Error('escape');out+=({n:'\n',r:'\r',t:'\t'})[e]??e;}else out+=c;}throw Error('unterminated');}
  function value(){skip();const c=text[at];if(c==='\''||c==='"')return str();if(c==='{'||c==='['){at++;const object=c==='{',out=object?{}:[];skip();while(text[at]!== (object?'}':']')){let key;if(object){skip();key=['\'','"'].includes(text[at])?str():word();skip();if(text[at++]!==':')throw Error('colon');}const v=value();if(object)out[key]=v;else out.push(v);skip();if(text[at]===','){at++;skip();}else break;}if(text[at++]!==(object?'}':']'))throw Error('closing');return out;}const w=word();if(w==='true')return true;if(w==='false')return false;throw Error('nonliteral '+w);}
  return value();
}
const values = {RESEARCH_SOURCES:read('RESEARCH_SOURCES'),RESEARCH_PACKS:read('RESEARCH_PACKS')};
if(Object.keys(values.RESEARCH_SOURCES).length!==13 || values.RESEARCH_PACKS.length!==7) throw Error('registry count changed');
const output = {cmdsCommit:'0184e6d0a3a8d84d676d91c29aa1e26a8de0a277',sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),sources:Object.values(values.RESEARCH_SOURCES),packs:values.RESEARCH_PACKS};
fs.writeFileSync(path.join(destination,'registry.json'), JSON.stringify(output,null,2)+'\n');
fs.copyFileSync(path.resolve(path.dirname(source),'../../../LICENSE'),path.join(destination,'CMDS-LICENSE'));
