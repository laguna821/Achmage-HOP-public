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
Owned forms, long sources, merged/nested targets, typo/negation/follow-up scenarios, malformed/truncated replies, cancellation, revision changes, duplicate completion, save/reopen and Undo. Live OpenAI/Claude tests use synthetic fixtures only. Shadow edits are discarded on cancellation/error; commit failures roll back using the existing recovery path. Release uses a new immutable install and preserves the previous launcher target and font hashes.

## Evidence
Baseline d175ceec2e2a78a5996d40a5e5e302144210146f, upstream 1a76570e833917d15817415a53c09ad61ab3203f.
Workflow audit research rr-710893694769c49ef5f7ecc5cbf3974c revision 737a156c7666abeacad8e3d3f3ce5dc89ed62ccc6384f939b0056e2f7dfb45bc.
Accepted plan research rr-82f241968267b0bcb7803f620c2955c5 revision bff5bdc4788990e9d086cbe6f13c2bf3ac83f597a7be45d8d811439d34757a30.

## Implemented capability boundary

The default sidebar, selection popover and caret popover share the workflow loop. The old lexical router remains available only behind the explicit `workflow: false` compatibility option; local calculator/format buttons remain deterministic operations. Explicit new-document and template actions delegate to the existing Kordoc authoring boundary.

Implemented tools cover body paragraphs, flat table cell paragraphs (including merged cells), selected text, character formatting, actual checkbox controls, row/column insertion/deletion, merging/splitting, installed font discovery, and chunked current/earlier source retrieval. Each map revision invalidates previous target IDs. Writes are rehearsed on a private engine, then replayed in one live snapshot with revision fencing and postconditions. Cancellation or failure before commit discards the private draft.

Nested table paths, text boxes, headers/footers and image objects are not generalized edit targets in this iteration. They must be reported as unavailable rather than silently recreated. Public image generation remains excluded. There is a 24-step execution budget, per-tool paging and engine bounds; this does not promise unlimited model context or arbitrary document sizes. Large prior source messages remain available in the running session; restored persisted transcripts retain the existing bounded history policy.

A fresh app window starts a fresh conversation. Previous local history is restored explicitly. Switching providers retains the app's current conversation. Google CLI requests no longer resume a hidden provider-side conversation.

## Verification (Linux, 2026-10-16)

- TypeScript type check and Linux Tauri debug build, pinned upstream unchanged.
- AI regression suite: 614 passed, 3 intentionally skipped before the final font-discovery addition; the changed font/runtime/panel suites passed 96 tests afterward.
- Real Claude synthetic workflow evaluation: 9 scenarios passed, including misspellings, vague follow-up with/without referent, negation, bulk checkbox wording and form filling without selection. These are live opt-in tests, not a guarantee that every model utterance is correctly understood.
- Real WebKitGTK desktop: GPT-6.1 Sol filled a named empty cell; Claude completed another field using the same chat; the saved HWPX preserved the table; a single Undo removed only the second turn. The rendered synthetic document was inspected.
- Font files and fontconfig settings: 667 original hashes unchanged. Native inventory exposes the imported Korean fonts. Font discovery is checked independently from file preservation.
- Google CLI Rust unit tests: 8 passed. Google/Grok live service calls and macOS/Windows native execution were not exercised here.

The native smoke run uses a synthetic application form and a separate test profile. No user document or private transcript is part of the public tests. The install uses a new immutable directory and retains the previous working binary for rollback.

Final native font verification: the same short “신명조 11pt” request discovered HY신명조, loaded its actual installed bytes, and changed only the content cell. Reopened HWPX reported HY신명조/1100 and the untouched label retained its previous font. The inline textarea no longer imposes a separate 8,000-character cap. Final build: 1.2.0-beta.4.
