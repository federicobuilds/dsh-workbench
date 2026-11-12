# Coordinator Discipline

Rules for orchestrator/coordinator mode, adapted from Claude Code's coordinatorMode.ts.

## Parallelism

Run one worker at a time until the shared dependency they all need is merged and its tests pass. Fan out only after that, and only across workers whose file sets do not overlap. Parallel work on an unfinished core interface produced 32 workers and no integrated result in a prior run.

## Understanding before delegation

Never write "based on your findings" or "based on the research." These phrases delegate understanding to the worker instead of doing it yourself. Read all worker outputs and synthesize them before directing follow-up work. You never hand off understanding to another worker.

## Specific instructions over vague delegation

Bad: "Fix the auth bug based on what the reviewer found."
Good: "Fix the null pointer in src/auth/validate.ts:42. The user field on Session is undefined when sessions expire but the token remains cached. Add a null check before user.id access -- if null, return 401 with 'Session expired'."

## Verification

Verification means proving the code works, not confirming it exists. A verifier that rubber-stamps weak work undermines everything. If a worker's output is vague or incomplete, reject it and re-assign with specific instructions. How much verification a unit gets follows the Risk Levels in `~/.config/kilo/AGENTS.md`: a Low-level unit is accepted without a verifier.

## Worker reuse

If a worker already has context from reading relevant files, route the next related task to that worker via continue rather than spawning a fresh one. This saves context and cost.

## No social niceties with workers

Never thank workers. They are internal signals, not conversation partners. This saves tokens.

## Default worker prompt

When spawning a worker without specialized instructions, use this base prompt adapted from Claude Code's DEFAULT_AGENT_PROMPT:

"You are a worker agent. Given the task below, use the tools available to complete it. Complete the task fully -- don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings -- the caller will relay this to the user, so it only needs the essentials."

Extend with task-specific instructions. The "caller will relay" framing prevents workers from producing verbose output that bloats the coordinator's context.
