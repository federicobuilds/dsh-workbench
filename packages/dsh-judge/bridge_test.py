import types
import unittest
import bridge

CATALOG = {
    "frontend": {"description": "Design and build web interfaces", "body": "Build an accessible distinctive web UI.", "path": "skill:frontend", "refs": {}},
    "verification": {"description": "Verify source code changes", "body": "Inspect checks and evidence.", "path": "skill:verification", "refs": {}},
}


class OriginalRoutingTests(unittest.TestCase):
    def setUp(self):
        self.old_ask = bridge.original.ask
        self.calls = []
        self.gate = 0.9
        self.mcp_needed = 0.9
        def answer(state, questions):
            self.calls.append(state)
            if "rank" in questions:
                return {"rank": types.SimpleNamespace(choice="frontend", probabilities={"frontend": .8, "verification": .2}),
                        "mcp": types.SimpleNamespace(choice="github"), "mcp_needed": types.SimpleNamespace(noul=self.mcp_needed),
                        "procedure": types.SimpleNamespace(noul=self.gate), "specialized": types.SimpleNamespace(noul=self.gate),
                        "prose_suffices": types.SimpleNamespace(noul=1-self.gate), "work": types.SimpleNamespace(noul=self.gate)}
            if "pick" in questions:
                return {key: types.SimpleNamespace(choice="frontend") if key == "pick" else types.SimpleNamespace(noul=.9) for key in questions}
            return {key: types.SimpleNamespace(noul=.9) for key in questions}
        bridge.original.ask = answer
    def tearDown(self):
        bridge.original.ask = self.old_ask
    def request(self, message):
        return bridge.execute({"operation": "skill", "state": {"message": message, "task": "Build a web interface"}, "skills": CATALOG})
    def test_original_fifteen_modes_are_retained(self):
        self.assertEqual(len(bridge.original.SUBCOMMANDS), 15)
        self.assertIn("auditor-tier", bridge.original.SUBCOMMANDS)
        self.assertIn("efficiency", bridge.original.SUBCOMMANDS)
    def test_skill_and_mcp_can_both_be_selected(self):
        result = self.request("Build a web page and inspect the repository")
        self.assertEqual(result["decision"], "frontend")
        self.assertEqual(result["mcp"], "github")
        self.assertEqual(self.calls[-1]["request"], "Build a web page and inspect the repository")
    def test_user_named_server_is_never_replaced(self):
        result = self.request("Use github to inspect repository before building the web page")
        self.assertNotIn("mcp", result)
    def test_mcp_is_still_suggested_when_skill_gate_returns_none(self):
        self.gate = .1
        result = self.request("Inspect the remote repository and explain what changed")
        self.assertEqual(result["decision"], "none")
        self.assertEqual(result["mcp"], "github")
    def test_skill_index_uses_supplied_catalog_without_inference(self):
        result = bridge.execute({"operation": "skill-index", "skills": CATALOG})
        self.assertIn("frontend", result["markdown"])
        self.assertEqual(self.calls, [])
    def test_input_cannot_be_a_legacy_file_path_or_unknown_operation(self):
        with self.assertRaises(ValueError):
            bridge.execute({"operation": "wipe", "state": "anything"})


if __name__ == "__main__":
    unittest.main()
