# Existing form operations
Background: checkbox requests can be misrouted to template recomposition; clearing the selected template is obscure.
Goal: expose preserve-format default; execute explicit all-checkbox clearing locally using existing form setters inside one rollback-capable snapshot.
Non-goals: arbitrary table structural edits, changing radio buttons, interpreting drawn/Unicode symbols as interactive forms, regenerating existing forms.
Implementation: bounded render-tree discovery plus hit-tested native addresses, deduplicate repeated controls, preflight all targets, apply and read back. Reject ambiguous addresses before mutation. Report actual count and coverage, not universal completion. Router must not substitute recomposition for unsupported object edits.
Verification: native pinned engine body/table form fixtures, readback, export/reopen, Undo, idempotence; routing negatives; UI clear-template persistence. Existing fonts and user documents untouched. Immutable local install; previous launcher retained for rollback.

Validation: 133 focused tests passed with one worker (parallel run hit CPU-contention timeouts; corrected panel harness dispatches input before click). TypeScript passed. Native public body HWP and table HWPX fixtures clear, preserve text/control list, save/reopen, and Undo to identical exported bytes. User document and arbitrary table restructuring are not validated.
