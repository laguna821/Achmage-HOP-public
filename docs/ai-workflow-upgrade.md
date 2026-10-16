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
