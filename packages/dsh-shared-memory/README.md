# Shared Memory

Read, resume, and verify the same project memory from DSH, Codex, or Kilo. In DSH, use `shared_memory`. The lead session can also call `update` with a JSON revision request or `publish` to rebuild the offline view. From Codex, Kilo, or a projectless chat, call the same engine through the CLI with an absolute project root. Standard Git worktrees use the main checkout's existing memory directory.

```sh
node packages/dsh-shared-memory/cli.mjs resume /absolute/project
node packages/dsh-shared-memory/cli.mjs resume /absolute/project installer
node packages/dsh-shared-memory/cli.mjs search /absolute/project "installer"
node packages/dsh-shared-memory/cli.mjs read /absolute/project RECORD_OR_SECTION_ID
node packages/dsh-shared-memory/cli.mjs verify /absolute/project
```

These commands require Node.js 24.9 or later and Python 3 on macOS or Linux. The index and search are paginated. Reads return bounded text and a source hash. In an HTML project, resume returns the task objective, current state, constraints, blockers, next action, verification date, and source. If several tasks are active, choose an ID from the results. In a Markdown project, resume finds the relevant existing sections.

For a new Codex or Kilo chat, run `resume` before continuing the task and treat its text and source references as evidence. The package's CLI is the adapter for both harnesses. Existing projects continue through the installed Kilo renderer where available and the Workbench renderer otherwise.

## HTML migration pilot

Use a disposable copy of an existing project. Markdown remains authoritative until explicit activation. Existing legacy viewers and writers still expect Markdown, so point each participating harness at Shared Memory before switching a project's format. The pilot never changes your Markdown or companion files.

```sh
node packages/dsh-shared-memory/cli.mjs stage-html /absolute/project migration.json
node packages/dsh-shared-memory/cli.mjs activate-html /absolute/project STAGED_REVISION
node packages/dsh-shared-memory/cli.mjs verify /absolute/project
node packages/dsh-shared-memory/cli.mjs resume /absolute/project
```

The migration request is a JSON object with `author`, `reason`, and `evidence` (an array of source references). Staging returns a source baseline, a document and section mapping, counts, exclusions, and retained fact and timeline explanations. It preserves redacted source text, section references, and companion explanations in the HTML revision and its migration receipt. Original Markdown, status TSVs, and linked assets stay at their original paths. Review the receipt for exclusions and redactions before activating. Activation checks that source bytes and the companion still match the staged baseline. Pause legacy writes for the activation window.

Each HTML revision contains one validated semantic HTML document per record and a manifest with file hashes, its parent revision, author, reason, and evidence. Existing task and topic IDs stay readable across revisions. The pilot viewer renders imported Markdown as text and links to original files. It generates a searchable offline `memory.html` and a compact `memory.index.json` under `.kilocode/memory/.shared-memory-html`. The viewer identifies the revision it displays. Run `publish` to rebuild stale outputs or after a viewer template change. Verification compares both published files against the active revision.

## Updating an HTML project

Send one JSON request containing the revision you read and the complete records to replace. The same CLI works from Codex, Kilo, or a DSH terminal.

```json
{
  "expectedRevision": "CURRENT_64_CHARACTER_REVISION_HASH",
  "author": "Lead",
  "reason": "Record the installer test result",
  "evidence": ["chat-session/verification-event"],
  "changes": [
    {
      "id": "installer",
      "title": "Installer rollout",
      "status": "active",
      "summary": "Build and tests passed. Rollout is pending.",
      "source": "chat-session/verification-event",
      "verifiedAt": "2026-11-13T15:00:00Z",
      "task": {
        "objective": "Roll out the verified installer.",
        "constraints": "Use the approved target environment.",
        "state": "Build and tests passed.",
        "blockers": "Deployment target needs verification.",
        "next": "Check the target environment."
      }
    }
  ]
}
```

```sh
node packages/dsh-shared-memory/cli.mjs update /absolute/project update.json
node packages/dsh-shared-memory/cli.mjs publish /absolute/project
```

Each update checks the expected revision. The previous revision remains readable on disk. A local lock serializes updates, and the active pointer changes only after the entire new revision is written. A publication failure reports the saved revision and pending publication separately. Run `publish` again to repair it. On a synced folder, pause writers on other machines during updates and check conflicts before trusting the view. Recognized conflicted authority copies stop reads and writes so a lead can reconcile them. Other sync races depend on the sync service.

Run `rollback-html` with the active migration revision to restore Markdown authority before any HTML updates. For a project with HTML-era changes, preserve the HTML store and reconcile those changes into Markdown before any manual rollback. For a recovery export followed by rollback, pass a new absolute recovery JSON path after the revision. The export preserves the active records and the HTML store retains the revision history. Reconcile those edits into Markdown before continuing work. The pilot leaves the older memory publisher and preview hooks available for Markdown projects.

`reminders` lists open project reminders recorded in the shared store. The Memory Reminders package owns their creation and resolution.
