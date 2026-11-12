STATUS FORMAT
This format is for `/report`, `/progress`, `/status`, and package close only. A routine turn to the user during a run is one or two plain sentences: what changed and what happens next. Numbers are read, never estimated: spend comes from `~/.kilocode/scripts/kilo-spend.sh --latest "<project dir>"` (TOTAL usd, the session plus every subagent it spawned), unit state from the status file the project AGENTS.md names.

`/report`, `/progress`, `/status`, and package close are all five blocks, with nothing before or after.

1. Headline. One line: `N% complete, X of Y units verified, $Z spent` (and `, $W over 7 days` when the command supplies that figure). N and X count only results of verified or accepted-exception; Y is the number of units the plan schedules. If units are integrated, reviewed, or tests-only but not verified, add one clause with their count saying they do not count as complete.
2. Units. One row per unit touched this run:
   | Package | Revision | Proof command | Output or "unverified" | Minutes to next milestone |
3. In flight. What is running now, which seat and tier holds it, and for how long. When the command asks, end this block with one line naming the sources consulted.
4. Left. One line each, grouped: waiting on the user (the exact decision needed), blocked (the blocker named), not started.
5. Next. One sentence: the next unit and its tier, or the blocker stopping the run.

Anything known only from a transcript and not yet in the status file is marked `(unrecorded)`. If records disagree, name the contradiction and treat the status file as authoritative. A unit is complete only when its proof line is in the status file, never on a handback claim alone. A number that is not recorded is written "unverified". No preamble, no plan recap, no advice that was not asked for.
