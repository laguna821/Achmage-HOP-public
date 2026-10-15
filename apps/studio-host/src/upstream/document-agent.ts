// Upstream document-agent contract used by the Achmage AI overlay (one-step undo, state identity).
export { DocumentAgentController, collectTargetEvidence } from '@upstream/document-agent/controller';
export { parseApplyTextCommand } from '@upstream/document-agent/contract';
export type { RhwpApplyTextCommandV1, RhwpDocumentStateV1 } from '@upstream/document-agent/types';
