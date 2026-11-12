import { test, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, Module } from 'node:module'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, stop } from 'esbuild'
const root = createRequire(import.meta.url)
async function bundleDependency(name, external = []) {
  const entry = root.resolve(name)
  const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node24', external })
  const module = new Module(entry)
  module.filename = entry
  module.paths = Module._nodeModulePaths(dirname(entry))
  module._compile(bundle.outputFiles[0].text, entry)
  return module.exports
}
const { Window } = await bundleDependency('happy-dom')
const window = new Window({ url: 'http://localhost' })
globalThis.window = window
globalThis.document = window.document
globalThis.HTMLElement = window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator })
const React = (await import(pathToFileURL(root.resolve('react')).href)).default
const { render, fireEvent, screen, cleanup, waitFor, act } = await bundleDependency('@testing-library/react', ['react', 'react-dom', 'react-dom/*'])
const { EditableChat, Markdown, safeHref } = await import('./ui.mjs')
afterEach(() => cleanup())
after(async () => { await window.happyDOM.abort(); stop() })

async function nativeModule(entry) {
  const result = await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true,
    write: false, format: 'esm', platform: 'node', target: 'node24', jsx: 'automatic', loader: { '.css': 'empty' },
    nodePaths: [new URL('node_modules', import.meta.url).pathname], plugins: [{ name: 'synthetic-ui', setup(build) {
      build.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, args => ({ path: pathToFileURL(root.resolve(args.path)).href, external: true }))
      build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'synthetic' }))
      build.onResolve({ filter: /RegenerationModelSelector\.tsx$/ }, () => ({ path: 'model', namespace: 'synthetic' }))
      build.onResolve({ filter: /\.module\.css$/ }, () => ({ path: 'styles', namespace: 'synthetic' }))
      build.onLoad({ filter: /.*/, namespace: 'synthetic' }, args => ({ loader: 'jsx', contents: args.path === 'model'
        ? 'export const RegenerationModelSelector = () => null'
        : args.path === 'styles' ? 'export default {}'
        : 'export const Button = ({children, ...props}) => <button {...props}>{children}</button>; export const InlineEditor = ({value, label}) => <textarea aria-label={label} value={value} readOnly />' }))
    } }] })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'))
}

test('native editor renders unconfirmed storage without closing or opening a child', { timeout: 10000 }, async () => {
  const { bindMessageEditCallbacks } = await nativeModule('./native-chat/src/client/chat/message-edit.ts')
  const { MessageEditPanel } = await nativeModule('./native-chat/src/client/chat/MessageEditPanel.tsx')
  let outcome, closed = 0, opened = 0
  const actions = { setMessageEditBusy() {}, setMessageEditOutcome(value) { outcome = value },
    closeMessageEdit() { closed++ }, setMessageEditRevision() {} }
  const failure = { ok: false, error: { code: 'gateway/internal', message: 'unconfirmed', details: { committed: true, durability: 'unconfirmed', childSessionId: 'child' } } }
  const session = { editMessage: async () => failure, editMessageAndFork: async () => failure }
  const callbacks = bindMessageEditCallbacks(session, actions, () => { opened++ })
  callbacks.saveMessageEditAndFork('message', 0, 'draft', 0)
  await waitFor(() => assert.equal(outcome?.kind, 'unconfirmed'), { timeout: 1000 })
  assert.equal(closed, 0)
  assert.equal(opened, 0)
  render(React.createElement(MessageEditPanel, { draft: 'draft', busy: false, canEdit: true, canFork: true,
    outcome, onChange() {}, onCancel() {}, onSave() {}, onSaveAndFork() {}, t: key => key }))
  assert.ok(screen.getByText('message.edit.unconfirmed'))
  assert.ok(screen.getByRole('textbox'))
})

const row = (id, role, seq, text) => role === 'user'
  ? { key: id, kind: 'user', data: { messageId: id, seq, content: [{ type: 'text', text }] } }
  : { key: id, kind: 'assistant-step', data: { status: 'settled', blocks: [{ kind: 'text', text }], finalNode: { messageId: id, seq } } }
function props(overrides = {}) {
  const nodes = new Map([['u', row('u', 'user', 1, 'Original question')], ['a', row('a', 'assistant', 2, 'Original answer')]])
  return { sessionId: 's', useChat: selector => selector({ order: ['u', 'a'], nodes }),
    useSession: selector => selector({ hasMore: false, loadingOlder: false }),
    useProjection: (_key, selector) => selector({ edits: {}, journalCount: 0 }),
    useAccess: () => true, renderFactorySlot: () => null, t: key => ({
      edit: 'Edit message', save: 'Save changes', userSave: 'Save and regenerate in a fork',
      fork: 'Save in a fork', cancel: 'Cancel', copy: 'Copy text', you: 'You', assistant: 'Assistant',
      conflict: 'Conflict: draft retained', edited: 'Edited',
    }[key] ?? key), runEdit: async () => ({ ok: true, value: {} }), openChild: () => {}, ...overrides }
}
test('editor action buttons never submit the surrounding composer form', () => {
  render(React.createElement('form', { onSubmit: event => event.preventDefault() },
    React.createElement(EditableChat, props())))
  for (const button of screen.getAllByRole('button')) assert.equal(button.type, 'button')
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit message' })[1])
  for (const button of screen.getAllByRole('button')) assert.equal(button.type, 'button')
})
test('renders the actual edited user and assistant texts from the journal projection', () => {
  render(React.createElement(EditableChat, props({ useProjection: (_key, selector) => selector({ edits: {
    u: { text: 'Corrected question', revision: 8 }, a: { text: 'Corrected answer', revision: 9 },
  } }) })))
  assert.ok(screen.getByText('Corrected question'))
  assert.ok(screen.getByText('Corrected answer'))
  assert.equal(screen.queryByText('Original answer'), null)
  assert.equal(screen.getAllByRole('button', { name: 'Edit message' }).length, 2)
})
test('assistant editor prefills its own text and submits a save, not a regenerated prompt', async () => {
  const calls = []
  render(React.createElement(EditableChat, props({ runEdit: async request => { calls.push(request); return { ok: true, value: {} } } })))
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit message' })[1])
  const input = screen.getByRole('textbox', { name: 'Edit message' })
  assert.equal(input.value, 'Original answer')
  fireEvent.change(input, { target: { value: '  Actual edited answer\nline 2  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => assert.equal(calls.length, 1))
  assert.equal(calls[0].role, 'assistant')
  assert.equal(calls[0].action, 'save')
  assert.equal(calls[0].text, '  Actual edited answer\nline 2  ')
  assert.equal(calls[0].messageId, 'a')
  await waitFor(() => assert.ok(screen.queryByRole('textbox') === null))
})
test('user editing navigates only after a confirmed regenerated fork', async () => {
  const calls = [], opened = []
  render(React.createElement(EditableChat, props({ runEdit: async request => { calls.push(request); return { ok: true, value: { childSessionId: 'child-1' } } }, openChild: id => opened.push(id) })))
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit message' })[0])
  assert.equal(screen.getByRole('textbox').value, 'Original question')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Corrected question' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save and regenerate in a fork' }))
  await waitFor(() => assert.deepEqual(opened, ['child-1']))
  assert.equal(calls[0].role, 'user')
  assert.equal(calls[0].text, 'Corrected question')
})
test('conflicts retain drafts and partial fork errors do not navigate', async () => {
  let result = { ok: false, error: { code: 'conflict', message: 'conflict' } }
  const opened = []
  render(React.createElement(EditableChat, props({ runEdit: async () => result, openChild: id => opened.push(id) })))
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit message' })[1])
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => assert.ok(screen.getByRole('alert')))
  assert.equal(screen.getByRole('textbox').value, 'Keep this draft')
  result = { ok: false, error: { code: 'partial', message: 'Partial fork', details: { childSessionId: 'partial-child' } } }
  fireEvent.click(screen.getByRole('button', { name: 'Save in a fork' }))
  await waitFor(() => assert.ok(screen.getByText(/partial-child/)))
  assert.deepEqual(opened, [])
})
test('cancel, empty text, and IME composition cannot accidentally commit', async () => {
  const calls = []
  render(React.createElement(EditableChat, props({ runEdit: async request => { calls.push(request); return { ok: true, value: {} } } })))
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit message' })[1])
  fireEvent.change(screen.getByRole('textbox'), { target: { value: ' ' } })
  assert.equal(screen.getByRole('button', { name: 'Save changes' }).disabled, true)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Composing text' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true, isComposing: true })
  assert.deepEqual(calls, [])
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  assert.equal(screen.queryByRole('textbox'), null)
})
test('a same-frame double gesture submits only once', async () => {
  let finish
  let calls = 0
  render(React.createElement(EditableChat, props({ runEdit: () => { calls++; return new Promise(resolve => { finish = resolve }) } })))
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit message' })[1])
  const button = screen.getByRole('button', { name: 'Save changes' })
  fireEvent.click(button)
  fireEvent.click(button)
  assert.equal(calls, 1)
  await act(async () => { finish({ ok: true, value: {} }) })
})
test('Markdown keeps HTML inert and rejects executable URLs', () => {
  render(React.createElement(Markdown, { text: '**Bold** and [bad](javascript:alert(1))\n\n<script>window.bad=true</script>' }))
  assert.equal(document.querySelectorAll('script').length, 0)
  assert.equal(document.querySelectorAll('a[href^="javascript:"]').length, 0)
  assert.ok(screen.getByText('Bold'))
  assert.equal(safeHref('data:text/html,test'), undefined)
  assert.equal(safeHref('https://example.com'), 'https://example.com')
})
