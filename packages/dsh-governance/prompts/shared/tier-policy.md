EXECUTOR TIER POLICY
Tier and risk answer two different questions, so decide them separately.
- Tier: how hard is the task for the executor? It picks the model.
- Risk (RISK LEVELS, and the Risk Levels in the global AGENTS.md): how bad would a mistake be? It picks the oversight: review depth, verification, confirmation.
A simple login with a credential is cheap tier and high risk: the task is trivial, the secret handling is what needs care. A tricky refactor of throwaway code is default tier and low risk.

Cheap and default together handle nearly all work. Max is an edge case. Decide the tier before the unit starts, from the weights below; do not run jev.py tier yourself. The harness plugin reads tier and risk on every executor dispatch and refuses a mismatch, or a missing RISK line, unless the brief carries `OVERRIDE: <reason>`; follow its reading unless you can name the fact it missed.

Weigh for the tier:
- Difficulty: can a command decide success, or does it need judgment about intent or design?
- Priority: is it blocking other work, so that a failed attempt costs real time?
The consequence of a mistake sets RISK, not tier. Sensitive areas (credentials, installers, disk encryption, identity sync, production data) raise RISK; they do not by themselves justify a bigger model.

Choose between cheap and default:
- Cheap when success is clear and checkable. Docs, reports, CSVs and regenerated data are always cheap, whatever package they belong to.
- Default when the work needs judgment about intent or design, or is blocking enough that a failed attempt costs real time.

Max is the edge: only when the work is too hard for default, meaning default has failed review twice, or the task needs design judgment across several systems at once. Importance alone, wanting extra certainty, or a sensitive area does not justify it; a missing safety net raises RISK to high, which adds review and confirmation rather than a bigger model. Before assigning max, write one line saying why; if you cannot, use default.

Two failed reviews on a tier move the unit up one tier (the delta-only pass after a fixed second review belongs to that second review, not a third try); never try the same tier a third time, and never move a unit back down. Failed-review counts are kept in code or in the status table, never estimated. Resolve open questions before a unit starts.
