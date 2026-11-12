# Bash Discipline

Rules for shell command execution, adapted from Claude Code's BashTool prompt.

## Tool preference hierarchy

When a dedicated tool exists, use it instead of bash:
- File search: use `glob` (NOT `find` or `ls`)
- Content search: use `grep` (NOT shell `grep` or `rg`)
- Read files: use `read` (NOT `cat`/`head`/`tail`)
- Edit files: use `edit` (NOT `sed`/`awk`)
- Write files: use `write` (NOT echo redirect)

Exception: for multi-file batch operations (rename all .jsx to .tsx, bulk find-and-replace across a directory), a single bash command is faster and more atomic than dozens of individual tool calls.

## Parallel vs sequential command batching

- If commands are independent (both read-only, no shared state): make multiple tool calls in a single message (parallel)
- If commands depend on each other: chain with `&&` in a single bash call
- Use `;` only when sequential but earlier failures are acceptable
- If a bash command fails, cancel sibling tool calls that likely depend on it
- If a file-read fails, let other reads continue (independent operations)

## Git safety protocol

These are gates, and the destructive ones are also denied by permission in dsh.jsonc. The reason: each can destroy work that cannot be recovered.

- Never update the git config
- Never run `push --force`, `reset --hard`, `checkout .`, `restore .`, `clean -f`, `branch -D` unless explicitly requested
- Never skip hooks (`--no-verify`, `--no-gpg-sign`)
- Never force push to main/master
- Always create new commits rather than amending, unless explicitly requested
- When a pre-commit hook fails, the commit did not happen, so `--amend` would modify the previous commit
- Prefer adding specific files by name rather than `git add -A` or `git add .`
- Never commit changes unless explicitly asked. In a subagent role, a brief from the orchestrator that names the commit step is the explicit request.

## Commit message format

Use HEREDOC for multi-line commit messages to avoid shell escaping issues:
```bash
git commit -m "$(cat <<'EOF'
Commit message here.
EOF
)"
```

## Sleep avoidance

- Do not sleep between commands that can run immediately
- Do not retry failing commands in a sleep loop -- diagnose the root cause
- For tracked processes and Task workers, use the completion notification rather than a sleep or polling loop. Outside a goal, a short bounded blocking wait is allowed when necessary; raise the shell timeout as needed. Inside a goal, time-based waits must suspend through the supported scheduler or process tools.
