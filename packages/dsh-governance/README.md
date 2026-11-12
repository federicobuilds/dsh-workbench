# Session governance harness

This package provides dispatch and review, model assignment, and MCP gates. Loading the plugin alone does not establish working delegation, correct model assignments, durable state, or UI behavior.

## Capabilities

- Brief and configured seat/family validation in the dispatch facade.
- SystemOne risk/tier client; it does not implement all fifteen original judge subcommands.
- Review-state reducers and storage adapter; live persistence/restart/ownership checks remain pending.
- Role model assignment hooks. Provider availability and effort mapping are not fully commissioned.
- Persistent worker-track selection with compare-and-set revisions, independent of the lead model. The facade follows native Session.header origin/parentSession ancestry, treats ordinary forks as independent and refuses unavailable ancestors. It rechecks the track/ancestor revision immediately before worker activation; a change during judging/storage forces fresh admission. A native pre-step and llm/stream guard now checks admitted worker identity, creator/preset, actual route/effort, current track and ancestor revisions before model dispatch. Its exact configured compaction route is checked separately. Fixture tests verify no provider dispatch on refusal; real model-flow commissioning and in-flight cancellation remain pending.
- MCP gate requiring router loading, a separate successful server list and tool help. Discovery evidence now requires the canonical native Bash foreground exit status; failed, promoted, cancelled, truncated, compound or piped discovery cannot establish it. Background discovery collection is not implemented yet.
- Public redaction leaf shared by tool results, event insertion and direct UI Remote status. All seven configured patterns apply before truncation; inserted events carry only flat, scrubbed metadata while native identity fields remain stable.
- Secret-shape detection in tool results. Canonical string values are now redacted, not just displayed content. Sensitive structured error/meta/context blocks the result. This detects the configured patterns; it is not universal secret detection or confinement against arbitrary trusted plugins.
- The shared feed now receives judge, dispatch and review outcomes as well as gate/redaction records. It includes the requested/required tier and declared/judged risk when available; no prompts, wire response bodies or arbitrary error details are stored. Dispatch refuses if its required log is unavailable or the judge decision cannot be recorded before worker activation. A log failure after activation is reported without falsifying the actual action outcome. The sink is supplied through reviewed Host composition, never model arguments. Native store/restart/UI checks remain pending.

## Verification checks

The check tool decides run/use-stored/skip/registered-alternative without executing a command. Its content fingerprints use the mounted native filesystem provider, report caps/unreadable/symlink/containment gaps, and permit reductions only over declared equivalent inputs with a complete objective and fresh same-session result. Exact/overridden/unknown decisions run fresh. Raw tests are recognized through the supported runner/subcommand/wrapper/shell-substitution rules and require a one-use exact check grant; a comment override is not a bypass.

Native settled foreground Bash results in the exact workspace provide authenticated exit status, so a nonce/printf wrapper is unnecessary and the returned command stays unchanged. Completed native edits invalidate stored proofs monotonically; failed, aborted, altered, edit-overlapped or unknown/background outcomes never produce completion credit. Skips do not prove success and an alternative records only its own result, not a fake pass for the original check. Output retention is a redacted 4000-character excerpt with an honest completeness flag.

Full background/job capture, retained-output artifact copying, handback completion-marker integration and operator registry commissioning remain unfinished. Deployment registries are explicit trusted config per absolute workspace root.

## Required work still missing

Judge integration into every enforcement hook; test and resource enforcement; worker inspection; memory publication and preview; full live config/resume handling; complete purpose/variant/adapter-generation commissioning; exact Fable credential routing; model-specific and human/agent style injection; complete transparent UI with role/lane controls; comprehensive history/model/provider commissioning.

This package does not ship a UI. Historical approvals and worker prose are not current human permission. Use reviewed public DSH services; do not bypass unsupported behavior by editing committed session generations or fabricating outcomes.

## Focused verification

Tests cover native skill loading, failed/nonforeground/truncated/compound discovery, previous-server help ordering, hidden canonical values, structured-error confidentiality and the integrated gate sequence. Passing fixture tests alone does not establish live behavior.
