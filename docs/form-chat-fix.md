# Existing form editing and fresh conversations

## Problem
In 1.1.0, the router detects text selected within a table cell but excludes it from the available edit operation. Empty form cells have no editing target. Routing keeps only six conversation entries clipped to 600 characters each, so clarification turns can lose the original brief. The account-menu new-conversation action leaves the visible history intact and its context cutoff disappears after restart.

## Changes
- Allow the existing single-cell text-edit operation for nonempty cell selections.
- Treat the caret in an empty paragraph of a flat table cell as an explicit input target. Reuse the snapshot-backed cell editor, preserving adjacent cells and allowing one-step undo.
- Share bounded session context between routing and writing: original first retained entry plus recent turns, at most 24 entries, 8,000 characters per entry and 48,000 characters total.
- Move new conversation to the header. While idle, clear the transcript, persisted history, pending request reference, follow-up choices and previous answer/edit references. Keep the document and account connection.

## Constraints
Multi-cell and nested-table edits remain unsupported. Existing document/selection identity checks and rollback remain in place. This change does not reintroduce image generation or modify fonts, upstream source, authentication, or release versions. New conversation clears the locally retained transcript for all providers, matching the existing global history store.

## Verification
146 focused tests passed across intent-router, panel-state, multi-range, panel, form-cell, document and selection-context suites. Coverage includes adjacent-cell/table preservation, multiline insertion into an empty cell, one-step undo and stale-target rejection. TypeScript checking and a native Linux build passed. Native smoke checks verified the header action, reset followed by reload, font loading and Kordoc startup. The local upgrade preserved all 667 protected font/config file hashes.

The user's real form was not changed for testing; live-model form editing and macOS/Windows native execution remain unverified.

## Recovery
Keep the prior installed binary and launcher until the new build has been reviewed. No document migration or font installation is required.
