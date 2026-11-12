# Message editor — verification

## Staged repair qualification

The current repair is verified only with synthetic fixtures and the extracted original Session runtime. DOM tests do not establish behavior in a running application. Package-local dependency links are development-only and are not a release provisioning method. Old v1 and v2 edit-receipt formats are not specified by the staged parser or inspected 3.1.0 and 3.2.0 artifacts; their replay is not claimed.

## 3.3.0: in-place same-session user regeneration, model selector, and queue holds

- **In-place user regeneration (`Save and regenerate`):** cuts the target user message and all subsequent messages inside the exact same session (`sessionId` is unchanged, no fork or archived duplicate session is created) and submits the revised user message directly.
- **Regeneration model selector:** user message editor includes a model selector (`Regeneration model`) populated from the live model catalog, allowing regeneration in-place or in a fork with a different model without altering global defaults.
- **Explicit fork (`Save and fork`):** forks the active prefix into a separate session and regenerates there while leaving the source session unchanged.
- **Queued message editing:** clicking Edit on a queued message reserves it out of `inbox.nextTurn` into a held draft so the running loop cannot consume it; `Enter` saves and re-queues it, and `Escape`/Cancel restores the original queued message with attachments intact.
- **Verification:** 26 original-runtime, inbox, and V4 persistence tests pass (`journal.test.mjs`, `host.test.mjs`, `queue.test.mjs`, `persistence.test.mjs`), and all 8 real Loader/Playwright browser tests pass (`plugin.e2e.ts`).

## 2026-11-07 compressed header layout correction

The first repair incorrectly compressed the entire log into one Zstandard frame. Its decompressed events passed the SessionLogScanner, but DSH's session listing requires an independently decodable first frame containing exactly the header line. The earlier statement that the repaired artifact was fully verified was incomplete.

The compressed layout is now corrected to a header-only frame followed by an event frame. The installed frame scanner and strict event reader accept the published artifact, with all 10,761 events and every decompressed byte unchanged from the receipt-repaired log. Both the original log backup and a backup of the intermediate one-frame artifact are retained. A regression now rejects the one-frame encoding and accepts the header-separated encoding. All 25 plugin tests pass. Reload the existing GUI to refresh its session list; visible listing remains unverified from this agent.

## 2026-11-07 durable receipt repair

Message-edit receipts now reference the edited message event, not the internal command/run event. The installed V4 persistence reader rejects command/done references to command events even though the in-memory Session accepts them.

- The new persistence regression reproduced `command/done has invalid sourceEventSeq` before the correction. All 24 journal, Host, queue, and persistence tests passed after rebuilding the plugin artifacts.
- The affected session's receipt at sequence 9945 was repaired from sourceEventSeq 9944 to 9935 under the session's exclusive kernel lock. The installed reader accepted all 10,761 events, including after recompression and publication. Every other record was retained byte-for-byte in the decompressed log.
- An exact compressed backup is retained beside the repaired session. No session events, message text, or edits were deleted.
- The installed profile resolves the corrected versioned Host artifact. Restart Harness to load it into the running backend. The live interpreter was not removed or toggled. The existing GUI returned HTTP 401 to an unauthenticated request, so a successful history load in that GUI has not been verified.

## 3.2.0 correction: actual history cuts and held queue drafts

The 3.2.0 implementation used a separate generation and archive. The current 3.3.x implementation instead cuts the active surface within the same session for `save`; explicit `fork` creates a separate child. Original records remain in the event history.

Queued editing records a recoverable reservation and removes the item from the model-consumable inbox before opening the editor. Enter re-queues the revised content. Escape restores the original content. Attachments and original identity are preserved, and repeated release cannot duplicate already queued or sent input.

- **22 original-runtime/inbox tests passed.** They cover history cuts, assistant saves, queue claim races, interrupted reservations, cancellation, attachments, and replay.
- **8 real Loader/browser tests passed.** They verify no old tail or artificial instruction in active Chat/model input, explicit fork behavior, reload persistence, active generation continuing without consuming a held draft, Enter re-queue, and Escape restore.
- The workspace-linked package files are updated to versioned 3.2.0 artifacts. Restart Harness to load the backend and UI together. The live interpreter was not toggled underneath edited sessions.
- The earlier archive statements above describe the historical 3.2.0 deployment, not the current in-place implementation.

## 3.1.0 correction: user destination choice

The user editor now offers **Save and regenerate** in the current conversation and **Save and fork** in a separate conversation. Assistant behavior is unchanged. Same-chat regeneration preserves subsequent records and appends a new response.

- Original-runtime regressions: **15 passed**, including same-chat user editing with no child creation and explicit fork behavior.
- Packaged-plugin real Loader/browser tests: **6 passed**, including both visible buttons, same-chat regeneration with unchanged session identities, explicit fork navigation, assistant save, and reload persistence.
- Versioned Host and Client artifact paths are used for a clean next-start generation. The workspace-linked installed package is updated, but the already-running Host retains v3.0 code until Harness is restarted. No live interpreter removal was performed for this correction.

## 3.0.0 distribution and deployment

- Deliverable: `local-dsh-message-edit-3.0.0.tgz`, created by `pnpm pack` with the compiled Host and Client artifacts, source, metadata, icon, documentation, and bundled dependency notices.
- Installed through DSH Plugin Manager into the existing desktop profile.
- Install result: `application: applied`, version `3.0.0`, no activation warnings.
- Live Host inspection confirms `include:message-edit` with a Config schema and the installed package directory.
- Live Client inspection confirms the Chat view and its user, assistant, turn-tail, tool-view, and feedback slots are registered.
- The existing user settings patch was read before and after installation; its model, Chat settings, conversation settings, and telemetry choices were not rewritten.
- No replacement app was installed and no app installation file was modified.

## Tests executed

### Original-runtime regression tests — 14 passed

`node --test journal.test.mjs host.test.mjs`

The session implementation under test is the original extracted desktop runtime, not the previously modified source Session implementation. Tests verify actual text changes for both roles, original-record and non-text preservation, exact whitespace, revision conflicts, invalid/compacted targets, replay, old-reader fallback, durability failures, partial forks, explicit inheritance of earlier edits, and the incremental view.

### Packaged-plugin real Loader/browser tests — 5 passed

`DSH_SNAPSHOT=replay node node_modules/vitest/vitest.mjs run --config ../dsh-message-edit/e2e.config.ts`

The test harness creates an isolated profile, installs the packaged plugin fixture, boots the real Loader and browser shell, and uses Chromium to:

1. Load the native Chat extension and find Edit on both roles while retaining Copy and feedback controls.
2. Use and cancel the inline editor at a 390px viewport without changing history.
3. Save the actual assistant text and assert that effective model history changes while the original assistant event remains unchanged and no model call is issued.
4. Reload the browser and retain the assistant edit.
5. Edit actual user text, create a child, and obtain a regenerated assistant response using a deterministic adapter. The source conversation remains unchanged.

The deterministic adapter replaces only the external model/network boundary. The editor, command transport, session operations, projections, Loader, and rendered browser UI are real.

## Limits retained intentionally

- The plugin must remain enabled for its edited history. Other readers and original exports/Trajectory views show originals.
- Removing an interpreter from live sessions can require restarting those sessions before further model-history operations.
- Compacted assistant messages must be edited in a fork, not in place.
- Saves wait for idle maintenance; existing replies and past tool side effects are not rerun or undone by assistant edits.
- Visual interaction was exercised in the isolated real browser run. The connected desktop page's registrations were inspected; no claim is made that its buttons were clicked by browser automation.

## Run the optional browser suite

Build the plugin, then make a built DeepSeek Harness 0.2.2-rc.1 source checkout available as `packages/dsh-source` (a local symlink is sufficient). Install the upstream web-test dependencies and Chromium through that checkout. From the Workbench root, invoke the upstream Vitest binary with `--config packages/dsh-message-edit/e2e.config.ts`. Use replay mode and a clean environment. The suite uses synthetic chats and a deterministic adapter.
