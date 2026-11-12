# DSH Mac Computer Use

Adds macOS workflow guidance when the native DSH `cua` tool is available in the current session. The owner chat handles computer use and plugin management. Delegated workers can return the requested action and what the owner should verify.

Requires macOS and the DeepSeek Harness 0.2.2-rc.1 CUA bundle. Enable the upstream provider through DSH and grant macOS permissions when prompted. The plugin uses DSH’s existing app approvals and does not install a separate native provider.

For a smoke test, open a disposable document. Inspect the window through accessibility, make a reversible change, and verify the result through fresh app state. The test suite covers prompt visibility and owner-tool policy with synthetic sessions.
