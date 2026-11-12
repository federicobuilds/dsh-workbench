# Source provenance

Workbench’s own plugins come from the locally maintained DSH Workbench and local plugin collection. The public defaults use example roles and a sanitized configuration. The diagnostic probe, archived role rosters, desktop profile state, and the separate MCP Toolbox are outside this source release.

## DeepSeek Harness

Message Edit includes a modified copy of `packages/client/ui-chat/src` from DeepSeek Harness. The comparison base is tag `dsh-v0.2.2-rc.1`, commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`. The MIT notice from that revision is included as `packages/dsh-message-edit/DSH-LICENSE`. [Upstream source](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-chat/src)

Of the 129 vendored files, 109 match the upstream revision byte for byte. Workbench modifies the following 15 files and adds five files for the editor, model selector and message-edit callbacks. Modifications dated 11 November 2026.

- `chat-settings.ts`
- `client/apply.ts`
- `client/chat/AssistantNodeView.tsx`
- `client/chat/ChatView.tsx`
- `client/chat/MessageIconActions.tsx`
- `client/chat/MessageItem.module.css`
- `client/chat/MessageItem.tsx`
- `client/chat/TurnTailNodeView.tsx`
- `client/chat/register-node-renderers.ts`
- `client/contract/chat-visibility.ts`
- `client/contract/store.ts`
- `client/conversation-nodes/chat-snapshot-builder.ts`
- `client/index.ts`
- `client/locale.ts`
- `client/stores.ts`

The bundle includes npm dependencies with notices assembled from the build inputs. `dist/LICENSES.md` lists their resolved versions and license notices. React, React DOM, Cordis and the virtualizer are provided by DSH at runtime.

## Judge and role resources

Judge’s `original_judge.py` comes from the locally maintained Kilo decision engine. The DSH bridge is the integration layer. Its TypeSafe SDK dependency is installed separately through `requirements.txt`. Role descriptions originate in the local Workbench role collection and use portable examples in this release.

## Separate plugins and services

The DeepSeek CUA bundle is an upstream runtime prerequisite for the macOS guidance plugins. `dsh-cost-meter`, `billion-context`, and third-party MCP servers are separately maintained and outside this distribution.
