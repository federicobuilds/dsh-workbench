"""DSH adapter around the unchanged original DSH decision functions.
No legacy TSV writes, filesystem skill scans or input-path interpretation.
The Node caller owns authorization and supplies the scoped skill catalog.
"""
import argparse
import json
import signal
import sys
import original_judge as original


def execute(payload):
    if not isinstance(payload, dict) or set(payload) - {"operation", "state", "skills", "options"}:
        raise ValueError("Invalid decision envelope")
    operation = payload.get("operation")
    if operation not in original.SUBCOMMANDS:
        raise ValueError("Unsupported decision operation")
    state = payload.get("state", "")
    original.check_json(state)
    text = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)
    skills = payload.get("skills", {})
    if not isinstance(skills, dict):
        raise ValueError("Invalid skill catalog")
    catalog = {}
    for name, entry in skills.items():
        if not isinstance(name, str) or not isinstance(entry, dict):
            raise ValueError("Invalid skill candidate")
        if set(entry) - {"description", "body", "path", "refs"}:
            raise ValueError("Unexpected skill field")
        if not all(isinstance(entry.get(key, ""), str) for key in ("description", "body", "path")):
            raise ValueError("Invalid skill text")
        refs = entry.get("refs", {})
        if not isinstance(refs, dict):
            raise ValueError("Invalid references")
        path = entry.get("path", "")
        if path and original.Path(path).is_absolute() and original.Path(path).name == "SKILL.md":
            root = original.Path(path).parent.resolve()
            for ref in sorted(root.glob("references/*/*.md")):
                resolved = ref.resolve()
                if not resolved.is_relative_to(root) or not resolved.is_file() or resolved.stat().st_size > 256000:
                    continue
                parsed = original.frontmatter(resolved)
                if parsed and ref.stem == ref.parent.name:
                    refs[parsed[0]] = {"path": str(resolved), "description": parsed[1], "body": parsed[2]}
        catalog[name] = {"description": entry.get("description", ""), "body": entry.get("body", ""),
                         "path": path, "refs": refs}
    # Every discover/rerank call sees the caller-visible DSH catalog, not legacy roots.
    original.SKILL_ROOTS = []
    original.discover_skills = lambda: catalog
    options = payload.get("options", {})
    if not isinstance(options, dict) or set(options) - {"failed_reviews", "current", "rule_a", "rule_b", "situation"}:
        raise ValueError("Unsupported judge option")
    args = argparse.Namespace(failed_reviews=0, current=None, rule_a="", rule_b="", situation="", **{})
    for key, value in options.items():
        setattr(args, key, value)
    signal.signal(signal.SIGALRM, original.deadline)
    signal.setitimer(signal.ITIMER_REAL, max(original.DEADLINE_S - (original.time.monotonic() - original.START), 0.001))
    try:
        result = original.SUBCOMMANDS[operation](text, args)
        if operation == "skill-index":
            result["markdown"] = result["markdown"].replace("`~/.config/kilo/harness/judge/judge.py skill-index`", '`dsh_decision(operation="skill-index")`')
        return result
    except original.JevUnavailable:
        return {"decision": "UNSURE", "why": "Decision model unavailable or input could not be verified", "unavailable": True}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


def main():
    try:
        payload = json.loads(sys.stdin.read(2 * 1024 * 1024 + 1))
        result = execute(payload)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except (ValueError, TypeError, KeyError):
        print(json.dumps({"decision": "UNSURE", "why": "Invalid decision input or output", "unavailable": True}))


if __name__ == "__main__":
    main()
