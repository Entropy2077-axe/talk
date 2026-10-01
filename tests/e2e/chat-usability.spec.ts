import { expect, test, type Page } from 'playwright/test'

async function fixture(page: Page, options: { group?: boolean; desktop?: boolean; key?: string; messages?: number; regenerate?: boolean } = {}) {
  if (options.desktop) {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.addInitScript(() => { window.talkDesktop = { minimize() {}, toggleMaximize() {}, close() {}, isMaximized: async () => false, onMaximizedChange: () => () => {} } as typeof window.talkDesktop })
  }
  await page.goto('/#/')
  await page.evaluate(async (options) => {
    const { db } = await import('/src/db/db.ts')
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    useSettingsStore.getState().setSettings({ apiKey: options.key ?? '', baseUrl: 'https://chat-ui-test.invalid', aiProvider: 'custom', model: 'test', utilityModel: 'test', enabledModules: options.regenerate ? ['directOutput'] : [], experienceMode: 'free', animationsEnabled: false, chatPageSize: 40, chatBackground: '', actionDecisionProvider: 'llm', automaticAiDailyCap: 0 })
    for (const table of db.tables) await table.clear()
    await db.contacts.add({ id: 'ui-contact', name: '测试联系人', avatar: '', avatarColor: '#e5f7ef', systemPrompt: '友好的朋友', createdAt: 1, memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0, relationshipBase: '朋友', relationshipDynamic: '' })
    if (options.group) await db.groups.add({ id: 'ui-group', name: '测试群', avatar: '', avatarColor: '#e5f7ef', memberContactIds: ['ui-contact'], createdAt: 1 })
    await db.conversations.add({ id: 'ui-chat', ...(options.group ? { groupId: 'ui-group' } : { contactId: 'ui-contact' }), pinned: false, createdAt: 1, updatedAt: 1 })
    const count = options.messages ?? 1
    await db.messages.bulkAdd(Array.from({ length: count }, (_, index) => ({ id: `ui-message-${index}`, conversationId: 'ui-chat', role: index === 0 && options.regenerate ? 'user' : 'assistant', type: 'text', content: `历史消息 ${index}`, createdAt: index + 2, ...(options.regenerate && index > 0 ? { debugAiTurnId: 'ui-turn' } : {}) })))
    if (options.regenerate) await db.aiTurns.add({ id: 'ui-turn', conversationId: 'ui-chat', raw: '', createdAt: count + 2 })
    await db.stickers.add({ id: 'ui-sticker', name: '本地测试表情', dataUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="gray"/></svg>', createdAt: 1 })
    localStorage.setItem('talk-chat-long-press-hint-seen-v1', '1')
  }, options)
  await page.goto('/#/chat/ui-chat')
  await expect(page.getByTestId('chat-scroll')).toBeVisible()
}

for (const group of [false, true]) {
  test(`unconfigured ${group ? 'group' : 'private'} send preserves draft and opens LLM settings`, async ({ page }) => {
    await fixture(page, { group })
    const draft = page.locator('textarea').first()
    await draft.fill(group ? '@测试联系人 保留我的话' : '保留我的话')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(draft).toHaveValue(group ? '@测试联系人 保留我的话' : '保留我的话')
    await expect(page.getByText('还没有配置 API Key', { exact: false })).toBeVisible()
    expect(await page.evaluate(async () => { const { db } = await import('/src/db/db.ts'); return db.messages.where('conversationId').equals('ui-chat').filter((m) => m.role === 'user').count() })).toBe(0)
    await page.getByRole('button', { name: '去配置', exact: true }).click()
    await expect(page).toHaveURL(/#\/settings\/api-configurations$/)
  })
}

test('storage failure keeps draft and retry does not send a duplicate', async ({ page }) => {
  await fixture(page, { key: 'fake-key' })
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    db.messages.hook('creating', function (_key, message) { if (message.role === 'user') throw new Error('模拟存储失败') })
  })
  const draft = page.locator('textarea').first()
  await draft.fill('不能丢掉的草稿')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('消息未发送，输入已保留', { exact: false })).toBeVisible()
  await expect(draft).toHaveValue('不能丢掉的草稿')
  await page.getByRole('button', { name: '继续编辑' }).click()
  await expect(draft).toHaveValue('不能丢掉的草稿')
  expect(await page.evaluate(async () => { const { db } = await import('/src/db/db.ts'); return db.messages.where('conversationId').equals('ui-chat').filter((m) => m.role === 'user').count() })).toBe(0)
})

test('2000-message history keeps its reading position during incoming messages and resizing', async ({ page }) => {
  await fixture(page, { messages: 2000 })
  const scroll = page.getByTestId('chat-scroll')
  await expect.poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5)
  await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 500; el.dispatchEvent(new Event('scroll')) })
  await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible()
  const anchor = await scroll.evaluate((el) => {
    const top = el.getBoundingClientRect().top
    const node = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find((node) => node.getBoundingClientRect().bottom > top)!
    return { id: node.dataset.messageId!, offset: node.getBoundingClientRect().top - top }
  })
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { useChatEngineStore } = await import('/src/lib/chatEngine.ts')
    useChatEngineStore.getState().patch('ui-chat', { aiTyping: true, typingLabel: '测试联系人' })
    await db.messages.add({ id: 'ui-incoming', conversationId: 'ui-chat', role: 'assistant', type: 'text', content: '新的回复', createdAt: 3000 })
    await db.contacts.update('ui-contact', { mood: '开心' })
  })
  await expect(page.locator('[data-message-id="ui-incoming"]')).toBeAttached()
  await expect.poll(() => page.locator(`[data-message-id="${anchor.id}"]`).evaluate((node) => node.getBoundingClientRect().top - node.closest('[data-testid="chat-scroll"]')!.getBoundingClientRect().top)).toBeCloseTo(anchor.offset, 0)
  await page.setViewportSize({ width: 393, height: 650 })
  await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible()
  await page.getByRole('button', { name: '回到最新消息' }).click()
  await expect.poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5)
  await page.evaluate(async () => { const { db } = await import('/src/db/db.ts'); await db.messages.add({ id: 'ui-follow', conversationId: 'ui-chat', role: 'assistant', type: 'text', content: '继续跟随', createdAt: 3001 }) })
  await expect(page.locator('[data-message-id="ui-follow"]')).toBeVisible()
})

for (const desktop of [false, true]) {
  test(`${desktop ? 'desktop' : 'mobile'} composer keeps stop/send in one slot and supports IME`, async ({ page }) => {
    await fixture(page, { desktop })
    await page.evaluate(async () => { const { useChatEngineStore } = await import('/src/lib/chatEngine.ts'); useChatEngineStore.getState().patch('ui-chat', { aiTyping: true }) })
    await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible()
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toHaveCount(0)
    const draft = page.locator('textarea').first()
    await draft.fill('我想插话')
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
    await draft.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
    await expect(page.getByText('还没有配置 API Key', { exact: false })).toHaveCount(0)
    await draft.fill('')
    await page.getByRole('button', { name: '停止生成' }).click()
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
    await page.screenshot({ path: test.info().outputPath('composer.png') })
    await page.evaluate(async () => { const { useSettingsStore } = await import('/src/store/useSettingsStore.ts'); useSettingsStore.getState().setSettings({ themeMode: 'dark' }) })
    await page.screenshot({ path: test.info().outputPath('composer-dark.png') })
  })
}

test('local stickers can be sent from the independent picker', async ({ page }) => {
  await fixture(page)
  await page.getByRole('button', { name: '搜索表情包' }).click()
  await expect(page.getByText('我的表情', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '本地测试表情', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => { const { db } = await import('/src/db/db.ts'); return db.messages.where('conversationId').equals('ui-chat').filter((m) => m.type === 'sticker' && m.content === '本地测试表情').count() })).toBe(1)
})

test('regenerate shortcut replaces the recent AI turn and keeps the user message', async ({ page }) => {
  await page.route('**/chat/completions', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ valid: true, messages: [{ type: 'text', content: '重新生成的回复' }], specialTask: { decision: 'none' } }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) })
  })
  await fixture(page, { key: 'fake-key', messages: 2, regenerate: true })
  await page.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect(page.getByText('重新生成的回复', { exact: true })).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('历史消息 0', { exact: true })).toBeVisible()
  await expect(page.getByText('历史消息 1', { exact: true })).toHaveCount(0)
})

test('stopping a real request prevents its late reply from leaking into the next turn', async ({ page }) => {
  let releaseFirst!: () => void
  const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve })
  let firstRequested = false
  await page.route('**/chat/completions', async (route) => {
    const first = !firstRequested
    firstRequested = true
    if (first) await firstResponse
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ valid: true, messages: [{ type: 'text', content: first ? '应被丢弃的旧回复' : '下一轮的回复' }], specialTask: { decision: 'none' } }) } }] }) }).catch(() => {})
  })
  await fixture(page, { key: 'fake-key', regenerate: true })
  const draft = page.locator('textarea').first()
  await draft.fill('第一句话')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(draft).toHaveValue('')
  await expect.poll(() => firstRequested).toBe(true)
  await page.getByRole('button', { name: '停止生成' }).click()
  releaseFirst()
  await draft.fill('新的话')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('下一轮的回复', { exact: true })).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('应被丢弃的旧回复', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(async () => { const { db } = await import('/src/db/db.ts'); return db.messages.where('conversationId').equals('ui-chat').filter((message) => message.role === 'user').count() })).toBe(3)
})

test('search positioning survives later updates and loading earlier history preserves its anchor', async ({ page }) => {
  await fixture(page, { messages: 2000 })
  await page.goto('/#/chat/ui-chat?highlight=ui-message-1800')
  const target = page.locator('[data-message-id="ui-message-1800"]')
  await expect(target).toBeVisible()
  await page.evaluate(async () => { const { db } = await import('/src/db/db.ts'); await db.messages.add({ id: 'search-incoming', conversationId: 'ui-chat', role: 'assistant', type: 'text', content: '搜索时的新回复', createdAt: 3000 }) })
  await expect(page.locator('[data-message-id="search-incoming"]')).toBeAttached()
  await expect(target).toBeVisible()
  const scroll = page.getByTestId('chat-scroll')
  await scroll.evaluate((el) => { el.scrollTop = 100; el.dispatchEvent(new Event('scroll')) })
  const anchor = await scroll.evaluate((el) => {
    const top = el.getBoundingClientRect().top
    const node = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find((node) => node.getBoundingClientRect().bottom > top)!
    return { id: node.dataset.messageId!, offset: node.getBoundingClientRect().top - top }
  })
  await page.getByRole('button', { name: '加载更早消息' }).evaluate((button: HTMLButtonElement) => button.click())
  await expect.poll(() => page.locator(`[data-message-id="${anchor.id}"]`).evaluate((node) => node.getBoundingClientRect().top - node.closest('[data-testid="chat-scroll"]')!.getBoundingClientRect().top)).toBeCloseTo(anchor.offset, 0)
})

test('indexed send preparation and unread summaries handle a large conversation without loading its body', async ({ page }) => {
  await fixture(page, { messages: 2000 })
  const measurements = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { nextMessageTimestamp } = await import('/src/lib/chatEngine.ts')
    const { readConversationSummary } = await import('/src/lib/unread.ts')
    await db.messages.update('ui-message-1998', { role: 'user' })
    const indexed = () => db.messages.where('[conversationId+createdAt]').between(['ui-chat', -Infinity], ['ui-chat', Infinity], true, true)
    async function measure(operation: () => Promise<void>) {
      const times: number[] = []
      for (let i = 0; i < 10; i++) { const start = performance.now(); await operation(); times.push(performance.now() - start) }
      return times.sort((a, b) => a - b)[5]
    }
    const fullScanMs = await measure(async () => {
      const all = await db.messages.where('conversationId').equals('ui-chat').toArray()
      all.reduce((latest, message) => Math.max(latest, message.createdAt), 0)
      const previous = await db.messages.where('conversationId').equals('ui-chat').toArray()
      previous.filter((message) => message.role === 'user').reduce((latest, message) => Math.max(latest, message.createdAt), 0)
    })
    const indexedMs = await measure(async () => { await nextMessageTimestamp('ui-chat', 1); await indexed().reverse().filter((message) => message.role === 'user').first() })
    const summary = await readConversationSummary('ui-chat')
    return { fullScanMs, indexedMs, lastMessageId: summary.lastMessage?.id, nextTimestamp: await nextMessageTimestamp('ui-chat', 1) }
  })
  expect(measurements.lastMessageId).toBe('ui-message-1999')
  expect(measurements.nextTimestamp).toBe(2002)
  console.log('2000-message query benchmark (median milliseconds, not end-to-end send latency):', JSON.stringify(measurements))
})

test('conversation menu marks messages as read and live contact changes still repair missing conversations', async ({ page }) => {
  await fixture(page)
  await page.goto('/#/')
  await page.evaluate(async () => { const { db } = await import('/src/db/db.ts'); await db.conversations.update('ui-chat', { lastReadAt: 0 }) })
  const row = page.locator('div.cursor-pointer').filter({ has: page.getByText('历史消息 0', { exact: true }) })
  await expect(row).toBeVisible()
  await row.dispatchEvent('pointerdown', { bubbles: true, pointerId: 9, pointerType: 'touch', clientX: 120, clientY: 180, isPrimary: true, buttons: 1 })
  await expect(page.getByRole('button', { name: '标为已读' })).toBeVisible()
  await row.dispatchEvent('pointerup', { bubbles: true, pointerId: 9, pointerType: 'touch', clientX: 120, clientY: 180, isPrimary: true })
  await page.getByRole('button', { name: '标为已读' }).click()
  expect(await page.evaluate(async () => { const { db } = await import('/src/db/db.ts'); return (await db.conversations.get('ui-chat'))!.lastReadAt })).toBeGreaterThan(2)
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const current = (await db.contacts.get('ui-contact'))!
    await db.transaction('rw', db.contacts, db.conversations, async () => {
      await db.contacts.clear()
      await db.conversations.clear()
      await db.contacts.add({ ...current, id: 'switched-world-contact', name: '切换世界后的联系人' })
    })
  })
  await expect(page.getByText('切换世界后的联系人', { exact: true })).toBeVisible()
  expect(await page.evaluate(async () => { const { db } = await import('/src/db/db.ts'); return db.conversations.where('contactId').equals('switched-world-contact').count() })).toBe(1)
})

test('autonomous behavior configuration is reachable from modules rather than discover', async ({ page }) => {
  await fixture(page)
  await page.evaluate(async () => { const { useSettingsStore } = await import('/src/store/useSettingsStore.ts'); useSettingsStore.getState().setSettings({ enabledModules: ['proactiveChat'] }) })
  await page.goto('/#/discover')
  await expect(page.getByText('社交动态', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /自主行为设置/ })).toHaveCount(0)
  await page.goto('/#/modules')
  await page.getByRole('button', { name: /自主行为设置/ }).click()
  await expect(page).toHaveURL(/#\/proactive-settings$/)
})
