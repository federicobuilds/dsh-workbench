# Project Memory Viewer

Standalone DeepSeek Harness plugin providing `memory_preview` and the memory companion publication and completion hooks. The viewer binds to loopback and invokes the bundled Python 3 filesystem helper.

Install the package as a DSH plugin. Do not enable it alongside the bundled `dsh-governance` memory viewer because tool and hook registrations overlap. Run `npm test` with Node.js 24.9 or newer and Python 3. Source was extracted from `dsh-governance`; confirm the applicable license before redistribution.
