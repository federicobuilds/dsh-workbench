# Memory Reminders

Keep track of project memory updates during work and handoff. The plugin opens a reminder when a lead session receives an explicit request to save project memory or records a completed or blocked goal. Open reminders survive a restart and can be listed from another lead session in the same project.

Use the `memory_reminders` tool with `list` to review open items. A lead can use `suggest` for a durable decision or outcome identified in conversation. Each reminder keeps its source session and event or tool-call reference. Exact source repeats reuse their existing reminder.

Resolve an item after updating the authoritative memory record and validating its published view. For automatic reminders, use the evidence reference shown in the reminder in the HTML record’s evidence array. In Markdown, add it to the selected document as `<!-- memory-evidence: REFERENCE -->`. For Markdown projects, update the plain-language companion as part of publication. Use `resolve` with the reminder ID, the changed document's exact ID or path, and a reason linking the update to the event. The plugin checks that the document changed and that the project revision is published and valid. Use `dismiss` with a reason for an item that needs no memory update.

Install alongside Shared Memory, Governance, and Judge on DeepSeek Harness 0.2.2-rc.1. The tool is advisory. Reminder records live beside the project memory, so the DSH tool and the Codex or Kilo CLI see the same state. The lead owns edits. Explicit English save requests and native goal events work without inference. When the configured Judge route is available and authorized, it also checks completed or blocked turns for decisions, corrections, dependencies, and verified outcomes. It receives a bounded, redacted excerpt and creates advisory reminders. Inference failures leave deterministic reminders available.

From Codex or Kilo, run the installed package CLI:

```sh
node /path/to/dsh-memory-reminders/cli.mjs list /absolute/project
node /path/to/dsh-memory-reminders/cli.mjs resolve /absolute/project REMINDER_ID RECORD_ID "Linked the verified update"
node /path/to/dsh-memory-reminders/cli.mjs dismiss /absolute/project REMINDER_ID "Already covered by the project record"
```

Use `milestone` or `handoff` with a stable event ID in the DSH tool. The same actions on the CLI take PROJECT SESSION EVENT REASON. DSH also checks recent passing Verification Ledger results from the lead session at turn end.
