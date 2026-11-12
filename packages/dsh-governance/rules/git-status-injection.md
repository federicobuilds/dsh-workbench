# Git Status Injection

When a task involves git (commits, branches, PRs, reviewing changes, or "what did I just do"), and the workspace is a git repository, silently run the following commands once and use the output as background context. Skip them for tasks that do not touch git; four commands per session add up. Do not announce or display the results unless the user asks.

## Commands to run silently, once per session, when the task involves git

1. `git rev-parse --abbrev-ref HEAD` -- current branch
2. `git log --oneline -n 5` -- last 5 commits
3. `git status --short` -- working tree status (truncate at 2000 chars if longer)
4. `git remote get-url origin 2>/dev/null` -- remote URL (if available)

## How to use this context

- Know which branch you are on before making any commits or suggesting branch operations
- Know what was recently committed to understand the current state of work
- Know what files are dirty/staged to avoid conflicts with uncommitted work
- If the user references "the last commit" or "what I just did," you have the answer without needing to run git commands
- When creating commits, target the correct branch. When suggesting PRs, know the base branch.

## Do not

- Do not display git status output in your response unless asked
- Do not run these commands if the workspace is not a git repository (check for `.git` directory first)
- Do not store git status in memory -- it changes constantly and is always available via commands
