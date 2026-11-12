# DSH Workbench

DSH Workbench provides 21 plugins for DeepSeek Harness 0.2.2-rc.1. The collection includes session editing and deletion, workspace search and placement, role and worker governance, progress indicators, and macOS computer-use guidance. Browse the [package catalog](site/index.json) or the README in each package.

## Install

Use an existing compatible DSH profile, Node.js 24.9 or later, npm and tar. The installer selects 19 packages on Linux and adds the two native guidance plugins on macOS for a total of 21. The macOS guidance requires the upstream DSH CUA bundle.

Close DSH and try the installer with a disposable profile first. Run the command from the Workbench source checkout:

```sh
node scripts/install-profile.mjs /absolute/path/to/dsh-profile
```

The installer builds npm archives from the included artifacts, verifies the hashes, and stages all packages before updating the profile. It backs up the original manifest and patch in `.dsh-workbench-backup/`. Existing bundles and settings are preserved. For a previously packed release, pass the directory containing `archives.json` as the second argument.

For profiles with an existing `cordis.patch.yml`, reconcile the Governance and Judge entries with their package patches before launching. With the full collection installed, the Governance patch disables its bundled MCP Gate, Search Guard, Credential Router, Verification Ledger and Memory Viewer. The Judge patch disables its bundled Skill MCP Router, allows local inference and disables external inference. A blank patch gets these defaults during install.

## Optional services and data

- **Judge** uses a dedicated Python 3.12 environment. See the [Judge setup](packages/dsh-judge/README.md). Set `DSH_JUDGE_PYTHON` in DSH’s process environment. Configure any external judge route separately in DSH.
- **Workspace Index** defaults to local Ollama and the `embeddinggemma:300m` model. It builds and watches by default. Set `autoBuild: false` or `autoWatch: false` to control that behavior. To use a non-loopback endpoint, configure an HTTPS URL and set `allowExternalEmbeddings: true`. The endpoint receives eligible workspace text and search queries. The status card shows the destination.
- **Prompt Enhancer** sends plain-text drafts when the owner uses Enhance. The button identifies the provider. Configure provider credentials in DSH.
- **Chat Search** needs a separately installed DSH chat-search MCP server, its Python interpreter and absolute paths to the local index and sessions. Automatic refresh is off by default. The index is local private data.

Review each plugin’s configuration in DSH before enabling a model or local service. Workbench ships no credentials.

## Develop and verify

```sh
npm ci --ignore-scripts
npm run build
npm run verify
DSH_SDK_ROOT="$PWD" npm test
DSH_SDK_ROOT="$PWD" npm run test:smoke
npm run pack:release -- /absolute/path/to/release-archives
```

`npm run build` rebuilds the Message Edit host and client bundles from the included modified chat source. The smoke test installs the generated archives twice in a temporary profile, checks imports and verifies selected tools and services without model calls. To test against macOS Desktop’s embedded SDK, set `DSH_SDK_ROOT` to `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh`. The script reads the archive through Electron’s Node mode.

Use `DSH_TEST_OLLAMA=1` to include the live loopback embedding tests with a local Ollama model. For the optional Message Edit browser suite, see its [test instructions](packages/dsh-message-edit/VERIFICATION.md).

## Licensing

Workbench code is AGPL-3.0-only. The upstream DSH Chat code and bundled dependencies carry their own notices. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [provenance](PROVENANCE.md).
