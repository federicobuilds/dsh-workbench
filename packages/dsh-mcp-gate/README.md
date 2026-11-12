# MCP Discovery and Secret Gate

Standalone DeepSeek Harness plugin for MCP discovery enforcement, tool-result redaction, and the `dsh_governance_events` query. It uses the DSH tools registry and optionally the storage domain service.

Install the package as a DSH plugin. Do not enable it alongside the bundled `dsh-governance` gates: both register the same guard and tool. Run `npm test` with Node.js 24.9 or newer. Source was extracted from `dsh-governance`; confirm the applicable license before redistribution.
