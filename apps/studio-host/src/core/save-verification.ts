/** Engine handle methods the HWPX save check reads (HwpDocument). */
export interface ReopenableDocument {
  getSectionCount(): number; getParagraphCount(section: number): number; getTextFileUnicode(): string; getControls(): string;
  getDocumentInfo(): string; free(): void;
}

/**
 * Sections, paragraphs per section, every object kind, all text and the font names in use: what a saved file must
 * give back. Font names matter: reopened in Hancom Office, a renamed face opens substituted.
 */
export function documentShape(doc: ReopenableDocument): string {
  const sections = doc.getSectionCount(), paragraphs = Array.from({ length: sections }, (_, s) => doc.getParagraphCount(s));
  const objects = (JSON.parse(doc.getControls()) as { ctrlId: string }[]).map(c => c.ctrlId).sort().join(',');
  const fonts = [...((JSON.parse(doc.getDocumentInfo()) as { fontsUsed?: string[] }).fontsUsed ?? [])].sort();
  return JSON.stringify({ sections, paragraphs, objects, fonts, text: doc.getTextFileUnicode() });
}

/**
 * Opens the bytes in a separate engine instance of the same kind as `current` and compares their shape.
 * Any parse error or difference is a mismatch; the caller then writes nothing.
 */
export function reopensAsSameDocument(current: ReopenableDocument, bytes: Uint8Array): boolean {
  const Engine = (current as object).constructor as new (data: Uint8Array) => ReopenableDocument;
  let reopened: ReopenableDocument | null = null;
  try {
    reopened = new Engine(bytes.slice());
    return documentShape(reopened) === documentShape(current);
  } catch {
    return false;
  } finally {
    reopened?.free();
  }
}
