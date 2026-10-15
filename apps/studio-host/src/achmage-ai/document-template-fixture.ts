import type {DocumentTemplate,TemplateStyle} from './document-templates';
// Test fixture: a role-only template (no HanMark look), the shape personal templates had before looks.
const role=(size:number,bold=false,alignment:TemplateStyle['alignment']='justify',line=160):TemplateStyle=>({fontFamily:'함초롬바탕',fontSizePt:size,bold,spacingPercent:0,alignment,lineSpacingPercent:line});
export function roleTemplateFixture():DocumentTemplate{
 return {schemaVersion:1,id:'role-report',name:'역할 보고서',category:'general',provenance:'sample',description:'역할만 있는 시험 템플릿',roles:{title:role(20,true,'center',150),heading:role(16,true,'left'),body:role(15),tableHeader:role(15,true,'center',130),tableCell:role(15,false,'left',130)}};
}
