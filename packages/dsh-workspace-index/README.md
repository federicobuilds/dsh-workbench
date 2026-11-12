# Workspace semantic index

Local, Ollama-backed semantic codebase index for DeepSeek Harness. Uses `embeddinggemma:300m` at `http://127.0.0.1:11434/v1/embeddings` (768 dimensions, `l2-float32` normalized vectors, finite float validation, model fingerprint stored in index header and records).

## Tools
- `dsh_index_workspace {action?, root?, maxFiles?, watch?}` — build/refresh (`action: "build"`, default), inspect status (`action: "status"`), start watching (`action: "watch"`), or stop watching (`action: "unwatch"`) the semantic index for a workspace root (defaults to the session working directory).
- `dsh_search_workspace {query, root?, topK?}` — embed the query and return the top matching code/document references (`path`, `startLine`, `endLine`, `kind`, `score`) plus freshness and `modelFingerprint`. Returns references only; read file contents with the normal `read` tool so session file policy applies.
- `dsh_index_status {root?}` — report indexed file count, chunk count, `stale`/`dirty` state, `dirtyPaths`, `watching`, Node watcher `recursive` coverage, `watchError`, `lastIndexedAt` timestamp, `modelFingerprint`, and `chunkerVersion`.

## Capabilities
1. **Local Ollama `embeddinggemma:300m`**: 768-dim validation, finite float check, L2-float32 normalization (`Math.fround`), and deterministic `modelFingerprint` (`embeddinggemma:300m|dim=768|norm=l2-float32`).
2. **Syntax-aware semantic code chunking (`ast-v2`)**: deterministic multi-language structural boundary chunker for TypeScript/JavaScript, Python, Go, Rust, C/C++, Java/Kotlin, Markdown, and JSON with fallback windowing, exact 1-based `startLine`/`endLine` tracking, and strict character + UTF-8 byte caps so single long lines never blow up chunk size.
3. **SHA-256 content-hash incremental indexing & deletion pruning**: reuses existing chunk vectors when file SHA-256 + `modelFingerprint` + `chunkerVersion` match; only embeds new or modified files and prunes deleted/newly-ignored files.
4. **Ignore rules & security safeguards**: respects hierarchical `.gitignore` and `.kilocodeignore` rules (including negations, directory-only patterns, anchored patterns, and globs), skips secret/credential paths (`.env`, `.env.*` except `.env.example`/`.env.sample`/`.env.template`, private keys, `secrets/`, `.ssh/`, PEM private key blocks), rejects symlinks (`lstat`), enforces workspace containment (`realpath` + `ctx.fs.contains`), and uses DSH `ctx.fs` when mounted.
5. **File watching & freshness status**: watches indexed roots via `ctx.fs.watch` and `fs.watch`, tracks dirty/stale state on file mutations, and detects filesystem or model-fingerprint drift on status inspection.
6. **Atomic index publication**: writes to an exclusive `0600` temp file, `fsync`s, `chmod(0o600)`s, and atomically renames into place; validates `maxFiles` bounds (`1..20000`).

## Embedding destination

The loopback Ollama endpoint is the default. An external endpoint requires an HTTPS `baseURL` and explicit `allowExternalEmbeddings: true` in the plugin settings. The request sends source chunks that pass the workspace filters and search query text. Redirects are refused. The index card shows the configured destination and the type of data sent. Use `autoBuild: false` to require a manual build and `autoWatch: false` to disable automatic watching.
