/** Real Loader + browser tests for the distributable profile plugin. */
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type Page } from '../dsh-source/apps/web/node_modules/playwright/index.mjs'
import { describe, beforeAll, afterAll, expect, it } from 'vitest'
import { LlmAdapter } from '../dsh-source/packages/llm/llm/src/index.ts'
import { SessionId } from '../dsh-source/packages/core/session/src/index.ts'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from '../dsh-source/apps/web/tests/scaffold.ts'
import { newEnglishPage } from '../dsh-source/apps/web/tests/support.ts'

const id = 'message-editor-plugin-e2e'
let activeId = SessionId(id)
const route = 'message-editor-test'
const modelCalls: unknown[] = []
let queueGate: { promise: Promise<void>; release: () => void } | undefined
class DeterministicAdapter extends LlmAdapter {
  override listModels(provider: string) {
    return Promise.resolve([
      { provider, id: 'test', name: 'Message editor test', contextWindow: 128000 },
      { provider, id: 'alt-model', name: 'Alternate editor model', contextWindow: 128000 },
    ])
  }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model === 'alt-model' ? 'Alternate editor model' : 'Message editor test',
      contextWindow: 128000,
    })
  }
  override async *stream(options: Parameters<LlmAdapter['stream']>[0]) {
    modelCalls.push({ model: options.model, messages: options.messages })
    if (queueGate) await queueGate.promise
    const text = options.model === 'alt-model'
      ? 'A regenerated response from the alternate model.'
      : 'A regenerated response to the corrected question.'
    yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
    yield { type: 'text-delta' as const, index: 0, text }
    yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text } }
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
  }
}
function fixture() {
  const data = [
    { type: 'model/selection', data: { provider: route, model: 'test' } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'user/message', surfaceOp: 'append', data: { id: 'user-text', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original user question.' }] } },
    { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1,
      message: { id: 'assistant-text', role: 'assistant', source: { kind: 'model', provider: route, model: 'test' }, content: [{ type: 'text', text: 'Original assistant answer.' }] }, stream: [] } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq, time: 1000 + seq }))
  return [{ type: 'session', version: 4, id, createdAt: 1000, cwd: '/fixture/message-edit-workspace', isSeeded: false, delegationDepth: 0 }, ...data]
    .map(value => JSON.stringify(value)).join('\n') + '\n'
}

describe('packaged message editing plugin', () => {
  let scaffold: WebScaffold, browser: Browser, page: Page
  let consoles: ReturnType<typeof watchConsole>
  beforeAll(async () => {
    scaffold = await launchWebScaffold({ profile: { hmr: false,
      packages: [{ dir: fileURLToPath(new URL('./tests/fixture', import.meta.url)), enabled: true }] } })
    scaffold.ctx.llm.registerAdapter([route], new DeterministicAdapter())
    await seedSession(scaffold, fixture(), id)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    consoles = watchConsole(page)
    page.on('console', message => {
      if (message.type() === 'error') console.error('Plugin browser error:', message.text())
      if (message.text().startsWith('Message editor plugin:')) console.log(message.text())
    })

    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const row = page.locator(`[data-row-key="session:${activeId}"]`)
    await page.locator('[role="treeitem"]').first().waitFor({ timeout: 20000 })
    if (!await row.isVisible()) await page.locator('[role="treeitem"]').first().click()
    await row.waitFor({ timeout: 20000 })
    await row.click()
    await page.locator('[data-message-edit-chat]').waitFor({ timeout: 15000 })
  }, 60000)
  afterAll(async () => { queueGate?.release(); queueGate = undefined; await browser?.close(); await scaffold?.close() })

  it('loads the actual plugin and renders editable text for both roles', async () => {
    await expect.poll(() => page.getByText('Original user question.', { exact: true }).count()).toBe(1)
    await expect.poll(() => page.getByText('Original assistant answer.', { exact: true }).count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Edit message', exact: true }).count()).toBe(2)
    expect(await page.getByRole('button', { name: 'Copy', exact: true }).count()).toBe(2)
    expect(await page.getByRole('button', { name: 'Good response', exact: true }).count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Bad response', exact: true }).count()).toBe(1)
    expect(consoles.pageErrors).toEqual([])
  })
  it('keeps the editor usable on a narrow screen and cancels without changing history', async () => {
    const oldViewport = page.viewportSize()!
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('[data-turn-tail]').getByRole('button', { name: 'Edit message' }).click()
    const editor = page.getByRole('textbox', { name: 'Edit message' })
    await editor.fill('This draft must not be committed.')
    await editor.press('Escape')
    await expect.poll(() => editor.count()).toBe(0)
    expect(await page.getByText('Original assistant answer.', { exact: true }).count()).toBe(1)
    expect(modelCalls).toHaveLength(0)
    await page.setViewportSize(oldViewport)
  })
  it('edits the actual assistant text and preserves the recorded answer', async () => {
    await page.locator('[data-turn-tail]').getByRole('button', { name: 'Edit message' }).click()
    const editor = page.getByRole('textbox', { name: 'Edit message' })
    expect(await editor.inputValue()).toBe('Original assistant answer.')
    await editor.fill('The edited assistant answer is now part of this chat history.')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => ({ editor: await page.getByRole('textbox', { name: 'Edit message' }).count(),
      errors: await page.getByRole('alert').allTextContents() }), { timeout: 5000 }).toEqual({ editor: 0, errors: [] })
    await expect.poll(() => page.getByText('The edited assistant answer is now part of this chat history.', { exact: true }).count()).toBe(1)
    const agent = scaffold.ctx.agents.get(activeId)!
    expect(agent.session.deriveMessages().some(message => message.role === 'assistant'
      && message.content.some(block => block.type === 'text' && block.text.startsWith('The edited assistant')))).toBe(true)
    expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === 'Original assistant answer.'))).toBe(true)
    expect(modelCalls).toHaveLength(0)
  })
  it('keeps assistant edits after reloading the browser', async () => {
    await page.reload({ waitUntil: 'load' })
    await page.locator(`[data-row-key="session:${activeId}"]`).click()
    await expect.poll(() => page.getByText('The edited assistant answer is now part of this chat history.', { exact: true }).count(), { timeout: 15000 }).toBe(1)
  })
  it('replaces active user history in the same session without creating a fork or retaining the old tail', async () => {
    const before = new Set(scaffold.ctx.agents.list().map(agent => agent.id))
    await page.locator('[data-chat-flow-kind="user"]').first().getByRole('button', { name: 'Edit message' }).click()
    const editor = page.getByRole('textbox', { name: 'Edit message' })
    expect(await editor.inputValue()).toBe('Original user question.')
    expect(await page.getByRole('button', { name: 'Save and regenerate', exact: true }).count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Save and fork', exact: true }).count()).toBe(1)
    const modelSelect = page.getByRole('combobox', { name: 'Regeneration model' })
    await expect.poll(() => modelSelect.locator('option').count()).toBeGreaterThan(2)
    await modelSelect.selectOption(JSON.stringify({ provider: route, model: 'alt-model' }))
    await editor.fill('Same-chat corrected user question.')
    await page.getByRole('button', { name: 'Save and regenerate', exact: true }).click()
    await expect.poll(() => page.getByText('Same-chat corrected user question.', { exact: true }).count()).toBe(1)
    await expect.poll(() => page.getByText('A regenerated response from the alternate model.', { exact: true }).count(), { timeout: 15000 }).toBe(1)
    expect(new Set(scaffold.ctx.agents.list().map(agent => agent.id))).toEqual(before)
    expect(await page.locator('[data-message-edit-chat]').getAttribute('data-message-edit-chat')).toBe(activeId)
    expect(await page.locator(`[data-row-key="session:${id}"]`).count()).toBe(1)
    const activeChat = page.locator('[data-message-edit-chat]')
    expect(await activeChat.getByText('Original user question.', { exact: true }).count()).toBe(0)
    expect(await activeChat.getByText('The edited assistant answer is now part of this chat history.', { exact: true }).count()).toBe(0)
    expect(await activeChat.getByText('Regenerate your response to this revised user message:', { exact: false }).count()).toBe(0)
    expect(JSON.stringify(modelCalls[0])).not.toContain('Original user question.')
    expect(JSON.stringify(modelCalls[0])).not.toContain('The edited assistant answer is now part of this chat history.')
    expect((modelCalls[0] as { model: string }).model).toBe('alt-model')
    const source = scaffold.ctx.agents.get(activeId)! 
    expect(source.session.deriveMessages().some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text === 'Same-chat corrected user question.'))).toBe(true)
    expect(modelCalls).toHaveLength(1)
  })
  it('edits the user text into a regenerated fork without changing the source', async () => {
    await page.locator('[data-chat-flow-kind="user"]').first().getByRole('button', { name: 'Edit message' }).click()
    const editor = page.getByRole('textbox', { name: 'Edit message' })
    expect(await editor.inputValue()).toBe('Same-chat corrected user question.')
    const modelSelect = page.getByRole('combobox', { name: 'Regeneration model' })
    await expect.poll(() => modelSelect.locator('option').count()).toBeGreaterThan(2)
    await modelSelect.selectOption(JSON.stringify({ provider: route, model: 'test' }))
    await editor.fill('A corrected user question for the regenerated response.')
    const beforeFork = new Set(scaffold.ctx.agents.list().map(agent => agent.id))
    await page.getByRole('button', { name: 'Save and fork', exact: true }).click()
    await expect.poll(() => scaffold.ctx.agents.list().find(agent => !beforeFork.has(agent.id)), { timeout: 15000 }).toBeDefined()
    const child = scaffold.ctx.agents.list().find(agent => !beforeFork.has(agent.id))!
    await expect.poll(() => page.locator('[data-message-edit-chat]').getAttribute('data-message-edit-chat'), { timeout: 15000 }).toBe(child.id)
    await expect.poll(() => page.getByText('A corrected user question for the regenerated response.', { exact: true }).count(), { timeout: 15000 }).toBe(1)
    await expect.poll(() => page.getByText('A regenerated response to the corrected question.', { exact: true }).count(), { timeout: 15000 }).toBe(1)
    const source = scaffold.ctx.agents.get(activeId)!
    expect(source.session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text === 'Same-chat corrected user question.'))).toBe(true)
    await expect.poll(() => modelCalls.length, { timeout: 15000 }).toBe(2)
    expect((modelCalls[1] as { model: string }).model).toBe('test')
    expect(consoles.pageErrors).toEqual([])
  })
  it('holds a queued message aside during generation and re-queues edited text on Enter', async () => {
    await page.locator(`[data-row-key="session:${activeId}"]`).click()
    const source = scaffold.ctx.agents.get(activeId)!
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    queueGate = { promise, release }
    const send = (text: string) => scaffold.ctx.sessionController.prompt({
      sessionId: source.id, requestId: randomUUID() as never, mode: 'queue', content: [{ type: 'text', text }],
    }, new AbortController().signal)
    await send('Begin the controlled queue test.')
    await expect.poll(() => source.status).toBe('running')
    await send('Queued A: do not consume while editing.')
    await send('Queued B: this can run normally.')
    const a = source.inbox.nextTurn.find(message => message.content.some(block => block.type === 'text' && block.text.startsWith('Queued A:')))!
    await page.locator(`[data-queued-message="${a.id}"]`).getByRole('button', { name: 'Edit queued message' }).click()
    await expect.poll(() => source.inbox.nextTurn.some(message => message.id === a.id)).toBe(false)
    const editor = page.getByRole('textbox', { name: 'Edit queued message' })
    await editor.fill('Edited queued A: consume only after Enter.')
    const callCount = modelCalls.length
    queueGate = undefined
    release()
    await source.whenIdle()
    expect(source.inbox.nextTurn.some(message => message.id === a.id)).toBe(false)
    expect(await page.locator('[data-held-queue-drafts]').count()).toBe(1)
    expect(await editor.inputValue()).toBe('Edited queued A: consume only after Enter.')
    // Queued B was allowed through, but A stayed out of every model request.
    const newCalls = modelCalls.slice(callCount)
    expect(JSON.stringify(newCalls)).not.toContain('Queued A: do not consume while editing.')
    await editor.press('Enter')
    await expect.poll(() => page.locator('[data-held-queue-drafts]').count()).toBe(0)
    await source.whenIdle()
    await expect.poll(() => source.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.id === a.id && event.data.content.some(block => block.type === 'text' && block.text === 'Edited queued A: consume only after Enter.'))).toBe(true)
    expect(consoles.pageErrors).toEqual([])
  })
  it('Escape restores the original queued text rather than the edited draft', async () => {
    const source = scaffold.ctx.agents.get(activeId)!
    let release!: () => void
    queueGate = { promise: new Promise<void>(resolve => { release = resolve }), release: () => release() }
    const send = (text: string) => scaffold.ctx.sessionController.prompt({
      sessionId: source.id, requestId: randomUUID() as never, mode: 'queue', content: [{ type: 'text', text }],
    }, new AbortController().signal)
    await send('Hold generation for the cancellation test.')
    await expect.poll(() => source.status).toBe('running')
    await send('Original queued cancellation message.')
    const item = source.inbox.nextTurn.find(message => message.content.some(block => block.type === 'text' && block.text === 'Original queued cancellation message.'))!
    await page.locator(`[data-queued-message="${item.id}"]`).getByRole('button', { name: 'Edit queued message' }).click()
    const editor = page.getByRole('textbox', { name: 'Edit queued message' })
    await editor.fill('This draft must not replace the original.')
    await editor.press('Escape')
    await expect.poll(() => source.inbox.nextTurn.find(message => message.id === item.id)?.content
      .filter(block => block.type === 'text').map(block => block.text).join('')).toBe('Original queued cancellation message.')
    await expect.poll(() => page.locator('[data-held-queue-drafts]').count()).toBe(0)
    queueGate = undefined
    release()
    await source.whenIdle()
    expect(consoles.pageErrors).toEqual([])
  })
})
