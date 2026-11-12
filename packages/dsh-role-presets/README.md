# Role Presets

Provides selectable DSH roles and worker presets. The included examples define role prompts and model routes. Configure the providers available in your DSH profile before choosing a route.

The runtime preset source is `presets-data.json`. In the Workbench checkout, run `node packages/dsh-role-presets/validate.mjs --write` after changing a worker preset to synchronize the plugin settings in Governance’s worker patterns. `npm run verify` checks the two files for drift. Governance’s session-role prompts live in its own `roles/` directory.
