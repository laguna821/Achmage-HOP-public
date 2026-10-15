import type { CommandDef } from '@/upstream/commands';
import { requestTemplateImport, requestTemplateManage } from '../achmage-ai/panel-events';

/**
 * 서식 menu entries for document templates. `tool:` ids stay available in form mode (the dispatcher
 * blocks `format:` there); the AI panel's template window does the work, so a menu click never
 * starts a model call.
 */
export const templateCommands: CommandDef[] = [
  { id: 'tool:template-add', label: '서식 추가하기(한글 파일)', execute() { requestTemplateImport(); } },
  { id: 'tool:template-manage', label: '문서 서식 관리', execute() { requestTemplateManage(); } },
];
