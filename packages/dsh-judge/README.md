# Decision support

The Python engine supports risk, tier, dispatch, conflict, lane, route, auditor-tier, search-scope, skill, skill-index, claims, repeat, check, resource, efficiency, task organization, and memory reminder decisions, including Choice/Noul gates, shortlists and reranking.

## Integration

- `dsh_decision` exposes advisory decisions in the receiving session's actual worker track, not a model-supplied backend override.
- The `dshJudge` Host service gives reviewed runtime modules the same bounded decision interface. Decisions never authorize external operations or dispatch workers.
- Before a top-level user-message step, the router follows the minimum-six-words, one-message/one-suggestion rule. Nonhuman context and native subagents are excluded. It supplies the earlier user task as bounded context on resumes where native history is available.
- Candidates come only from DSH's scoped, model-invocable registry. Native pack content supplies rerank excerpts; trusted instruction-file resource roots retain optional reference reranking, with realpath containment and file limits. No legacy global skill roots are scanned.
- Returned advice names the actual pack and native skill loader, not an invented leaf skill or unsupported command. MCP advice preserves the named-server boundary and discovery/maintenance rules. No negative/none note is added to the model.
- Input uses stdin, not shell interpolation/argv; child lifetime, output and deadline are bounded and cancellation follows the owning plugin/activity.
- The adapter calls engine functions directly, avoiding legacy TSV logging, legacy input-file interpretation, maintenance and arbitrary output paths. The shared DSH event feed records bounded decision metadata instead.
- Skill-index is metadata-only and requires no inference authorization.

## Authorization and verification

The shipped patch enables local-only inference and disables external inference. Local inference still requires a configured local model and the pinned Python dependency. Fixture tests replace model responses; no live probe is made. Enabling external inference requires separate actual operator authorization, especially for paid or private-data transmission. Failures are UNSURE with generic diagnostics; no stdout/stderr/key material is exposed as an error explanation.

Six Python fixtures and three Node fixtures pass, covering the fifteen-operation table, skill+MCP picks, user-named MCP boundaries, MCP advice without a skill pick, metadata indexing, input refusal, authorization/no-spawn, bounded stdin/Unicode and native router filters/notes.

## Verification limits

The dispatch facade uses a separate risk/tier client. Check, resource, efficiency, claims, worker and memory enforcement requires its own integration. Native hooks, scoped catalogs and references, caller and effort routing, and end-to-end UI behavior remain to be verified.

The default interpreter is ~/.dsh/profiles/desktop/runtime/dsh-judge/.venv/bin/python; set DSH_JUDGE_PYTHON to override it. Create an environment with `python3.12 -m venv .venv`, then run `.venv/bin/python -m pip install -r requirements.txt`. Set `DSH_JUDGE_CONFIG` to an absolute custom `judges.json` path when needed; that file defines local endpoints and credential-file paths. Inference requires the selected environment and configured model service.

Credential references and model services remain operator-managed. Do not copy, rotate or delete credentials as part of configuring this adapter.

To check the bridge without inference, run this command from the package directory using the dedicated environment:

```sh
printf '%s\n' '{"operation":"skill-index","state":"","skills":{}}' | .venv/bin/python bridge.py
```

The bridge should emit a JSON decision for an empty skill catalog.

Memory and chat focus fall back to the authorized local judge when the worker track selects a hosted judge blocked by profile policy. Governance events record the selected track, backend, and outcome, including uncertainty and failures.
