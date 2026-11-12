# Chat delete

Standalone delete-only plugin for DeepSeek Harness 0.2.2-rc.1.

Hover a chat row and use the trash button immediately after Archive, or choose
**Delete permanently** in its menu. The dialog checks the saved chat before
showing the confirmation button. Open/running chats and chats held by another
writer are refused. Close or stop them first.

## What deletion means

The saved DSH transcript is permanently removed, workspace accounting is
cleaned up, and the native projection cache entry is removed through its
storage-domain table. The chat remains in the host's archive gate so it cannot
be woken from a stale header lookup. Native session search reconciles missing
transcripts on its next search.

Shared attachments, exports, backups, external search indexes such as the
separate chat-search index, and data already held by an in-flight reader are
not erased. The dialog states this limitation. This is not forensic erasure.

## Safety

- Owner-authenticated RPCs with a two-minute, one-use confirmation bound to
  the requesting connection, session ID, saved revision, and exact path.
- Current-format, materialized, regular files only. Multiple transcript
  generations and path symlinks are refused before write-open.
- Exclusive DSH write ownership, fresh checks under that lease, and rechecks
  for live activity. Only the exact transcript is unlinked. The session
  directory and stable `session.lock` inode are retained.
- Deletion is the irreversible commit point. After it, cleanup continues even
  if the request is cancelled. Cleanup failures are reported as warnings,
  never as “nothing was deleted”.
- Failed unlink restores archive/pin state when this operation changed it.
- The dialog uses native modal focus containment, Cancel-first focus, Escape,
  responsive sizing, keyboard-operable menu buttons, and English/Spanish text.
- No workspace moving, document-wide drag interception, or automatically
  authorized agent deletion tool is included.

## Tests

`node --test index.test.mjs`

The tests use real self-owned fixture files and DSH-service doubles. They do
not count as a native-backend or browser integration test. See
[verification](<VERIFICATION.md>) for the recorded evidence and limitations.
