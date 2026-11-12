# Verification and Resource Ledger

Standalone DeepSeek Harness plugin exposing the `check` and `resource` tools and their execution-correlation guards. It requires DSH tools, filesystem, working-directory and storage-domain services; without storage it cannot issue decisions. Optional judge and jobs services enhance decisions and background checks.

Install the package as a DSH plugin. Do not enable it alongside the bundled `dsh-governance` ledger because tool and guard registrations overlap. Standalone track lookup uses the native session preset or stored track, not the bundled harness's in-memory role override. Run `npm test` with Node.js 24.9 or newer. Source was extracted from `dsh-governance`; confirm the applicable license before redistribution.
