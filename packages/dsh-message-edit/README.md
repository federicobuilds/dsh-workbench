# Message editor

A DSH profile plugin for editing actual user and assistant message text. No replacement app is required.

## Using it

Hover a message, or focus its actions, and choose the pencil button. On touch screens the actions remain visible.

- **User text:** **Save and regenerate** cuts the selected message and everything after it out of the active Chat and model history in the exact same session, optionally switches the regeneration model, and submits the revised text directly without creating or duplicating a session. **Save and fork** makes the same cut in a new session while leaving the original conversation untouched. No artificial regeneration instruction is appended.
- **Assistant text:** the editor starts with the reply itself. **Save changes** updates its displayed text and the effective history used by future model requests. It does not regenerate the reply or change your prompt. **Save in a fork** is available when you want to keep the change separate.
- **Cancel** or Escape discards a history-edit draft. Enter saves, and Shift+Enter inserts a new line. Empty drafts cannot be saved. Failed saves retain the draft. For a queued draft, cancellation restores the original queued message.

- **Queued text:** editing removes the message from the live queue and puts it in **Editing, held aside**. The assistant cannot claim it there. Enter saves and re-queues the revised text; Shift+Enter inserts a line. Escape or Cancel restores the original queued message. Held originals are recoverable after a reload, and attachments stay attached.

Stored original records are not rewritten. User history cuts remove the later messages from the active generation while retaining the previous log as an archive backup. Assistant and queue text edits preserve non-text blocks, and earlier edits are explicitly carried forward into new generations.

## How it works

The Host stores successful edit decisions as paired, plugin-namespaced `command/run` and `command/done` records already supported by the installed Session format. One profile-owned message interpreter applies those decisions to effective model history. A Session projection supplies the same edits to the Chat view, including older paged history. Saves use an idle maintenance reservation, optimistic revisions, and a durability flush.

The bundle uses the supported Loader patch to pause the shipped `ui-chat` row while a version-matched Chat extension is enabled. This preserves DSH’s familiar message layout, Markdown, tool cards, approvals, attachments, and feedback controls, adding the inline editor beside Copy. The extension and its reachable static UI code are packaged inside the plugin, with their license notices. Removing the bundle restores the original Chat row and its unchanged settings. No app installation, application shell, or session file is patched.

## Safety and limits

- Keep the plugin enabled to use its edited history. Readers without the plugin, including the original Trajectory and export views, show original content.
- Removing the interpreter from a live session can make that session refuse further model-history derivation. Stop active work before disabling the plugin; restarting reopens the original records. Changing plugin code after editing likewise requires a restart so sessions use one interpreter generation.
- An assistant message already absorbed into a compaction summary cannot be edited in place. Use **Save in a fork** instead. User edits already create a fork.
- In-place assistant edits do not undo past tool actions or rerun subsequent replies.
- Conflicts retain the draft; reopen the message to review the latest text before saving again.
- If a fork exists but an edit, queue operation, or flush fails, the error names the child and does not silently create another fork. Review that child before retrying.

## Project layout

- `journal.mjs`: shared durable edit validation and interpretation.
- `host.mjs`: command, maintenance, fork, projection, and durability operations.
- `native-chat/src`: version-matched Chat presentation with inline editing.
- `bridge.mjs`: connects its editor to the installed command API.
- `history-cut.mjs`: prepares the preceding history and replaces or forks the active generation.
- `queue.mjs` and `queue-client.tsx`: recoverable queue reservations and held-draft UI.
- `dist/index-3.3.0.js` and `dist/client-3.3.0.js`: self-contained distribution artifacts.
- `dist/LICENSES.md`: notices for bundled UI dependencies.
- `*.test.mjs`: original-runtime and real React regression tests.
- `plugin.e2e.ts`: isolated Loader/browser integration tests; never uses the desktop profile.

The build script uses the already-installed workspace toolchain to produce the distribution artifacts. Running the installed plugin does not depend on that source checkout or its build tools.
