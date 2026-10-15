import {queuedKordocRequest} from './kordoc-engine';
import {ENGINE_PRESETS,parseDocumentTemplate,templateLayout,type DocumentTemplate,type EnginePreset} from './document-templates';
export interface AgencyStyle {name:string;reportAvailable:boolean;pressAvailable:boolean;reportUsesCommonFallback:boolean}
export interface TemplateCatalog {presets:EnginePreset[];agencies:AgencyStyle[];agencyPresets:EnginePreset[];coverTocPresets:EnginePreset[]}
export const PRESET_LABELS:Record<EnginePreset,string>={official:'공문',report:'보고서',plan:'계획서',notice:'공고문',minutes:'회의록',gaejosik:'개조식 보고서',press:'보도자료',ministry:'부처 보고서',bangchim:'방침서'};
export function parseTemplateCatalog(value:unknown):TemplateCatalog{
 const v=value as Record<string,unknown>;if(!v||typeof v!=='object')throw Error('문서 엔진의 서식 목록을 확인하지 못했습니다.');
 const presets=(key:string)=>{const a=v[key];if(!Array.isArray(a)||!a.length||a.length>ENGINE_PRESETS.length||new Set(a).size!==a.length||a.some(s=>!ENGINE_PRESETS.includes(s)))throw Error('문서 엔진의 지원 유형을 확인하지 못했습니다.');return [...a] as EnginePreset[];};
 if(!Array.isArray(v.agencies)||v.agencies.length>200)throw Error('기관 스타일 목록을 확인하지 못했습니다.');
 const agencies=v.agencies.map((a:unknown)=>{const row=a as AgencyStyle;if(!row||typeof row.name!=='string'||!row.name.trim()||row.name.length>100||/[\u0000-\u001f<>]/u.test(row.name)||typeof row.reportAvailable!=='boolean'||typeof row.pressAvailable!=='boolean'||typeof row.reportUsesCommonFallback!=='boolean')throw Error('기관 스타일 항목이 올바르지 않습니다.');return {name:row.name,reportAvailable:row.reportAvailable,pressAvailable:row.pressAvailable,reportUsesCommonFallback:row.reportUsesCommonFallback};});
 if(new Set(agencies.map(a=>a.name)).size!==agencies.length)throw Error('기관 스타일 목록이 중복되었습니다.');
 const result={presets:presets('presets'),agencies,agencyPresets:presets('agencyPresets'),coverTocPresets:presets('coverTocPresets')};
 if([...result.agencyPresets,...result.coverTocPresets].some(p=>!result.presets.includes(p)))throw Error('지원 유형 목록이 일치하지 않습니다.');return result;
}
export async function loadTemplateCatalog():Promise<TemplateCatalog>{
 const id=crypto.randomUUID(),reply=await queuedKordocRequest({id,op:'capabilities'}) as {id:string;ok:boolean;result?:Record<string,unknown>};
 const engine=reply.result?.engine as {name?:string;version?:string}|undefined;
 if(reply.id!==id||!reply.ok||engine?.name!=='kordoc'||engine.version!=='4.21.31')throw Error('문서 엔진의 서식 목록을 불러오지 못했습니다.');
 return parseTemplateCatalog(reply.result);
}
export function validateCatalogTemplate(template:DocumentTemplate,catalog:TemplateCatalog):void{
 const l=templateLayout(parseDocumentTemplate(template));
 if(!catalog.presets.includes(l.enginePreset))throw Error('현재 문서 엔진이 이 유형을 지원하지 않습니다.');
 if((l.cover||l.toc)&&!catalog.coverTocPresets.includes(l.enginePreset))throw Error('현재 문서 엔진이 이 유형의 표지·목차를 지원하지 않습니다.');
 if(l.agency&&(!catalog.agencyPresets.includes(l.enginePreset)||!catalog.agencies.some(a=>a.name===l.agency)))throw Error('선택한 기관 스타일을 현재 문서 엔진에서 찾지 못했습니다. 기관을 다시 선택하세요.');
}
export function agencyStyleNotice(template:DocumentTemplate,catalog:TemplateCatalog):string{
 const l=templateLayout(template);if(!l.agency)return '기관을 선택하지 않으면 아래의 내 역할 서식을 사용합니다.';
 const a=catalog.agencies.find(a=>a.name===l.agency);if(!a)return '저장된 기관이 현재 엔진 목록에 없습니다. 다시 선택하세요.';
 if(!catalog.agencyPresets.includes(l.enginePreset))return '이 문서 유형은 기관 스타일을 지원하지 않습니다. 기관 선택을 해제하세요.';
 const fallback=l.enginePreset!=='press'&&a.reportUsesCommonFallback;
 return (fallback?'이 기관의 보고서 규칙이 없어 Kordoc 공통 보고서 스타일을 사용합니다. ':'기관의 Kordoc 배포 스타일을 사용합니다. ')+(l.agencyRoleOverrides?.length?'명시한 역할만 내 서식으로 변경합니다.':'역할별 기본 서식을 그대로 유지합니다.')+' 최신 공식 제출 양식 인증은 아닙니다.';
}
