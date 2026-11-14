window.__ModuleLoader__.load({
  id: '@dsh-workbench/dsh-task-organization',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react');
    const packageId = '@dsh-workbench/dsh-task-organization';
    const dock = 'conversation.input.dock';
    const stringSchema = (typeSymbol, maxLength) => ({
      mode: 'strict', typeSymbol,
      jsonSchema: { type: 'string', minLength: 1, maxLength },
      create: () => ({ parse(value) {
        if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) throw new Error('Invalid text.');
        return value;
      } }),
    });
    const sessionIdCodec = stringSchema('@deepseek-ai/dsh-session/types#SessionId', 256);
    const draftCodec = stringSchema(`${packageId}#Draft`, 6000);
    const candidateCodec = {
      mode: 'strict', typeSymbol: `${packageId}#CandidateTitles`,
      jsonSchema: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 160 } },
      create: () => ({ parse(value) {
        if (!Array.isArray(value) || value.length > 8 || value.some(title => typeof title !== 'string' || title.length < 1 || title.length > 160)) {
          throw new Error('Invalid candidate titles.');
        }
        return value;
      } }),
    };
    const contribution = { package: packageId, descriptors: [{
      id: `${packageId}#dshTaskOrganization/suggest`, namespace: 'dshTaskOrganization', method: 'suggest',
      service: 'dshTaskOrganization', invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: sessionIdCodec, strictCodec: sessionIdCodec },
        { name: 'draft', wire: 'draft', source: 'json', codec: draftCodec, strictCodec: draftCodec },
        { name: 'candidates', wire: 'candidates', source: 'json', codec: candidateCodec, strictCodec: candidateCodec },
      ],
      cancellation: { parameter: 'signal' },
      result: { mode: 'strict', typeSymbol: `${packageId}#Suggestion`, jsonSchema: {}, create: () => ({ parse: value => value }) },
    }] };

    function judgeLabel(result) {
      const names = { rule: 'Rule', 'clef-flash': 'Clef Flash', jev: 'Jev' };
      const name = names[result?.judge] ?? 'Judge';
      const preferred = names[result?.preferredJudge];
      const backend = preferred ? name + ' (' + preferred + ' unavailable)' : name;
      return result?.track ? backend + ' · ' + result.track : backend;
    }

    function Organizer({ preferenceKey, input, inputActions, listCandidates, listWorkspaces, suggest, openFocused, intercept }) {
      const [automatic, setAutomatic] = useState(() => {
        try { return localStorage.getItem(preferenceKey) === 'on'; } catch { return false; }
      });
      function setRouting(enabled) {
        setAutomatic(enabled);
        try { localStorage.setItem(preferenceKey, enabled ? 'on' : 'off'); } catch { /* storage is optional */ }
      }
      const [lastDecision, setLastDecision] = useState(null);
      const bypass = useRef(false);
      const latestHandler = useRef(null);
      useEffect(() => automatic ? intercept((...args) => latestHandler.current?.(...args)) : undefined, [automatic, intercept]);
      const [reply, setReply] = useState(null);
      const [working, setWorking] = useState(false);
      const [error, setError] = useState(null);
      const pending = useRef(null);
      const preparing = useRef(false);
      const attempt = useRef({});
      const [title, setTitle] = useState('');
      const [workspaceId, setWorkspaceId] = useState('');
      const latestInput = useRef(input);
      latestInput.current = input;
      useEffect(() => () => pending.current?.abort(), []);
      const draft = input?.draft?.trim();
      if (!input) return null;


      const current = reply?.revision === input.draftRev ? reply : null;
      const canCheck = Boolean(draft) && draft.length <= 6000 && input.attachmentIds.length === 0 && !input.occurrences?.length && !draft.startsWith('/') && input.phase === 'plain';

      async function check(submitOriginal) {
        if (!canCheck) return submitOriginal?.();
        if (pending.current) return;
        setWorking(true);
        setError(null);
        setReply(null);
        if (attempt.current.revision !== input.draftRev) attempt.current = { revision: input.draftRev };
        const controller = new AbortController();
        pending.current = controller;
        try {
          const candidates = listCandidates(draft);
          const result = submitOriginal && attempt.current.decision
            ? { ok: true, value: attempt.current.decision }
            : await suggest(draft, candidates.map(candidate => candidate.title), controller.signal);
          if (controller.signal.aborted || latestInput.current.draftRev !== input.draftRev) return;
          if (!result.ok) throw new Error(result.error.message || 'Task suggestion failed.');
          setLastDecision(result.value);
          if (result.value.action === 'unavailable') {
            if (submitOriginal && !attempt.current.childId) return submitOriginal();
            throw new Error(result.value.reason || 'Judge is unavailable.');
          }
          if (submitOriginal && result.value.action === 'stay' && !attempt.current.childId) return submitOriginal();
          if (submitOriginal && ['new', 'existing'].includes(result.value.action)) {
            const target = candidates[result.value.candidate];
            attempt.current.decision = result.value;
            const route = attempt.current.route ??= {
              destinationId: target?.id, parentBoundary: result.value.parentBoundary, draft: target ? draft : result.value.sourceText,
              title: result.value.title ?? draft.split('\n')[0].slice(0, 72),
            };
            await openFocused({
              ...route, send: true, attempt: attempt.current,
              beforeCommit() {
                const latest = latestInput.current;
                if (controller.signal.aborted || latest.draftRev !== input.draftRev || latest.phase !== 'plain' || latest.attachmentIds.length || latest.occurrences?.length) throw new Error('The draft changed before routing.');
              },
              beforeOpen() {
                if (latestInput.current.draftRev === input.draftRev) { inputActions.setDraft(''); inputActions.persistDraft(); }
              },
            });
            return;
          }
          setTitle(result.value.title ?? draft.split('\n')[0].slice(0, 72));
          setWorkspaceId('');
          setReply({ ...result.value, revision: input.draftRev, target: candidates[result.value.candidate] });
        } catch (cause) {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          pending.current = null;
          if (!controller.signal.aborted) setWorking(false);
        }
      }

      latestHandler.current = (original, mode) => {
        if (bypass.current || !canCheck || (mode != null && mode !== 'queue')) return original();
        return check(original);
      };

      async function prepare(send = false) {
        if (working || preparing.current || !canCheck || !current) return;
        preparing.current = true;
        attempt.current.send ??= send;
        setWorking(true);
        setError(null);
        try {
          await openFocused({
            destinationId: current.target?.id,
            parentBoundary: current.parentBoundary,
            workspaceId: workspaceId || undefined,
            draft: current.target ? draft : current.sourceText,
            title: title.trim(),
            send: attempt.current.send,
            attempt: attempt.current,
            beforeCommit() {
              const latest = latestInput.current;
              if (latest.draftRev !== current.revision || latest.phase !== 'plain' || latest.attachmentIds.length || latest.occurrences?.length) {
                throw new Error('The source draft changed. Review it and ask the Judge again.');
              }
            },
            beforeOpen() {
              if (latestInput.current.draftRev !== current.revision || latestInput.current.phase !== 'plain') return;
              inputActions.setDraft('');
              inputActions.persistDraft();
            },
          });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          preparing.current = false;
          setWorking(false);
        }
      }

      const label = current?.action === 'stay' ? 'Keep this request in the current chat.'
        : current?.action === 'new' ? 'This looks like a separate task.'
        : current?.action === 'existing' ? `This looks like a continuation of “${current.target.title}”.`
        : current?.action === 'split' ? 'This draft may mix tasks. Split or clarify it before sending.' : '';
      const unavailable = input.attachmentIds.length > 0 ? 'Available for text drafts.' : 'Available for drafts up to 6,000 characters.';
      const newTask = current?.action === 'new' || current?.action === 'split';
      const workspaces = newTask ? listWorkspaces() : [];
      return h('div', { className: 'dsh-to-row' },
        h('button', { type: 'button', onClick: () => void check(), disabled: working || !canCheck, title: canCheck ? undefined : unavailable },
          working ? 'Working…' : 'Ask Judge'),
        h('label', null, h('input', { type: 'checkbox', checked: automatic, onChange: event => setRouting(event.target.checked) }), ' Route with Judge on Send'),
        (error || current?.action === 'split') && !attempt.current.childId && h('button', { type: 'button', disabled: working || !draft, onClick: () => {
          bypass.current = true;
          try { inputActions.submit(); } finally { bypass.current = false; }
        } }, 'Send here'),
        lastDecision && h('span', { role: 'status' }, judgeLabel(lastDecision) + ' · ' +
          (label || ({ stay: 'kept here', new: 'separate chat', existing: 'matching chat',
            split: 'needs review', unavailable: 'unavailable' })[lastDecision.action])),
        newTask && h('label', null, 'Title ', h('input', { value: title, maxLength: 72, disabled: working || Boolean(attempt.current.childId),
          onChange: event => setTitle(event.target.value) })),
        newTask && workspaces.length > 0 && h('label', null, 'Workspace ', h('select', { value: workspaceId,
          disabled: working || Boolean(attempt.current.childId), onChange: event => setWorkspaceId(event.target.value) },
          h('option', { value: '' }, 'Current workspace'),
          workspaces.map(row => h('option', { key: row.workspaceId, value: row.workspaceId }, row.title || row.path)))),
        newTask && current.sources?.length > 0 && h('span', null, `${current.sources.length} related source ranges`),
        ['new', 'existing', 'split'].includes(current?.action) && attempt.current.send !== true && h('button', {
          type: 'button', onClick: () => prepare(false), disabled: working || !canCheck || (newTask && !title.trim()),
        }, current.action !== 'existing' ? 'Prepare new chat' : 'Prepare in matching chat'),
        ['new', 'existing', 'split'].includes(current?.action) && attempt.current.send !== false && h('button', {
          type: 'button', onClick: () => prepare(true), disabled: working || !canCheck || (newTask && !title.trim()),
        }, current.action !== 'existing' ? 'Send to new chat' : 'Send to matching chat'),
        error && h('span', { role: 'alert', className: 'dsh-to-error' }, error));
    }

    function candidateTitles(ctx, sessionId, draft) {
      const words = new Set((draft.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));
      const { items, archivedSessionIds } = ctx.workspaces.list.getSnapshot();
      const workspace = items.find(item => item.sessionIds.includes(sessionId));
      const byId = ctx.sessions.list.getSnapshot().byId;
      if (!workspace) return [];
      return workspace.sessionIds.map(id => byId[id])
        .filter(row => row && row.id !== sessionId && !row.origin && !row.blank && row.title && !archivedSessionIds.includes(row.id))
        .map(row => ({ id: row.id, title: row.title.slice(0, 160), updatedAt: row.updatedAt,
          score: (row.title.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => words.has(word)).length }))
        .filter(row => row.score > 0)
        .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
        .slice(0, 8);
    }

    return {
      inject: ['slots', 'remote', 'sessions', 'workspaces', 'dshSideChats', 'conversation'],
      async apply(ctx) {
        await ctx.remote.$mount(contribution);
        const style = document.createElement('style');
        style.dataset.plugin = packageId;
        style.textContent = '.dsh-to-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:5px auto;font-size:12px;color:var(--dsw-alias-label-secondary)}.dsh-to-row button{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 8px}.dsh-to-row input,.dsh-to-row select{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 6px}.dsh-to-row button:disabled{opacity:.55}.dsh-to-error{color:var(--dsw-alias-state-error-primary)}';
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove());
        ctx.slots.inject(dock, () => ctx.slots.register({
          name: dock, id: 'dsh-task-organization', order: 34,
          inject: sessionId => ({
            preferenceKey: packageId + ':route:' + sessionId,
            intercept: handler => {
              const shell = ctx.get('conversation').input.shell(sessionId);
              const original = shell.submit;
              const wrapped = function (mode, source) {
                return handler(() => original.call(this, mode, source), mode);
              };
              shell.submit = wrapped;
              return () => { if (shell.submit === wrapped) shell.submit = original; };
            },
            listCandidates: draft => candidateTitles(ctx, sessionId, draft),
            listWorkspaces: () => ctx.workspaces.list.getSnapshot().items,
            suggest: (draft, candidates, signal) => ctx.get('remote.dshTaskOrganization').suggest(sessionId, draft, candidates, signal),
            openFocused: options => ctx.get('dshSideChats').openFocused({ sourceId: sessionId, ...options }),
          }),
        }, Organizer));
      },
    };
  },
});
