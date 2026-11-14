window.__ModuleLoader__.load({
  id: '@dsh-workbench/dsh-artifact-library',
  factory(require) {
    const { createElement: h, useEffect, useMemo, useRef, useState, useSyncExternalStore } = require('react');
    const panelId = 'workbench-artifacts';
    const batchSize = 8;
    const pathOf = (cwd, path) => /^(?:[/\\]|[a-z]:)/i.test(path) ? path : cwd ? cwd.replace(/[/\\]+$/, '') + '/' + path : path;

    function ArtifactPanel({ sessions, remote, navigation, conversation, openPreview }) {
      const snapshot = useSyncExternalStore(listener => sessions.list.subscribe(listener), () => sessions.list.getSnapshot());
      const [source, setSource] = useState('');
      const [destination, setDestination] = useState('');
      const [query, setQuery] = useState('');
      const [items, setItems] = useState([]);
      const [errors, setErrors] = useState([]);
      const [busy, setBusy] = useState(false);
      const [more, setMore] = useState(false);
      const [status, setStatus] = useState('');
      const cursor = useRef(null);
      const request = useRef(null);
      const generation = useRef(0);
      const chats = useMemo(() => snapshot.ids.map(id => [id, snapshot.byId[id]])
        .filter(([, chat]) => chat && !chat.blank && chat.origin !== 'subagent')
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt), [snapshot]);
      const chatIds = JSON.stringify(chats.map(([id]) => id).sort());

      async function load(reset = false) {
        if (!reset && request.current) return;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        const current = ++generation.current;
        if (reset) {
          cursor.current = chats.filter(([id]) => !source || source === id).map(([id, chat]) => ({ id, chat }));
          setItems([]);
          setErrors([]);
          setStatus('');
        }
        const queue = cursor.current;
        if (!queue) return;
        setBusy(true);
        const results = await Promise.allSettled(queue.splice(0, batchSize).map(async entry => {
          const result = await remote.events({
            address: { kind: 'session', sessionId: entry.id },
            maxMessages: 80,
            ...(entry.before === undefined ? {} : { beforeSeq: entry.before, throughSeq: entry.through }),
          }, controller.signal);
          if (!result.ok) throw new Error('Could not read ' + (entry.chat.displayTitle || 'conversation'));
          const page = result.value;
          const before = page.records[0]?.event.seq;
          if (page.hasMore && Number.isSafeInteger(before) && before > 0 && before !== entry.before) {
            queue.push({ ...entry, before, through: page.cursor });
          }
          return page.records.flatMap(({ event }) => {
            if (event.type !== 'deliverables/presented' || !Array.isArray(event.data?.files)) return [];
            return event.data.files.flatMap(file => {
              if (typeof file?.path !== 'string' || !file.path.trim()) return [];
              return [{
                id: entry.id, seq: event.seq, title: entry.chat.displayTitle || 'Untitled chat',
                path: pathOf(entry.chat.cwd, file.path),
                description: typeof file.description === 'string' ? file.description : '',
                time: event.time ?? 0,
              }];
            });
          });
        }));
        if (controller.signal.aborted || current !== generation.current) return;
        request.current = null;
        setItems(prior => {
          const unique = new Map(prior.map(item => [JSON.stringify([item.id, item.path]), item]));
          for (const result of results) if (result.status === 'fulfilled') {
            for (const item of result.value) {
              const key = JSON.stringify([item.id, item.path]);
              if (!unique.has(key) || unique.get(key).seq <= item.seq) unique.set(key, item);
            }
          }
          return [...unique.values()].sort((a, b) => b.time - a.time || b.seq - a.seq);
        });
        setErrors(prior => [...prior, ...results.filter(result => result.status === 'rejected').map(result => result.reason.message)]);
        setMore(queue.length > 0);
        setBusy(false);
      }

      useEffect(() => {
        void load(true);
        return () => request.current?.abort();
      }, [source, chatIds]);

      async function reuse(item) {
        let referenceHandle;
        try {
          referenceHandle = sessions.retain(destination, { source: 'mainView' });
          await referenceHandle.ready;
          const shell = conversation.input.shell(destination);
          const path = item.path.replaceAll('\\', '/');
          if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) throw new Error('This path cannot be added as a reference.');
          const mention = '@"' + path + '"';
          const reference = { source: 'reference', ref: mention, label: path.split('/').pop(), appearance: 'file', clipboardText: mention };
          if (!shell.addFiles([reference], [])) throw new Error('The destination draft is busy. Try again after it settles.');
          navigation.openSession(destination);
        } catch (error) {
          setStatus(error.message || 'Could not prepare the destination draft.');
        } finally {
          referenceHandle?.release();
        }
      }

      function preview(item) {
        try {
          const encode = value => encodeURIComponent(value).replace(/%3A/gi, ':');
          const path = item.path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').split('/').map(encode).join('/');
          openPreview(item.id, 'dsh-resource://file/session/' + encode(item.id) + '/' + path);
        } catch (error) {
          setStatus(error.message || 'Could not open the file preview.');
        }
      }

      const term = query.trim().toLowerCase();
      const shown = items.filter(item => [item.path, item.title, item.description ?? ''].some(value => value.toLowerCase().includes(term)));
      return h('section', { className: 'dwa-library', 'aria-label': 'Artifact Library' },
        h('style', null, `
          .dwa-library{height:100%;box-sizing:border-box;overflow:auto;padding:clamp(16px,4vw,42px);color:var(--dsw-alias-label-primary);font:inherit}
          .dwa-library h1{font-size:25px;margin:0 0 18px}
          .dwa-tools,.dwa-actions{display:flex;flex-wrap:wrap;gap:8px}
          .dwa-tools{margin-bottom:18px}.dwa-tools input{flex:1;min-width:145px}.dwa-tools select{max-width:220px}
          .dwa-library input,.dwa-library select,.dwa-library button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:7px 10px}
          .dwa-library button{cursor:pointer}.dwa-library button:hover{background:var(--dsw-alias-bg-layer-2)}.dwa-library button:disabled{opacity:.55}
          .dwa-item{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0}
          .dwa-item strong,.dwa-item small{display:block;overflow-wrap:anywhere}.dwa-item small,.dwa-note{color:var(--dsw-alias-label-secondary)}
        `),
        h('h1', null, 'Artifacts'),
        h('div', { className: 'dwa-tools' },
          h('input', { type: 'search', placeholder: 'Search loaded artifacts', 'aria-label': 'Search loaded artifacts', value: query, onChange: event => setQuery(event.target.value) }),
          h('select', { value: source, 'aria-label': 'Source conversation', onChange: event => setSource(event.target.value) },
            h('option', { value: '' }, 'All conversations'),
            ...chats.map(([id, chat]) => h('option', { key: id, value: id }, chat.displayTitle || 'Untitled chat'))),
          h('select', { value: destination, 'aria-label': 'Destination draft', onChange: event => setDestination(event.target.value) },
            h('option', { value: '' }, 'Choose destination chat'),
            ...chats.map(([id, chat]) => h('option', { key: id, value: id }, chat.displayTitle || 'Untitled chat'))),
          h('button', { disabled: busy, onClick: () => void load(true) }, 'Refresh')),
        status && h('p', { role: 'status' }, status),
        errors.length > 0 && h('p', { className: 'dwa-note', role: 'status' }, errors.length + ' conversation pages could not be read. Refresh to retry.'),
        shown.length === 0 && !busy && h('p', { className: 'dwa-note' }, 'No matching artifacts in the loaded history.'),
        ...shown.map(item => h('article', { className: 'dwa-item', key: JSON.stringify([item.id, item.path]) },
          h('div', null, h('strong', { title: item.path }, item.path.split(/[/\\]/).pop()),
            h('small', null, item.title), item.description && h('small', null, item.description)),
          h('div', { className: 'dwa-actions' },
            h('button', { onClick: () => preview(item) }, 'Preview'),
            h('button', { onClick: () => navigation.openSession(item.id) }, 'Source chat'),
            h('button', { disabled: !destination, onClick: () => void reuse(item) }, 'Add to draft')))),
        busy && h('p', { role: 'status' }, 'Reading conversation history…'),
        more && h('button', { disabled: busy, onClick: () => void load() }, 'Load more'));
    }

    return {
      inject: ['slots', 'sessions', 'remote.session', 'uiWorkspace', 'conversation', 'sidebarRight'],
      apply(ctx) {
        const navigation = ctx.get('uiWorkspace');
        const sidebar = ctx.get('sidebarRight');
        let cancelPreview;
        function openPreview(id, address) {
          cancelPreview?.();
          let timer;
          const stop = sidebar.mounted.subscribe(openWhenMounted);
          cancelPreview = () => {
            clearTimeout(timer);
            stop();
            cancelPreview = null;
          };
          function openWhenMounted() {
            if (sidebar.mounted.getSnapshot() !== id) return;
            cancelPreview?.();
            sidebar.openResourceIn(id, address);
          }
          timer = setTimeout(() => cancelPreview?.(), 5000);
          try {
            navigation.openSession(id);
            openWhenMounted();
          } catch (error) {
            cancelPreview?.();
            throw error;
          }
        }
        ctx.effect(() => () => cancelPreview?.());
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: panelId,
          inject: () => ({
            sessions: ctx.get('sessions'), remote: ctx.get('remote.session'),
            navigation, openPreview, conversation: ctx.get('conversation'),
          }),
        }, ArtifactPanel));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: panelId, order: 65, label: 'Artifacts',
        }, ({ size }) => h('svg', { width: size || 20, height: size || 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
          h('path', { d: 'M3 7h18v13H3z M2 3h20v4H2z M9 11h6' }))));
      },
    };
  },
});
