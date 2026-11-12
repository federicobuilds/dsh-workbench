# DSH chat search refresh

This plugin does not bundle the chat search MCP server. Automatic refresh is disabled by default. To enable it, provide absolute `mcpDir` and `pythonPath` paths for a separately installed server and its Python interpreter, and set `autoUpdateOnTurnEnd` to true. The interpreter must be executable and `mcpDir` and `sessionsRoot` must be existing directories. `dbPath` defaults to `~/.dsh/chat-index.db` and `sessionsRoot` to `~/.dsh/sessions`; both are configurable absolute paths. Existing embedding configuration fields are retained but ignored by this refresher.

Turn-end refresh calls only `indexer.update_index()` for incremental keyword indexing; it does not invoke embedding jobs. Semantic index freshness must be maintained separately. The returned cleanup function exposes a snapshot as `.status`. A successful update includes counts and current coverage; incomplete coverage, failed sessions, invalid output and child errors are failures. Stderr diagnostics are bounded and do not expose its contents. At most eight failed session identifiers are reported, with fixed error categories instead of raw failure text; identifiers that are not simple bounded IDs are omitted.

The package requires Node.js 24.9 or later, DSH 0.2.2-rc.1, and the `@deepseek-ai/schemastery` 3.19.x peer supplied by DSH. Tests use fake children and do not launch Python or access chat data.

Automatic refresh coalesces overlapping turns and stops a stalled indexer after five minutes by default. Set `timeoutMs` to change the deadline. The three legacy embedding fields are accepted for compatibility with older profiles. Keyword refresh uses the separately configured local indexer.
