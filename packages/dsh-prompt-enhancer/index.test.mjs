import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';

const stubs = {
  '@deepseek-ai/dsh-typert-protocol': `export class TypertRemoteService { constructor(ctx, name) { this.ctx = ctx; globalThis.__promptEnhancerService = this; this.name = name; } } export class RemoteError extends Error { constructor(code, message) { super(message); this.code = code; } } export function Remote() {}`,
  '@deepseek-ai/schemastery': `const field = { default() { return this }, description() { return this } }; export default { object: value => value, string: () => field };`,
  '@deepseek-ai/dsh-typert-protocol/remote-info': `export function createTypertRemoteInfo(info) { return { descriptors: Object.entries(info.methods).map(([method, value]) => ({ method, ...value })) }; }`,
  'zod': `const schema = { min() { return this }, optional() { return this } }; export const z = { string: () => schema };`,
};
registerHooks({ resolve(specifier, context, next) {
  if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  return next(specifier, context);
} });
const { enhancePrompt, DEFAULT_ENHANCE_MODEL, apply } = await import('./index.mjs');
const { REMOTE } = await import('./remote.mjs');

test('an unavailable configured model is not replaced by a different model', async () => {
  const calls = [];
  const llm = {
    resolveModelInfo: async (provider, model) => {
      calls.push(`${provider}/${model}`);
      if (model !== 'deepseek/deepseek-v3.2') throw new Error('not found');
    },
    prepareCall: async selection => ({ config: selection, async *stream() {
      yield { type: 'text-delta', text: 'wrong model' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }),
  };
  await assert.rejects(enhancePrompt(llm, 'text', DEFAULT_ENHANCE_MODEL), error => error.message.includes('unavailable') && error.message.includes(DEFAULT_ENHANCE_MODEL));
  assert.deepEqual(calls, [DEFAULT_ENHANCE_MODEL, 'openrouter/deepseek/deepseek-v4.1-flash']);
});

test('host reports an unavailable configured model without attempting another route', async () => {
  const calls = [];
  const llm = { resolveModelInfo: async (provider, model) => { calls.push(`${provider}/${model}`); throw new Error('not found'); },
    prepareCall: async () => { throw new Error('unexpected model call'); } };
  const ctx = { invocation: { peer: { principal: { kind: 'owner' } } }, get: key => key === 'llm' ? llm : { register() {} }, effect: fn => fn() };
  apply(ctx, { enhanceModel: DEFAULT_ENHANCE_MODEL });
  await assert.rejects(globalThis.__promptEnhancerService.enhance('s-1', 'draft'), /check the selected provider and model settings/i);
  assert.deepEqual(calls, [DEFAULT_ENHANCE_MODEL, 'openrouter/deepseek/deepseek-v4.1-flash']);
  delete globalThis.__promptEnhancerService;
});

test('proven catalog spellings resolve in either direction and report the actual route', async () => {
  const pairs = [
    ['openrouter/deepseek/deepseek-v4.1-flash-1017', 'openrouter/deepseek/deepseek-v4.1-flash'],
    ['openrouter/moonshotai/kimi-k3.1-pro', 'openrouter/moonshotai/kimi-k3'],
    ['openrouter/openai/gpt-6.1-sol', 'openrouter/openai/gpt-6.1-terra'],
  ];
  for (const pair of pairs) for (const [route, alias] of [pair, [...pair].reverse()]) {
    const calls = [];
    let prepared;
    const llm = {
      resolveModelInfo: async (provider, model) => {
        const candidate = `${provider}/${model}`; calls.push(candidate);
        if (candidate !== alias) throw new Error('not found');
        return {};
      },
      prepareCall: async selection => { prepared = `${selection.provider}/${selection.model}`;
        return { config: selection, async *stream() {
          yield { type: 'text-delta', text: 'improved' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        } };
      },
    };
    const ctx = { invocation: { peer: { principal: { kind: 'owner' } } }, get: key => key === 'llm' ? llm : { register() {} }, effect: fn => fn() };
    apply(ctx, { enhanceModel: route });
    assert.deepEqual(await globalThis.__promptEnhancerService.enhance('s-1', 'draft'), { text: 'improved', route: alias });
    assert.deepEqual(calls, [route, alias]);
    assert.equal(prepared, alias);
    delete globalThis.__promptEnhancerService;
  }
});

test('valid enhancement streams the configured route and preserves the original draft', async () => {
  let resolved, prepared, options;
  const signal = new AbortController().signal;
  const llm = {
    resolveModelInfo: async (...args) => { resolved = args; return {}; },
    prepareCall: async (selection, passedSignal) => {
      prepared = selection; assert.equal(passedSignal, signal);
      return { config: { ...selection, maxTokens: 4096 }, async *stream(value) {
        options = value; yield { type: 'text-delta', text: 'Better ' }; yield { type: 'text-delta', text: 'prompt' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    },
  };
  assert.equal(DEFAULT_ENHANCE_MODEL, 'openrouter/deepseek/deepseek-v4.1-flash-1017');
  assert.deepEqual(await enhancePrompt(llm, '  original  ', DEFAULT_ENHANCE_MODEL, signal), { text: 'Better prompt', route: DEFAULT_ENHANCE_MODEL });
  assert.deepEqual(resolved, ['openrouter', 'deepseek/deepseek-v4.1-flash-1017']);
  assert.deepEqual(prepared, { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' });
  assert.deepEqual(options.messages, [{ role: 'user', content: [{ type: 'text', text: '  original  ' }] }]);
  assert.equal(options.signal, signal);
  assert.match(options.system, /untrusted data/);
});

test('empty draft and banned routes are refused before a model request', async () => {
  let calls = 0;
  const llm = { resolveModelInfo: async () => { calls++; }, prepareCall: async () => { calls++; } };
  await assert.rejects(enhancePrompt(llm, '  ', DEFAULT_ENHANCE_MODEL), /prompt/i);
  for (const route of ['anthropic/model', 'openrouter/astra-preview/model', 'openrouter/ANTHROPIC/model', 'openrouter/other/model']) {
    await assert.rejects(enhancePrompt(llm, 'text', route), error => /unknown enhancement model route/i.test(error.message) && error.message.includes(route));
  }
  assert.equal(calls, 0);
});

test('stream cancellation does not return partial text', async () => {
  const controller = new AbortController();
  const llm = { resolveModelInfo: async () => ({}), prepareCall: async config => ({ config, async *stream() {
    yield { type: 'text-delta', text: 'partial' }; controller.abort(); yield { type: 'finish', reason: { kind: 'stop' } };
  } }) };
  await assert.rejects(enhancePrompt(llm, 'text', DEFAULT_ENHANCE_MODEL, controller.signal), { name: 'AbortError' });
});

test('remote resolves the owner UI’s current agent scope', () => {
  const descriptor = REMOTE.descriptors[0], agent = descriptor.parameters[0];
  assert.equal(descriptor.method, 'promptEnhancer/enhance');
  assert.equal(agent.source, 'lookup'); assert.equal(agent.wire, 'agentId');
  assert.equal(agent.codec.typeSymbol, '@deepseek-ai/dsh-session/types#SessionId');
  assert.equal(agent.strictCodec.typeSymbol, '@deepseek-ai/dsh-session/types#SessionId');
  assert.equal(descriptor.cancellation.parameter, 'signal');
  assert.equal(descriptor.parameters[2].name, 'model');
  assert.equal(descriptor.parameters[2].optional, true);
  assert.equal(descriptor.result.typeSymbol, '@dsh-workbench/dsh-prompt-enhancer#EnhanceResult');
  assert.deepEqual(descriptor.result.jsonSchema.required, ['text', 'route']);
});

test('host enforces the model allowlist and configured fallback without index or log services', async () => {
  let registered, config;
  const llm = { resolveModelInfo: async () => ({}), prepareCall: async selection => {
    config = selection; return { config: selection, async *stream() { yield { type: 'text-delta', text: 'rewritten' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  } };
  const services = { llm, typert: { register: value => { registered = value; } } };
  const ctx = { invocation: { peer: { principal: { kind: 'owner' } } }, get: key => services[key], effect: fn => fn() };
  apply(ctx, { enhanceModel: 'openrouter/google/gemini-3.6-flash' });
  const service = globalThis.__promptEnhancerService;
  assert.ok(registered); assert.equal(service.name, 'promptEnhancer');
  assert.deepEqual(await service.enhance({ session: { id: 's-1' } }, 'draft'), { text: 'rewritten', route: 'openrouter/google/gemini-3.6-flash' });
  assert.deepEqual(config, { provider: 'openrouter', model: 'google/gemini-3.6-flash' });
  for (const model of ['openrouter/deepseek/deepseek-v4.1-flash-1017', 'openrouter/google/gemini-3.6-flash', 'openrouter/qwen/qwen3.8-2.4t-a95b', 'openrouter/moonshotai/kimi-k3.1-pro', 'openrouter/z-ai/glm-5.2']) {
    assert.deepEqual(await service.enhance({ session: { id: 's-1' } }, 'draft', model), { text: 'rewritten', route: model });
    assert.equal(`${config.provider}/${config.model}`, model);
  }
  for (const model of ['openrouter/other/model', 'openrouter/anthropic/model', 'openrouter/astra/model']) {
    await assert.rejects(service.enhance({ session: { id: 's-1' } }, 'draft', model), error => /unknown enhancement model route/i.test(error.message) && error.message.includes(model));
  }
  service.enhanceModel = 'openrouter/other/model';
  await assert.rejects(service.enhance({ session: { id: 's-1' } }, 'draft'), error => /unknown enhancement model route/i.test(error.message) && error.message.includes(service.enhanceModel));
  await assert.rejects(service.enhance({ session: { id: 's-1' } }, 'draft', service.enhanceModel), /failed/i);
  service.enhanceModel = 'openrouter/anthropic/model';
  await assert.rejects(service.enhance({ session: { id: 's-1' } }, 'draft'), /failed/i);
  await assert.rejects(service.enhance({}, 'draft'), /session/i);
  ctx.invocation.peer.principal.kind = 'delegated';
  await assert.rejects(service.enhance({ session: { id: 's-1' } }, 'draft'), /only the owner/i);
  delete globalThis.__promptEnhancerService;
});

async function fixture(storage = new Map(), initialDraft = '  original prompt  ') {
  let module, slot, mounted, styled, cursor = 0, pendingEffects = [], inputSelector, response;
  const hooks = [], effects = [], observers = [];
  const editor = { isConnected: true, markers: new Set(), querySelector: selector => [...editor.markers].some(marker => selector.includes(`[${marker}]`)) ? {} : null };
  const parent = { isConnected: true, editors: [editor], querySelectorAll: () => parent.editors };
  const seat = { isConnected: true, contains: value => value === editor };
  const dock = { isConnected: true, parentElement: parent, closest: () => seat };
  const anchor = { isConnected: true, closest: () => dock, contains: value => value === anchor };
  class MutationObserver { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} }
  const listeners = {}, focuses = [];
  const document = { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild: style => { styled = style; } },
    addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: name => { delete listeners[name]; } };
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  vm.runInNewContext(await readFile(new URL('./client.js', import.meta.url), 'utf8'), { document, AbortController, MutationObserver, window: { localStorage, __ModuleLoader__: { load: value => { module = value; } } } });
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useRef: initial => { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i]; },
    useEffect: (fn, deps) => { const i = cursor++; const old = effects[i];
      if (!old || deps.some((value, index) => value !== old.deps[index])) pendingEffects.push(() => { old?.cleanup?.(); effects[i] = { deps, cleanup: fn() }; }); },
  };
  const requests = [], edits = [];
  response = async () => ({ ok: true, value: { text: 'improved prompt', route: 'openrouter/deepseek/deepseek-v4.1-flash-1017' } });
  const remote = { $mount: async value => { mounted = value; }, enhance: (...args) => { requests.push(args); return response(...args); } };
  await module.factory(() => react).apply({ get: () => remote, effect: fn => fn(), slots: { inject: (_name, fn) => fn(), register: (spec, component) => { slot = { spec, component }; } } });
  let input = { draft: initialDraft, draftRev: 7, attachmentIds: ['a', 'b'], occurrences: [] };
  const props = { ...slot.spec.inject('s-1'), session: { sessionId: 's-1' }, inputActions: { insertText: (text, span) => { edits.push({ text, span: { ...span } }); return true; } },
    useInput: select => { inputSelector = select; return select(input); } };
  let rootRef;
  const render = () => {
    cursor = 0; pendingEffects = []; const tree = slot.component(props);
    if (tree) {
      rootRef = tree.props.ref; rootRef.current = anchor;
      const assignRefs = node => {
        if (!node || typeof node !== 'object') return;
        if (node !== tree && node.props?.ref) node.props.ref.current = { focus: () => focuses.push(node.props['aria-label'] ?? node.children[0]) };
        node.children?.flat(Infinity).forEach(assignRefs);
      };
      assignRefs(tree);
    } else if (rootRef) rootRef.current = null;
    for (const effect of pendingEffects) effect();
    return tree;
  };
  const find = (node, label) => !node || typeof node !== 'object' ? undefined : node.props?.['aria-label'] === label ? node : node.children?.flat(Infinity).map(child => find(child, label)).find(Boolean);
  render();
  return { props, editor, parent, requests, edits, mounted, styled, anchor, render, find, listeners, storage, focuses,
    setInput: value => { input = value; inputSelector(value); }, input: () => input,
    notify: () => observers.forEach(observer => observer.callback()),
    respond: fn => { response = fn; },
    unmount: () => effects.forEach(effect => effect?.cleanup?.()),
    click: () => find(render(), 'Enhance Prompt').props.onClick({ currentTarget: anchor }) };
}

test('client mounts the dock with matching codec and stylesheet', async () => {
  const f = await fixture();
  assert.equal(f.mounted.descriptors[0].namespace, 'promptEnhancer');
  assert.equal(f.mounted.descriptors[0].parameters[0].codec.typeSymbol, '@deepseek-ai/dsh-session/types#SessionId');
  const resultCodec = f.mounted.descriptors[0].result;
  assert.equal(resultCodec.typeSymbol, REMOTE.descriptors[0].result.typeSymbol);
  assert.throws(() => resultCodec.create().parse('text'), /Invalid enhancement result/);
  assert.throws(() => resultCodec.create().parse({ text: 'text' }), /Invalid enhancement result/);
  assert.equal(f.styled.textContent, (await readFile(new URL('./style.css', import.meta.url), 'utf8')).trimEnd());
  assert.match(f.styled.textContent, /\.pe-control\{[^}]*margin-left:auto;animation:pe-enter \.18s cubic-bezier\(0\.22,1,0\.36,1\)/);
  assert.match(f.styled.textContent, /\.pe-split\{[^}]*border:1px solid var\(--dsw-alias-border-l1\);border-radius:999px;background:var\(--dsw-alias-bg-layer-1\)/);
  assert.match(f.styled.textContent, /@media\(prefers-reduced-motion:reduce\).*\.pe-control,\.pe-busy svg\{animation:none\}/);
  assert.equal(f.render().props.className, 'pe-dock');
  assert.equal(f.render().children[0].props.className, 'pe-control');
  assert.equal(f.find(f.render(), 'Enhance Prompt').props.disabled, false);
});

test('client hides empty drafts and refuses rich drafts with quiet disabled tooltips', async () => {
  for (const marker of ['data-composer-quote', 'data-composer-chip', 'data-composer-command', 'data-composer-text-ref']) {
    const f = await fixture(); f.editor.markers.add(marker); f.notify();
    const button = f.find(f.render(), 'Enhance Prompt');
    assert.equal(button.props.disabled, true); assert.match(button.props.title, /references or quotes/);
    await f.click(); assert.equal(f.requests.length, 0); assert.equal(f.edits.length, 0); assert.doesNotMatch(JSON.stringify(f.render()), /"role":"alert"/);
  }
  const empty = await fixture(new Map(), '  ');
  assert.equal(empty.render(), null);
  empty.setInput({ ...empty.input(), draft: 'new prompt' });
  assert.equal(empty.render().props.className, 'pe-dock');
  assert.equal(empty.find(empty.render(), 'Enhance Prompt').props.disabled, false);
  empty.setInput({ ...empty.input(), draft: '' });
  assert.equal(empty.render(), null);
  assert.equal(empty.requests.length, 0);
  const occurrence = await fixture(); occurrence.setInput({ ...occurrence.input(), occurrences: [{ id: 'x' }] });
  const button = occurrence.find(occurrence.render(), 'Enhance Prompt'); assert.equal(button.props.disabled, true); assert.ok(button.props.title);
  await occurrence.click(); assert.equal(occurrence.requests.length, 0);
});

test('model menu opens on demand, persists selection, and closes outside or on Escape', async () => {
  const f = await fixture();
  assert.equal(f.find(f.render(), 'Enhancement model'), undefined);
  assert.equal(f.find(f.render(), 'Choose enhancement model').props['aria-expanded'], false);
  assert.equal(f.find(f.render(), 'Choose enhancement model').props.onMouseEnter, undefined);
  const toggle = () => f.find(f.render(), 'Choose enhancement model').props.onClick();
  toggle(); let tree = f.render();
  assert.equal(f.find(tree, 'Choose enhancement model').props['aria-expanded'], true);
  assert.equal(f.focuses.at(-1), 'DeepSeek V4.1 Flash');
  const menu = f.find(tree, 'Enhancement model');
  assert.equal(menu.children.length, 7);
  assert.deepEqual(Array.from(menu.children, option => option.children[0]), ['DeepSeek V4.1 Flash', 'Gemini 3.6 Flash', 'Gemini 4 Argon', 'Qwen 3.8', 'Kimi K3.1 Pro', 'GLM 5.2', 'Local · Qwen 3.8 Flash']);
  menu.children[1].props.onClick();
  assert.equal(f.storage.get('dsh.prompt-enhancer.model.v1'), 'openrouter/google/gemini-3.6-flash');
  assert.equal(f.focuses.at(-1), 'Choose enhancement model');
  assert.equal(f.find(f.render(), 'Enhancement model'), undefined);
  await f.click(); assert.equal(f.requests[0][2], 'openrouter/google/gemini-3.6-flash');
  const reopened = await fixture(f.storage);
  assert.equal(reopened.find(reopened.render(), 'Choose enhancement model').props.title, 'Gemini 3.6 Flash');
  toggle(); f.render(); f.listeners.pointerdown({ target: {} });
  assert.equal(f.find(f.render(), 'Enhancement model'), undefined);
  toggle(); f.render(); f.listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(f.focuses.at(-1), 'Choose enhancement model');
  assert.equal(f.find(f.render(), 'Enhancement model'), undefined);
});

test('empty draft remains visible while enhancing or showing an error', async () => {
  const f = await fixture(); let finish;
  f.respond(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.click(); f.setInput({ ...f.input(), draft: '' });
  assert.ok(f.find(f.render(), 'Cancel enhancement'));
  finish({ ok: false }); await pending;
  assert.match(JSON.stringify(f.render()), /Enhancement failed/);
  assert.equal(f.render().props.className, 'pe-dock');
});

test('client performs one guarded full-span native edit', async () => {
  const f = await fixture(); await f.click();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0][0], 's-1'); assert.equal(f.requests[0][1], '  original prompt  ');
  assert.equal(f.requests[0][2], 'openrouter/deepseek/deepseek-v4.1-flash-1017');
  assert.deepEqual(f.edits, [{ text: 'improved prompt', span: { start: 0, end: 19, draftRev: 7 } }]);
  assert.equal(f.find(f.render(), 'Enhancement model used').children[0], 'openrouter/deepseek/deepseek-v4.1-flash-1017');
});

test('client refuses draft, revision, attachment, session or editor drift after response', async () => {
  for (const change of [
    f => f.setInput({ ...f.input(), draft: 'changed' }),
    f => f.setInput({ ...f.input(), draftRev: 8 }),
    f => f.setInput({ ...f.input(), attachmentIds: ['b', 'a'] }),
    f => { f.props.session = { sessionId: 'other' }; f.render(); },
    f => f.editor.markers.add('data-composer-chip'),
    f => { f.parent.editors = []; },
  ]) {
    const f = await fixture(); let finish; f.respond(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.click(); change(f); finish({ ok: true, value: { text: 'improved', route: DEFAULT_ENHANCE_MODEL } }); await pending;
    assert.equal(f.requests.length, 1); assert.equal(f.edits.length, 0);
  }
});

test('cancel aborts an active request and never inserts its eventual response', async () => {
  const f = await fixture(); let finish; f.respond(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.click(); const tree = f.render();
  assert.match(JSON.stringify(tree), /Enhancing…/);
  f.find(tree, 'Cancel enhancement').props.onClick(); assert.equal(f.requests[0][3].aborted, true);
  finish({ ok: true, value: { text: 'improved', route: DEFAULT_ENHANCE_MODEL } }); await pending; assert.equal(f.edits.length, 0);
  assert.doesNotMatch(JSON.stringify(f.render()), /"role":"alert"/);
  f.setInput({ ...f.input(), draft: '' }); assert.equal(f.render(), null);
});
