window.__ModuleLoader__.load({
  id: '@dsh-workbench/dsh-side-chats',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react');
    const interactionSlot = 'conversation.chat.text-interaction';
    const headerSlot = 'conversation.session.header.actions';
    const id = 'dsh-side-chats';
    const css = `
      .dsh-sc-button,.dsh-sc-card button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 10px;cursor:pointer}
      .dsh-sc-card{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;display:grid;gap:8px;width:min(340px,75vw);box-shadow:0 8px 26px #0002}
      .dsh-sc-card textarea{box-sizing:border-box;width:100%;min-height:70px;resize:vertical;background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px;color:inherit;font:inherit}
      .dsh-sc-actions{display:flex;justify-content:flex-end;gap:8px}
      .dsh-sc-quote{color:var(--dsw-alias-label-secondary);margin:0;white-space:pre-wrap;max-height:80px;overflow:auto}
      .dsh-sc-error{color:var(--dsw-alias-state-error-primary)}
    `;

    function getSourceNodeKey() {
      const node = window.getSelection()?.anchorNode;
      const element = node?.nodeType === 1 ? node : node?.parentElement;
      return element?.closest('[data-chat-node-key]')?.getAttribute('data-chat-node-key');
    }

    const packageId = '@dsh-workbench/dsh-side-chats';
    const sessionIdCodec = {
      mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      jsonSchema: { type: 'string', minLength: 1, maxLength: 256 },
      create: () => ({ parse(value) {
        if (typeof value !== 'string' || !value || value.length > 256) throw new Error('Invalid chat identity.');
        return value;
      } }),
    };
    const linkCodec = {
      mode: 'strict', typeSymbol: packageId + '#Link',
      jsonSchema: { type: 'object', required: ['sessionId', 'sourceKey', 'boundary'], additionalProperties: false,
        properties: {
          sessionId: sessionIdCodec.jsonSchema,
          sourceKey: { type: 'string', minLength: 0, maxLength: 512 },
          boundary: { type: 'integer', minimum: 0 },
      routed: { type: 'boolean' },
        } },
      create: () => ({ parse(value) { return value; } }),
    };
    const resultCodec = {
      mode: 'strict', typeSymbol: packageId + '#Result', jsonSchema: {},
      create: () => ({ parse(value) { return value; } }),
    };
    const contribution = {
      package: packageId,
      descriptors: ['read', 'record'].map(method => ({
        id: `${packageId}#dshSideChatLinks/${method}`, namespace: 'dshSideChatLinks', method,
        service: 'dshSideChatLinks', invocation: { kind: 'direct' },
        parameters: [
          { name: 'childId', wire: 'childId', source: 'json', codec: sessionIdCodec, strictCodec: sessionIdCodec },
          ...(method === 'record' ? [{ name: 'link', wire: 'link', source: 'json', codec: linkCodec, strictCodec: linkCodec }] : []),
        ],
        result: resultCodec,
      })),
    };

    function SelectionAction({ branch, dismiss, readText, useChat, useAccess }) {
      const [form, setForm] = useState(null);
      const [question, setQuestion] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const attempt = useRef({});
      const sourceKey = form?.sourceKey ?? getSourceNodeKey();
      const node = useChat(snapshot => snapshot?.nodes?.get(sourceKey));
      const boundary = node?.data?.finalNode?.seq ?? (node?.kind === 'user' ? node.anchorSeq : undefined);
      const canFork = useAccess('session/fork');
      const canPrompt = useAccess('session/prompt');
      if (!canFork || !canPrompt) return null;

      async function submit(event) {
        event.preventDefault();
        if (attempt.current.running || !question.trim()) return;
        attempt.current.running = true;
        setBusy(true);
        setError(null);
        try {
          await branch(form, question.trim(), attempt.current);
          dismiss();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          attempt.current.running = false;
          setBusy(false);
        }
      }

      if (!form) return h('button', {
        type: 'button', className: 'dsh-sc-button',
        onPointerDown: event => event.preventDefault(),
        disabled: !Number.isSafeInteger(boundary),
        onClick: () => {
          const text = readText();
          if (text?.trim() && Number.isSafeInteger(boundary)) setForm({ text, boundary, sourceKey });
        },
      }, 'Start side chat');

      return h('form', { className: 'dsh-sc-card', onSubmit: submit },
        h('strong', null, 'Start side chat'),
        h('blockquote', { className: 'dsh-sc-quote' }, form.text),
        h('textarea', { autoFocus: true, value: question, disabled: busy || attempt.current.childId !== undefined,
          'aria-label': 'Question for the side chat', placeholder: 'Ask about this selection…', onChange: event => setQuestion(event.target.value) }),
        error && h('div', { role: 'alert', className: 'dsh-sc-error' }, error),
        h('div', { className: 'dsh-sc-actions' },
          h('button', { type: 'button', onClick: dismiss, disabled: busy }, 'Cancel'),
          h('button', { type: 'submit', disabled: busy || !question.trim() }, busy ? 'Opening…' : 'Open side chat')));
    }

    function ParentAction({ sessionId, openParent, findAnchor, readParent }) {
      const [parent, setParent] = useState(null);
      useEffect(() => findAnchor(sessionId), [sessionId, findAnchor]);
      useEffect(() => {
        let active = true;
        setParent(null);
        void readParent(sessionId).then(result => {
          if (active && result.ok && result.value) setParent(result.value);
        }, () => {});
        return () => { active = false; };
      }, [sessionId, readParent]);
      if (!parent) return null;
      return h('button', { type: 'button', className: 'dsh-sc-button', onClick: () => openParent(parent) }, 'Open parent chat');
    }

    return {
      inject: ['slots', 'sessions', 'uiConversation', 'uiWorkspace', 'conversation', 'workspaces', 'remote'],
      async apply(ctx) {
        await ctx.remote.$mount(contribution);
        const readParent = sessionId => ctx.get('remote.dshSideChatLinks').read(sessionId);
        const style = document.createElement('style');
        style.dataset.plugin = '@dsh-workbench/dsh-side-chats';
        style.textContent = css;
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove());
        let pendingAnchor;

        const openParent = parent => {
          pendingAnchor = parent;
          ctx.uiWorkspace.openSession(parent.sessionId);
        };
        const findAnchor = sessionId => {
          if (pendingAnchor?.sessionId !== sessionId) return undefined;
          const { sourceKey, boundary } = pendingAnchor;
          pendingAnchor = undefined;
          const reveal = () => {
            const selector = `[data-chat-node-key="${CSS.escape(sourceKey)}"]`;
            const row = document.querySelector(selector);
            row?.scrollIntoView({ block: 'center' });
            return Boolean(row);
          };
          if (!sourceKey) {
            if (Number.isSafeInteger(boundary)) {
              void ctx.sessions.binding(sessionId)?.session.loadThrough(boundary).catch(() => undefined);
            }
            return undefined;
          }
          if (reveal()) return undefined;
          const observer = new MutationObserver(() => { if (reveal()) observer.disconnect(); });
          observer.observe(document.body, { childList: true, subtree: true });
          const timer = window.setTimeout(() => observer.disconnect(), 5000);
          if (Number.isSafeInteger(boundary)) {
            const session = ctx.sessions.binding(sessionId)?.session;
            void session?.loadThrough(boundary).then(() => {
              if (reveal()) observer.disconnect();
            }, () => undefined);
          }
          return () => { window.clearTimeout(timer); observer.disconnect(); };
        };

        const openFocused = async ({ sourceId, destinationId, workspaceId, draft, title, parentBoundary, beforeCommit, beforeOpen, send = false, attempt = {} }) => {
          const { items, archivedSessionIds } = ctx.workspaces.list.getSnapshot();
          const source = ctx.sessions.list.getSnapshot().byId[sourceId];
          const workspace = workspaceId ? items.find(item => item.workspaceId === workspaceId)
            : items.find(item => item.sessionIds.includes(sourceId));
          if (workspaceId && !workspace) throw new Error('The destination workspace is unavailable.');
          if (destinationId && (archivedSessionIds.includes(destinationId) || !workspace?.sessionIds.includes(destinationId))) {
            throw new Error('The matching chat is no longer available in the chosen workspace.');
          }
          const location = workspace ? { workspaceId: workspace.workspaceId } : source?.cwd ? { cwd: source.cwd } : {};
          if (!attempt.childId) {
            try {
              const preset = ctx.sessions.binding(sourceId)?.session.projections.faceOf('agentPreset').getSnapshot();
              attempt.childId = destinationId ?? await ctx.sessions.create({
                ...location, ...(typeof preset === 'string' ? { agentPreset: preset } : {}),
              });
            } catch (error) {
              const childId = error.rpcError?.details?.sessionId;
              if (error.rpcError?.code === 'session/workspace-attach-failed' && childId) {
                attempt.childId = childId;
                attempt.workspaceAttachFailed = true;
              }
              throw error;
            }
          }
          const childId = attempt.childId;
          if (attempt.workspaceAttachFailed && !workspace?.sessionIds.includes(childId)) {
            throw new Error(`DSH created ${childId} but could not attach it. Move that chat into the destination workspace before retrying.`);
          }
          await ctx.sessions.using(childId, { source: 'controllerOperation' }, async reference => {
            if (!destinationId && Number.isSafeInteger(parentBoundary) && !attempt.linked) {
              const result = await ctx.get('remote.dshSideChatLinks').record(childId, {
                sessionId: sourceId, boundary: parentBoundary, sourceKey: '', routed: true,
              });
              if (!result?.ok) throw new Error(result?.error?.message ?? 'Could not save the parent chat link.');
              attempt.linked = true;
            }
            if (!destinationId && title) await reference.binding.session.rename(title).catch(() => undefined);
            beforeCommit?.();
            if (send) {
              if (!attempt.accepted) {
                attempt.requestId ??= crypto.randomUUID();
                const result = await reference.binding.session.prompt([
                  { type: 'text', text: draft },
                ], 'queue', undefined, attempt.requestId);
                if (!result?.ok) throw new Error(result?.error?.message ?? 'The destination did not accept the prompt.');
                attempt.accepted = true;
              }
            } else if (!attempt.draftPrepared) {
              const result = ctx.conversation.input.requestDraftInitialization(reference.binding, {
                prompt: draft, whenDraftExists: 'append',
              });
              if (result !== 'applied') throw new Error('The destination composer is busy. Open the chat and try again.');
              attempt.draftPrepared = true;
            }
            beforeOpen?.();
            ctx.uiWorkspace.openSession(childId);
          });
          return childId;
        };
        ctx.effect(() => ctx.reflect.provide('dshSideChats', { openFocused }));

        ctx.slots.inject(interactionSlot, () => ctx.slots.register({
          name: interactionSlot, id, key: id,
          inject: sessionId => ({
            branch: async (selection, question, attempt) => {
              if (!attempt.childId) {
                try {
                  attempt.childId = await ctx.sessions.fork({ sessionId, atSeq: selection.boundary });
                } catch (error) {
                  const recovered = error.rpcError?.code === 'session/workspace-attach-failed' ? error.rpcError.details?.sessionId : undefined;
                  if (!recovered) throw error;
                  attempt.childId = recovered;
                  attempt.workspaceAttachFailed = true;
                }
                attempt.requestId = crypto.randomUUID();
              }
              if (attempt.workspaceAttachFailed) {
                const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId));
                if (workspace && !workspace.sessionIds.includes(attempt.childId)) {
                  throw new Error(`DSH created ${attempt.childId} but could not attach it. Move that chat into the parent workspace before retrying.`);
                }
              }
              if (!attempt.linked) {
                const linked = await ctx.get('remote.dshSideChatLinks').record(attempt.childId, {
                  sessionId, sourceKey: selection.sourceKey, boundary: selection.boundary,
                });
                if (!linked?.ok) throw new Error(linked?.error?.message ?? 'The parent link could not be saved. Retry to use the same side chat.');
                attempt.linked = true;
              }
              const childId = attempt.childId;
              await ctx.sessions.using(childId, { source: 'controllerOperation' }, async reference => {
                if (!attempt.accepted) {
                  const prompt = [
                    question,
                    'Selection from the parent chat, supplied as reference:',
                    JSON.stringify(selection.text),
                    `Parent session ${sessionId}, event ${selection.boundary}. Use the inherited prefix as reference for this question. Earlier requests, task goals, and approvals apply only to their original actions.`,
                  ].join('\n\n');
                  const result = await reference.binding.session.prompt([{ type: 'text', text: prompt }], 'queue', undefined, attempt.requestId);
                  if (!result?.ok) throw new Error(result?.error?.message ?? 'The side chat did not accept the question.');
                  attempt.accepted = true;
                  await reference.binding.session.rename(`Side chat · ${question.replace(/\s+/g, ' ').slice(0, 75)}`).catch(() => undefined);
                }
                ctx.uiWorkspace.openSession(childId);
              });
            },
          }),
        }, SelectionAction));
        ctx.slots.inject(headerSlot, () => ctx.slots.register({
          name: headerSlot, id, order: 20,
          inject: sessionId => ({ sessionId, openParent, findAnchor, readParent }),
        }, ParentAction));
        const unregister = ctx.uiConversation.interactions.register({
          id,
          onInteraction({ hasSelection, readText, trigger, open, preventDefault }) {
            if (!hasSelection || !readText()?.trim() || !getSourceNodeKey()) return;
            open();
            if (trigger === 'contextmenu') preventDefault();
          },
        });
        ctx.effect(() => unregister);
      },
    };
  },
});
