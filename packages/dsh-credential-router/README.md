# Credential router

The plugin selects the first matching rule and applies its destination's credential to the request. Unmatched requests use `defaultDestination`; `passthrough` leaves them untouched. Configure each destination with exactly one `keyFile` or `keyEnv` reference. File permissions are checked by default on POSIX systems.

Rules accept `provider`, `model`, and `purpose` string or string-array conditions. Conditions on the same rule must all match. `matchQualifiedAndUnqualified` and `unqualifiedAliases` are available for rules scoped to the `openrouter` provider. Destinations can specify `headerName`, `headerPrefix`, `baseURL`, non-auth `headers`, `requireStrictPermissions`, and `errorMessage`.

The bundled `personal-fable` preset routes OpenRouter Fable 5.1 to its dedicated file and leaves other requests unchanged. `personalFablePreset` accepts explicit file paths when constructing a custom configuration. Missing, empty, unreadable, or improperly permissioned selected credentials stop the request rather than selecting another destination.

Only one credential router should be active for a request. When this plugin is enabled with dsh-governance, set `disableBundledCredentialRouter` to `true` in the harness configuration.
