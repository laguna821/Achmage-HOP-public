/**
 * '초안 정리' without AI: a selected rough draft (□ ○ - ·, 1. 가. 1), "라벨: 내용", pipe or tab tables,
 * PDF line breaks) becomes headings, items and real tables in place, one Ctrl+Z. Used by the inline
 * chip and by the router's `tidy_draft` operation.
 */
import type { AiDocument } from './document';
import type { DocumentTemplate } from './document-templates';
import { looksLikeDraft, outlineToPlan, parseOutline } from './outline-ast';
import { parseStructuredPlan } from './structured-edit';
import { contractStyles, documentBaseRoles } from './style-contract';

export async function tidySelectedDraft(doc: Pick<AiDocument, 'captureStructured' | 'applyStructured'>, template?: Pick<DocumentTemplate, 'roles'>): Promise<{ paragraphs: number }> {
  const capture = doc.captureStructured(), text = capture.beforeParagraphs.map(p => p.text).join('\n'), outline = parseOutline(text);
  if (!looksLikeDraft(outline)) throw new Error('정리할 항목·표 구조를 찾지 못했습니다. 기호(□ ○ -), 번호(1. 가.), "라벨: 내용", 표(| 또는 탭)가 있는 초안을 문단 전체로 선택하세요.');
  // A chosen template sets the roles; otherwise the document's own body font is the base.
  const format = (capture.beforeParagraphs[0]?.charFormats[0] ?? {}) as { fontFamilies?: unknown; fontSize?: unknown };
  const family = Array.isArray(format.fontFamilies) && typeof format.fontFamilies[0] === 'string' ? format.fontFamilies[0] : '함초롬바탕';
  const size = typeof format.fontSize === 'number' && format.fontSize >= 500 ? Math.round(format.fontSize) / 100 : 11;
  const plan = parseStructuredPlan(outlineToPlan(outline, contractStyles(template ?? documentBaseRoles(family, size)), template?.roles.body.lineSpacingPercent));
  await doc.applyStructured(capture, plan);
  return { paragraphs: plan.paragraphs.length };
}
