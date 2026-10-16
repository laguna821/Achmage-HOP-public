# Document workflow upgrade

## Problem
The sidebar and inline editor classify the same request differently. The model cannot inspect named form fields, and provider failures look like document failures. Selection is wrongly required for named targets. Adding synonyms does not solve this.

## Goal and boundary
All natural-language entrypoints use one inspect–stage–verify loop. The model may read paginated document nodes and stage typed edits on an isolated copy. The live document changes only once, after revision validation, inside the existing snapshot/Undo transaction. A vague follow-up must use conversation and actual receipts, or ask a concrete question without changing anything.

Public image generation remains excluded. Existing fonts, source files, authentication and templates remain local and unchanged. The upstream submodule stays read-only. Kordoc is retained for explicit document creation, not a fallback for failed form edits.

## Implementation
1. Revision-bound document nodes and bounded, paginated read/search tools.
2. Typed operations over the pinned engine; shadow staging and a single atomic live commit.
3. Provider-neutral, cancellable read/tool/answer loop; validated output, bounded repair, no blind write retry.
4. Shared sidebar/inline routing, retained target context, provider-independent conversation and explicit new sessions.
5. Individual capability adapters and feature PRs, each with actual engine tests.

## Verification and recovery
Owned forms, long sources, merged/nested targets, typo/negation/follow-up scenarios, malformed/truncated replies, cancellation, revision changes, duplicate completion, save/reopen and Undo. Live OpenAI/Claude tests use synthetic fixtures only. Shadow edits are discarded on cancellation/error; commit failures roll back using the existing recovery path. On the developer's test machine each build was installed into a new directory and the previous one kept for rollback.

## Evidence
Baseline d175ceec2e2a78a5996d40a5e5e302144210146f, upstream 1a76570e833917d15817415a53c09ad61ab3203f.

## Implemented capability boundary

The default sidebar, selection popover and caret popover share the workflow loop. The old lexical router remains available only behind the explicit `workflow: false` compatibility option; local calculator/format buttons remain deterministic operations. New-document and recompose requests delegate to the existing Kordoc authoring boundary. The model may use only the template chosen in the template window or one the user names; a recompose is applied without a separate confirmation, and one Ctrl+Z restores the document.

Implemented tools cover body paragraphs, flat table cell paragraphs (including merged cells), selected text, character formatting, actual checkbox controls, row/column insertion/deletion, merging/splitting, installed font discovery, and chunked current/earlier source retrieval. Each map revision invalidates previous target IDs. Writes are rehearsed on a private engine, then replayed in one live snapshot with revision fencing and postconditions. Cancellation or failure before commit discards the private draft.

Nested table paths, text boxes, headers/footers and image objects are not generalized edit targets in this iteration. They must be reported as unavailable rather than silently recreated. Public image generation remains excluded. There is a 24-step execution budget, per-tool paging and engine bounds; this does not promise unlimited model context or arbitrary document sizes. Large prior source messages remain available in the running session; restored persisted transcripts retain the existing bounded history policy.

A fresh app window starts a fresh conversation. Previous local history is restored explicitly. Switching providers retains the app's current conversation. Google CLI requests no longer resume a hidden provider-side conversation.

## Verification (Linux, 2026-10-16)

- TypeScript type check and Linux Tauri debug build, pinned upstream unchanged.
- AI regression suite: 614 passed, 3 intentionally skipped before the final font-discovery addition; the changed font/runtime/panel suites passed 96 tests afterward.
- Real Claude synthetic workflow evaluation: 9 scenarios passed, including misspellings, vague follow-up with/without referent, negation, bulk checkbox wording and form filling without selection. These are live opt-in tests, not a guarantee that every model utterance is correctly understood.
- Real WebKitGTK desktop: GPT-6.1 Sol filled a named empty cell; Claude completed another field using the same chat; the saved HWPX preserved the table; a single Undo removed only the second turn. The rendered synthetic document was inspected.
- The tests did not change any font file or font configuration (hashes compared before and after). Font discovery is checked separately.
- Google CLI Rust unit tests: 8 passed. Google/Grok live service calls and macOS/Windows native execution were not exercised here.

The native smoke run uses a synthetic application form and a separate test profile. No user document or private transcript is part of the public tests. On that machine each build went into a new directory, and the previous working build was kept for rollback.

Final native font verification: a short “명조 11pt” request used the font-discovery tool to resolve the abbreviation to the exact name of a font installed on the test machine and changed only the content cell. The reopened HWPX referenced that family by name and the untouched label kept its previous font. No HY, Hancom or other license-restricted font file is part of this repository or the installers; only the open fonts listed in assets/fonts/FONTS.md (and Noto Sans KR for PDF export) are bundled. The inline textarea no longer imposes a separate 8,000-character cap. Linux test build: 1.2.0-beta.4; public test build: 1.2.0-beta.5.
