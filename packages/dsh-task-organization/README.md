# Task Organization

Choose **Ask Judge** below a text draft to check whether it serves the current task, deserves a new chat, resumes another chat in the same workspace, or mixes outcomes that need clarification. A result expires when the draft changes.

When the Judge suggests a new chat, review its title and workspace. **Prepare new chat** puts the draft in the destination composer. **Send to new chat** queues the request there directly. The same two actions are available for a matching chat. A failed admission keeps the source draft and retries the same destination and request ID while the suggestion remains open.

New chats receive related excerpts from up to three completed source turns, with native session IDs, event ranges, and worker references. The original conversations keep the complete transcripts. Review the resulting prompt before sending by using **Prepare new chat**. The Judge receives the current objective, the last few user messages, and up to eight candidate titles through the existing Judge authorization and worker track.

## Compatibility

DeepSeek Harness 0.2.2-rc.1, Side Chats 0.1.0, and Workbench Judge 1.0.2. Enable all three packages in the Desktop or Web profile.

Turn on **Route with Judge on Send** in a chat to check an ordinary text draft before queueing it. The Judge sends a clear match to the existing chat or opens a new chat for a separate task. Ambiguous drafts remain in the composer with the suggestion and a **Send here** action. Commands, references, attachments, and non-queue submissions use the standard DSH path. The setting is saved per chat in the client. Decisions show the selected worker track and the rule or backend.

Related turns carry source event ranges and worker references. Complete original transcripts remain available in their source chats.

When the selected hosted judge is blocked by profile policy, chat routing uses the authorized local judge if one is available. The composer identifies the backend it used. If inference is unavailable, Send uses the original chat. An uncertain answer leaves the draft for review.
