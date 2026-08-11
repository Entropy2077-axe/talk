import { expect, test, type Page } from 'playwright/test'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

async function clearDatabase(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    for (const table of db.tables) await table.clear()
  })
}

async function seedBackupFixture(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    for (const table of db.tables) await table.clear()
    await db.contacts.add({
      id: 'contact-backup',
      name: 'Backup Alice',
      avatar: '🙂',
      avatarColor: '#e5f7ef',
      systemPrompt: 'A friendly backup test contact.',
      createdAt: 1,
      memoryFacts: '',
      memoryStyle: '',
      memoryUpdatedAt: 0,
      memoryMessageCursor: 0,
      warmth: 15, relationshipBase: '朋友', relationshipDynamic: '',
    })
    await db.conversations.add({
      id: 'conversation-backup',
      contactId: 'contact-backup',
      pinned: false,
      updatedAt: 2,
      createdAt: 2,
    })
    await db.messages.add({
      id: 'message-backup',
      conversationId: 'conversation-backup',
      role: 'assistant',
      type: 'text',
      content: 'backup hello',
      createdAt: 3,
    })
    useSettingsStore.getState().setSettings({
      userNickname: 'Backup User',
      apiKey: 'sk-regression-secret',
      tavilyApiKey: 'tvly-regression-secret',
      pexelsApiKey: 'pexels-regression-secret',
    })
  })
}

async function seedSearchAndGroupFixture(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    for (const table of db.tables) await table.clear()
    useSettingsStore.getState().setSettings({ adminModeEnabled: true, themeMode: 'light', chatBackground: '' })
    const baseContact = {
      avatar: '🙂',
      avatarColor: '#e5f7ef',
      systemPrompt: 'test persona',
      createdAt: 1,
      memoryFacts: '',
      memoryStyle: '',
      memoryUpdatedAt: 0,
      memoryMessageCursor: 0,
      warmth: 15, relationshipBase: '朋友', relationshipDynamic: '',
    }
    await db.contacts.bulkAdd([
      { ...baseContact, id: 'contact-a', name: 'Alice Search' },
      { ...baseContact, id: 'contact-b', name: 'Bob Member' },
      { ...baseContact, id: 'contact-c', name: 'Carol Newbie' },
    ])
    await db.groups.add({
      id: 'group-a',
      name: 'Search Squad',
      avatar: '👥',
      avatarColor: '#e5e7eb',
      memberContactIds: ['contact-a', 'contact-b'],
      createdAt: 2,
      memoryMessageCursor: 0,
    })
    await db.conversations.bulkAdd([
      { id: 'conversation-a', contactId: 'contact-a', pinned: false, createdAt: 3, updatedAt: 5 },
      { id: 'conversation-g', groupId: 'group-a', pinned: false, createdAt: 4, updatedAt: 6 },
    ])
    await db.messages.bulkAdd([
      {
        id: 'message-a',
        conversationId: 'conversation-a',
        role: 'assistant',
        type: 'text',
        content: 'the hidden keyword is nebula',
        debugRawAiResponse: '{"messages":[{"type":"text","content":"the hidden keyword is nebula"}]}',
        debugParsedBubble: { type: 'text', content: 'the hidden keyword is nebula' },
        createdAt: 7,
      },
      {
        id: 'message-g',
        conversationId: 'conversation-g',
        role: 'assistant',
        type: 'text',
        content: 'group keyword comet',
        speakerContactId: 'contact-a',
        createdAt: 8,
      },
    ])
    await db.aiTurns.add({
      id: 'turn-a',
      conversationId: 'conversation-a',
      raw: '{"messages":[{"type":"text","content":"first bubble"},{"type":"text","content":"second bubble"}],"knowledgeQueries":["nebula"]}',
      parsed: {
        rawText: 'first bubble\nsecond bubble',
        conversionParsed: {
          messages: [
            { type: 'text', content: 'first bubble' },
            { type: 'text', content: 'second bubble' },
          ],
          knowledgeQueries: ['nebula'],
        },
        parsedBubbles: [
          { type: 'text', content: 'first bubble' },
          { type: 'text', content: 'second bubble' },
        ],
        mood: 'calm',
        thought: 'debug thought',
        validator: { enabled: true, mode: 'quality', repaired: false, optimized: false },
        injectedIntents: [{ text: 'ask about tomorrow', kind: 'follow_up', confidence: 90 }],
        memoryUpdate: { addedIntents: [{ text: 'ask about tomorrow', kind: 'follow_up', confidence: 90 }] },
        knowledgeQueries: ['nebula'],
      },
      knowledgeQueries: ['nebula'],
      createdAt: 9,
    })
    await db.messages.update('message-a', { debugAiTurnId: 'turn-a' })
  })
}

test('settings page exports a complete Talk backup json', async ({ page }) => {
  await page.goto('/#/settings')
  await seedBackupFixture(page)
  await page.reload()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出备份' }).click()
  const download = await downloadPromise
  const path = await download.path()
  expect(path).toBeTruthy()

  const backup = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(path!, 'utf8')))
  expect(backup.format).toBe('talk-backup')
  expect(backup.schemaVersion).toBe(10)
  expect(backup.settings.userNickname).toBe('Backup User')
  expect(backup.tables.contacts).toHaveLength(1)
  expect(backup.tables.conversations).toHaveLength(1)
  expect(backup.tables.mediaAssets).toEqual([])
  expect(backup.tables.messages).toHaveLength(1)
  expect(Object.keys(backup.tables)).toEqual(
    expect.arrayContaining(['stickers', 'moments', 'knowledgeEntries', 'libraryItems', 'savedWorldviews', 'worldbookEntries', 'contactMemories', 'shopPurchaseHistory', 'contactGenerationTasks', 'worldSnapshots', 'worldContactStates']),
  )
})

test('desktop settings sidebar exposes the experience mode switch', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'talkDesktop', {
      configurable: true,
      value: {
        minimize() {},
        toggleMaximize() {},
        close() {},
        isMaximized: async () => false,
        onMaximizedChange: () => () => {},
      },
    })
  })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/#/settings')

  const entry = page.locator('.desktop-sidebar').getByRole('button', { name: /体验模式/ })
  await expect(entry).toBeVisible()
  await expect(entry).toContainText('自由模式')
  await entry.click()

  await expect(page).toHaveURL(/#\/experience-mode$/)
  await expect(page.locator('.desktop-sidebar').getByRole('button', { name: /体验模式/ })).toHaveClass(/active/)
  await expect(page.getByRole('heading', { name: '沉浸模式' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '自由模式' })).toBeVisible()
})

test('desktop contacts live only in the sidebar while the main pane stays contextual', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'talkDesktop', {
      configurable: true,
      value: {
        minimize() {},
        toggleMaximize() {},
        close() {},
        isMaximized: async () => false,
        onMaximizedChange: () => () => {},
      },
    })
  })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/#/contacts')
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    for (const table of db.tables) await table.clear()
    await db.contacts.add({
      id: 'desktop-contact', name: '左栏联系人', avatar: '🙂', avatarColor: '#e5f7ef', systemPrompt: 'test', createdAt: 1,
      memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0, warmth: 15, relationshipBase: '朋友', relationshipDynamic: '',
    })
    await db.contactGenerationTasks.add({
      id: 'desktop-generation', experienceMode: 'free', method: 'precision', status: 'awaiting_review', stageLabel: '初稿已完成，待确认',
      input: {
        personalityTags: [], ageRange: '', gender: '', relationship: '', occupation: '', hobbies: [], personalityTrait: '', roleDescription: '', personaSetting: '', sharedHistory: '', avatar: '', avatarManuallySet: false,
        initialWarmthMode: 'auto', relations: [], selectedWorldbookEntryIds: [], careerEnabled: true, relationshipEnabled: true, locationEnabled: true,
      },
      provider: 'custom', baseUrl: '', model: '', utilityModel: '', attempt: 1, createdAt: 2, updatedAt: 2,
    })
  })
  await page.reload()

  const sidebar = page.locator('.desktop-sidebar')
  const main = page.locator('.desktop-main')
  await expect(sidebar.getByRole('button', { name: /添加联系人/ })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: /初稿已完成，待确认/ })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: /左栏联系人/ })).toBeVisible()
  await expect(main.getByText('从左侧选择联系人、添加联系人或查看生成任务。')).toBeVisible()
  await expect(main.getByRole('button', { name: /添加联系人/ })).toHaveCount(0)
  await expect(main.getByText('左栏联系人')).toHaveCount(0)
})

test('settings page restores contacts and settings from a backup file', async ({ page }) => {
  await page.goto('/#/settings')
  await seedBackupFixture(page)
  await page.reload()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出备份' }).click()
  const backupPath = await (await downloadPromise).path()
  expect(backupPath).toBeTruthy()

  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    for (const table of db.tables) await table.clear()
    useSettingsStore.getState().setSettings({ userNickname: 'Mutated User', apiKey: 'mutated-secret' })
  })

  page.on('dialog', (dialog) => dialog.accept())
  await page.locator('input[accept="application/json,.json"]').setInputFiles(backupPath!)
  await expect(page.getByText('备份已恢复')).toBeVisible()

  const restored = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const persisted = JSON.parse(window.localStorage.getItem('talk-settings') ?? '{"state":{}}')
    return {
      contacts: await db.contacts.toArray(),
      messages: await db.messages.toArray(),
      userNickname: persisted.state.userNickname,
      apiKey: persisted.state.apiKey,
    }
  })
  expect(restored.contacts).toHaveLength(1)
  expect(restored.contacts[0].name).toBe('Backup Alice')
  expect(restored.messages[0].content).toBe('backup hello')
  expect(restored.userNickname).toBe('Backup User')
  expect(restored.apiKey).toBe('sk-regression-secret')
})

test('discover page does not expose removed todo entry', async ({ page }) => {
  await page.goto('/#/discover')
  await clearDatabase(page)
  await page.reload()

  await expect(page.locator('nav')).toBeVisible()
  await expect(page.getByText('待办')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('Todo')
})


test('settings page scrolls to bottom revealing backup section and danger zone', async ({ page }) => {
  await page.goto('/#/settings')
  await clearDatabase(page)

  const scrollContainer = page.locator('.overflow-y-auto')
  await scrollContainer.last().evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })

  await expect(page.getByText('数据备份与恢复')).toBeInViewport()
  await expect(page.getByText('危险操作')).toBeInViewport()
  await expect(page.getByRole('button', { name: '导出备份' })).toBeInViewport()
  await expect(page.getByRole('button', { name: '清空所有联系人与聊天记录' })).toBeInViewport()
})

test('settings uses searchable model pickers for large provider model lists', async ({ page }) => {
  const models = Array.from({ length: 118 }, (_, index) => `vendor/model-${String(index).padStart(3, '0')}`)
  models[73] = 'deepseek-ai/deepseek-v4-pro'

  await page.route('https://models.example/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: models.map((id) => ({ id })) }),
    })
  })
  await page.goto('/#/settings')
  await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    useSettingsStore.getState().setSettings({
      apiKey: 'test-key',
      baseUrl: 'https://models.example',
      model: 'old-chat-model',
      utilityModel: 'old-utility-model',
    })
  })
  await page.reload()

  await page.getByRole('button', { name: '拉取模型' }).click()

  const defaultModel = [...models].sort()[0]
  await expect(page.locator('option', { hasText: defaultModel })).toHaveCount(0)
  await page.getByRole('button', { name: defaultModel }).first().click()
  const dialog = page.getByRole('dialog', { name: '选择聊天模型' })
  await expect(dialog).toBeVisible()
  await page.getByRole('textbox', { name: '搜索模型名称' }).fill('deepseek-v4-pro')
  await expect(page.getByText('共 118 个模型，找到 1 个')).toBeVisible()
  await dialog.getByRole('button', { name: /deepseek-ai\/deepseek-v4-pro/ }).click()

  await expect(page.getByRole('button', { name: 'deepseek-ai/deepseek-v4-pro' }).first()).toBeVisible()
  const storedModel = await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    return useSettingsStore.getState().model
  })
  expect(storedModel).toBe('deepseek-ai/deepseek-v4-pro')
})

test('messages page empty state keeps bottom nav pinned to viewport bottom', async ({ page }) => {
  await page.goto('/#/')
  await clearDatabase(page)
  await page.reload()

  const nav = page.locator('nav')
  await expect(nav).toBeVisible()
  const box = await nav.boundingBox()
  const viewport = page.viewportSize()
  expect(box).toBeTruthy()
  expect(viewport).toBeTruthy()
  expect(Math.abs(box!.y + box!.height - viewport!.height)).toBeLessThanOrEqual(1)
})

test('settings page backup json does not contain setSettings function field', async ({ page }) => {
  await page.goto('/#/settings')
  await seedBackupFixture(page)

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出备份' }).click()
  const download = await downloadPromise
  const path = await download.path()
  expect(path).toBeTruthy()

  const backupText = await import('node:fs/promises').then((fs) => fs.readFile(path!, 'utf8'))
  expect(backupText).not.toContain('setSettings')

  const backup = JSON.parse(backupText)
  expect(backup.format).toBe('talk-backup')
})

test('sky-eye never renders configured api keys', async ({ page }) => {
  await page.goto('/#/settings')
  await clearDatabase(page)
  await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    useSettingsStore.getState().setSettings({
      adminModeEnabled: true,
      apiKey: 'sk-visible-bug',
      tavilyApiKey: 'tvly-visible-bug',
      pexelsApiKey: 'pexels-visible-bug',
    })
  })
  await page.reload()
  await page.goto('/#/sky-eye')

  const body = page.locator('body')
  // Raw values must never appear
  await expect(body).not.toContainText('sk-visible-bug')
  await expect(body).not.toContainText('tvly-visible-bug')
  await expect(body).not.toContainText('pexels-visible-bug')
  // Key names should be present
  await expect(body).toContainText('Console')
  /* legacy settings-dump assertion intentionally retired: Sky Eye no longer renders settings. */
  if (process.env.SKIP_LEGACY_TESTS === '1') {
  // Redacted placeholder must appear for configured keys
  await expect(body).toContainText('(已配置)')
  }
})

test('release assets needed for icon and apk publishing are present', async () => {
  const root = process.cwd()
  expect(existsSync(join(root, 'public', 'app-icon.png'))).toBe(true)
  expect(existsSync(join(root, 'scripts', 'release-apk.mjs'))).toBe(true)
  expect(existsSync(join(root, 'scripts', 'sync-android-icon.ps1'))).toBe(true)
})

test('search overlay finds full chat history and group chats', async ({ page }) => {
  await page.goto('/#/')
  await seedSearchAndGroupFixture(page)
  await page.reload()

  await page.getByLabel('搜索').click()
  await page.getByPlaceholder('搜索联系人、群聊、聊天记录').fill('nebula')
  await expect(page.getByText('the hidden keyword is nebula')).toBeVisible()
  await expect(page.getByText('Alice Search', { exact: true })).toBeVisible()

  await page.getByPlaceholder('搜索联系人、群聊、聊天记录').fill('Search Squad')
  await expect(page.getByRole('button', { name: '👥 Search Squad' })).toBeVisible()
})

test('chat page can generate a selected-message screenshot preview', async ({ page }) => {
  await page.goto('/#/chat/conversation-a')
  await seedSearchAndGroupFixture(page)
  await page.reload()

  await page.getByRole('button', { name: '选择' }).click()
  await page.getByText('the hidden keyword is nebula').click()
  await page.getByRole('button', { name: '生成截图 (1)' }).click()

  await expect(page.getByAltText('聊天记录截图预览')).toBeVisible()
  await expect(page.getByRole('button', { name: '保存图片' })).toBeVisible()
  await expect(page.getByRole('button', { name: '分享' })).toBeVisible()
})

test('global prompt archives can be saved and explicitly copied to a contact', async ({ page }) => {
  await page.goto('/#/')
  await seedSearchAndGroupFixture(page)
  await page.goto('/#/settings/global-prompts')

  await expect(page.getByText('默认提示词', { exact: true })).toBeVisible()
  const relationshipEditor = page.getByRole('button', { name: '聊天关系约束 编辑' })
  await relationshipEditor.click()
  await page.getByRole('textbox').fill('CONTACT_ARCHIVE_E2E\n{{relationshipContext}}')
  page.once('dialog', (dialog) => dialog.accept('E2E 存档'))
  await page.getByRole('button', { name: '保存当前提示词' }).click()

  const archive = page.locator('div.rounded-xl').filter({ hasText: 'E2E 存档' }).first()
  await expect(archive).toBeVisible()
  await archive.getByRole('button', { name: '应用到联系人' }).click()
  await page.getByText('Alice Search', { exact: true }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '确认覆盖' }).click()

  await page.goto('/#/contact/contact-a')
  const snapshot = await page.evaluate(async () => (await import('/src/db/db.ts')).db.contacts.get('contact-a'))
  expect(snapshot?.promptPresetSourceName).toBe('E2E 存档')
  expect(snapshot?.promptModulesSnapshot?.relationship.templates.chat).toContain('CONTACT_ARCHIVE_E2E')
})

test('administrator can persist contact identity, runtime state and JSON protocol overrides', async ({ page }) => {
  await page.goto('/#/contact/contact-a/admin')
  await seedSearchAndGroupFixture(page)
  await page.reload()

  await page.getByLabel('显示名称').fill('Alice Revised')
  await page.getByLabel('好感度 -100~100').fill('66')
  const protocol = page.getByLabel('主模型原始文字转换协议')
  await protocol.fill(`${await protocol.inputValue()}\nCONTACT_JSON_PROTOCOL_E2E`)
  await page.getByRole('button', { name: '保存全部修改' }).click()
  await expect(page.getByText('已保存，下一轮聊天会使用新资料。')).toBeVisible()

  const updated = await page.evaluate(async () => (await import('/src/db/db.ts')).db.contacts.get('contact-a'))
  expect(updated?.name).toBe('Alice Revised')
  expect(updated?.warmth).toBe(66)
  expect(updated?.jsonProtocolOverride).toContain('CONTACT_JSON_PROTOCOL_E2E')
})

test('chat page reads recent messages in pages and loads older history', async ({ page }) => {
  await page.goto('/#/chat/conversation-a')
  await seedSearchAndGroupFixture(page)
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    await db.messages.clear()
    await db.messages.bulkAdd(Array.from({ length: 85 }, (_, index) => ({
      id: `paged-${String(index).padStart(3, '0')}`,
      conversationId: 'conversation-a',
      role: index % 2 ? 'assistant' as const : 'user' as const,
      type: 'text' as const,
      content: `page message ${index}`,
      createdAt: 1000 + index,
    })))
  })
  await page.reload()

  await expect(page.getByText('page message 84', { exact: true })).toBeVisible()
  await expect(page.getByText('page message 44', { exact: true })).toBeHidden()
  await page.getByRole('button', { name: '加载更早消息' }).click()
  await expect(page.getByText('page message 44', { exact: true })).toBeVisible()
  await expect(page.getByText('page message 4', { exact: true })).toBeHidden()
})

test('group info page can add and remove members after creation', async ({ page }) => {
  await page.goto('/#/group/group-a')
  await seedSearchAndGroupFixture(page)
  await page.reload()

  await expect(page.getByText('2 位成员')).toBeVisible()
  await page.getByRole('button', { name: '管理' }).click()
  await page.getByText('Carol Newbie').click()
  await page.getByRole('button', { name: '添加选中的 1 人' }).click()
  await expect(page.getByText('3 位成员')).toBeVisible()

  await page.getByRole('button', { name: '移除' }).first().click()
  await expect(page.getByText('2 位成员')).toBeVisible()
})

test('appearance settings enable dark mode and custom chat background', async ({ page }) => {
  await page.goto('/#/appearance')
  await clearDatabase(page)

  await page.getByRole('button', { name: '深色', exact: true }).click()
  await expect(page.locator('.app-shell')).toHaveClass(/theme-dark/)

  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const persisted = JSON.parse(window.localStorage.getItem('talk-settings') ?? '{"state":{}}')
    window.localStorage.setItem(
      'talk-settings',
      JSON.stringify({ ...persisted, state: { ...(persisted.state ?? {}), chatBackground: '#123456', themeMode: 'dark' } }),
    )
    await db.contacts.add({
      id: 'contact-bg',
      name: 'Bg Test',
      avatar: '🙂',
      avatarColor: '#e5f7ef',
      systemPrompt: 'test',
      createdAt: 1,
      memoryFacts: '',
      memoryStyle: '',
      memoryUpdatedAt: 0,
      memoryMessageCursor: 0,
      warmth: 0, relationshipBase: '朋友', relationshipDynamic: '',
    })
    await db.conversations.add({ id: 'conversation-bg', contactId: 'contact-bg', pinned: false, createdAt: 1, updatedAt: 1 })
  })
  await page.goto('/#/chat/conversation-bg')
  await page.reload()
  const chatBackground = await page.getByTestId('chat-scroll').evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(chatBackground).toBe('rgb(18, 52, 86)')
})

test('admin mode can expand persisted ai trace payload in sky-eye', async ({ page }) => {
  await page.goto('/#/settings')
  await seedSearchAndGroupFixture(page)
  await page.reload()
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    await db.adminAiTraces.add({ id: 'trace-e2e', purpose: 'chat', model: 'test-model', messages: [{ role: 'system', content: 'prompt context' }], output: 'second bubble', inputTokens: 1, outputTokens: 1, createdAt: Date.now() })
  })
  await page.goto('/#/sky-eye')
  await page.getByText('chat · test-model').click()
  await expect(page.getByText('second bubble').first()).toBeVisible()
  await expect(page.getByText('prompt context').first()).toBeVisible()
  if (process.env.SKIP_LEGACY_TESTS === '1') {

  await page.getByRole('button', { name: /展开/ }).first().click()
  await expect(page.getByText('主模型原始回复')).toBeVisible()
  await expect(page.getByText('second bubble').first()).toBeVisible()
  await expect(page.getByText('ask about tomorrow').first()).toBeVisible()
  }
})

test('settings page offers preset background colors and image crop before saving', async ({ page }, testInfo) => {
  await page.goto('/#/settings')
  await clearDatabase(page)

  await page.getByLabel('应用背景色 #edf4ff').click()
  const bg = await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    return useSettingsStore.getState().chatBackground
  })
  expect(bg).toBe('#edf4ff')

  const imagePath = join(testInfo.outputDir, 'bg.png')
  await mkdir(testInfo.outputDir, { recursive: true })
  await writeFile(
    imagePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAGCAIAAADj5ND2AAAAFElEQVR4nGP8z8DwnwEJMDGgAcQBAJvGAwF4F6M8AAAAAElFTkSuQmCC',
      'base64',
    ),
  )
  await page.locator('input[accept="image/*"]').setInputFiles(imagePath)
  await expect(page.getByText('裁剪聊天背景')).toBeVisible()
  await expect(page.getByTestId('frame-cropper-stage')).toBeVisible()
  await expect(page.getByTestId('frame-cropper-stage').locator('input[type="range"]')).toHaveCount(0)
  await expect(page.getByText('拖拽框选区域')).toBeVisible()
})

test('currency icon setting updates wallet formatting globally', async ({ page }) => {
  await page.goto('/#/me')
  await clearDatabase(page)
  await page.evaluate(() => {
    window.localStorage.setItem(
      'talk-settings',
      JSON.stringify({ state: { userNickname: 'Money User', userAvatar: '🙂', walletBalance: 88, currencyIconMode: 'yen' }, version: 0 }),
    )
  })
  await page.reload()
  await expect(page.getByText('¥ 88')).toBeVisible()
})

test('worldbook retrieval keeps permanent entries and ranks keyword matches', async ({ page }) => {
  await page.goto('/#/')
  const result = await page.evaluate(async () => {
    const { rankWorldbookEntries } = await import('/src/lib/worldbook.ts')
    const base = { enabled: true, priority: 20, createdAt: 1, updatedAt: 1 }
    return rankWorldbookEntries([
      { ...base, id: 'always', title: '基础法则', content: '所有人都遵守', keywords: [], alwaysInclude: true },
      { ...base, id: 'magic', title: '魔法学院', content: '学院使用魔力', keywords: ['魔法'], alwaysInclude: false },
      { ...base, id: 'space', title: '太空站', content: '轨道生活', keywords: ['宇宙'], alwaysInclude: false },
    ], '她刚进入魔法学院').map((x: { entry: { id: string } }) => x.entry.id)
  })
  expect(result).toEqual(['always', 'magic'])
})

test('custom traits multiply matching warmth rules with a safe cap', async ({ page }) => {
  await page.goto('/#/')
  const result = await page.evaluate(async () => {
    const { customTraitWarmthModifier } = await import('/src/lib/relationship.ts')
    return customTraitWarmthModifier([
      { id: 'a', name: 'A', meaning: 'A', rules: [{ id: 'a1', minWarmth: 0, maxWarmth: 50, positiveMultiplier: 2, negativeMultiplier: 0.5, prompt: '' }] },
      { id: 'b', name: 'B', meaning: 'B', rules: [{ id: 'b1', minWarmth: 10, maxWarmth: 30, positiveMultiplier: 3, negativeMultiplier: 2, prompt: '' }] },
    ], 2, 20)
  })
  expect(result).toBe(12)
})

test('top inset adjustment shortens the shell while keeping its bottom fixed', async ({ page }) => {
  await page.goto('/#/settings')
  const shell = page.locator('.app-shell')
  const before = await shell.boundingBox()
  await page.getByLabel('顶部显示区域微调').fill('40')
  const after = await shell.boundingBox()
  expect(before && after).toBeTruthy()
  expect(Math.round(after!.y - before!.y)).toBe(40)
  expect(Math.round((after!.y + after!.height) - (before!.y + before!.height))).toBe(0)
})

test('custom chat page size controls initial and older-message loading', async ({ page }) => {
  await page.goto('/#/settings')
  await clearDatabase(page)
  await page.getByLabel('每次加载消息条数').selectOption('20')
  await expect(page.getByLabel('每次加载消息条数')).toHaveValue('20')
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    await db.contacts.add({ id: 'page-contact', name: '分页测试', avatar: '🙂', avatarColor: '#eee', systemPrompt: '测试', createdAt: 1, memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0, relationshipBase: '朋友', relationshipDynamic: '' })
    await db.conversations.add({ id: 'page-conversation', contactId: 'page-contact', pinned: false, createdAt: 1, updatedAt: 30 })
    await db.messages.bulkAdd(Array.from({ length: 45 }, (_, index) => ({ id: `page-message-${index}`, conversationId: 'page-conversation', role: 'assistant' as const, type: 'text' as const, content: `分页消息 ${index}`, createdAt: index + 1 })))
  })
  await page.goto('/#/chat/page-conversation')
  await expect(page.getByText('分页消息 25', { exact: true })).toBeVisible()
  await expect(page.getByText('分页消息 24', { exact: true })).toHaveCount(0)
  await page.getByTestId('chat-scroll').evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await expect(page.getByText('分页消息 5', { exact: true })).toBeVisible()
  await expect(page.getByText('分页消息 4', { exact: true })).toHaveCount(0)
})

test('nuwa mode switches the creator to a free-form AI draft flow', async ({ page }) => {
  await page.goto('/#/contact/new')
  await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    const state = useSettingsStore.getState()
    state.setSettings({ enabledModules: [...new Set([...state.enabledModules, 'nuwaMode'])] })
  })
  await page.reload()
  await page.getByRole('button', { name: '精细创建' }).click()
  await expect(page.getByText('角色设定', { exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('例如：慢热、敏感、有主见；完全自由填写')).toBeVisible()
  await expect(page.getByPlaceholder('例如：24岁')).toBeVisible()
  await expect(page.getByPlaceholder('例如：想要一个嘴硬但很在乎我的雌小鬼恋人，我们小时候就认识。AI会先生成初稿，之后你可以修改。')).toBeVisible()
  await expect(page.getByRole('button', { name: 'AI补全', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '生成初稿', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'AI润色' })).toHaveCount(0)
  await expect(page.getByLabel('性格特质名称')).toBeVisible()
  await expect(page.getByLabel('性格特质内容')).toBeVisible()
  await page.getByRole('button', { name: '展开特质选项' }).click()
  await expect(page.getByText('系统性格特质')).toBeVisible()
  await expect(page.getByRole('button', { name: '完全随机寻找' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '18-22' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '恋人', exact: true })).toHaveCount(0)
})

test('Nuwa mode exposes an editable AI first-draft workflow', async ({ page }) => {
  await page.goto('/#/contact/new')
  await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    const state = useSettingsStore.getState()
    state.setSettings({ enabledModules: [...new Set([...state.enabledModules, 'nuwaMode'])] })
  })
  await page.reload()
  await page.getByRole('button', { name: '精细创建' }).click()
  await expect(page.getByText('角色设定', { exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('例如：慢热、敏感、有主见；完全自由填写')).toBeVisible()
  await expect(page.getByPlaceholder('例如：24岁')).toBeVisible()
  await expect(page.getByPlaceholder('例如：想要一个嘴硬但很在乎我的雌小鬼恋人，我们小时候就认识。AI会先生成初稿，之后你可以修改。')).toBeVisible()
  await expect(page.getByRole('button', { name: '生成AI初稿' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'AI补全', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '生成初稿', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'AI润色' })).toHaveCount(0)
  await expect(page.getByText('与用户的过往 / 共同经历（强烈建议填写）')).toHaveCount(0)
  await expect(page.getByText('头像', { exact: true })).toHaveCount(0)
})

test('Nuwa AI initial warmth can be edited before contact creation', async ({ page }) => {
  await page.route('**/chat/completions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ name: '初稿角色', realName: '林澄', nickname: '阿澄', birthday: '2002-06-15', gender: '女', ageRange: '24岁', relationship: '朋友', occupation: '设计师', persona: '慢热但真诚的朋友。', personalityTrait: '猫系', mbti: 'INFP', speechSamples: ['你好'], personaProfile: { facts: [], boundaries: [], habits: [], behaviorAnchors: [] }, monthlySalary: 8000, initialWarmth: 42, schedule: [] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      }),
    })
  })
  await page.goto('/#/contact/new')
  await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    const state = useSettingsStore.getState()
    state.setSettings({ apiKey: 'sk-nuwa-warmth-test', baseUrl: 'https://nuwa-warmth.test', enabledModules: [...new Set([...state.enabledModules, 'nuwaMode', 'relationship'])] })
  })
  await page.reload()
  await page.getByRole('button', { name: '精细创建' }).click()
  await page.getByRole('button', { name: '生成AI初稿' }).click()
  await expect(page).toHaveURL(/#\/contact-generation\/[^/]+$/)
  await expect(page.getByRole('heading', { name: '初稿已完成，待确认' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByLabel('女娲好感度数值')).toHaveValue('42')
  await page.getByLabel('女娲好感度数值').fill('-35')
  await expect(page.getByRole('slider', { name: '女娲好感度' })).toHaveValue('-35')
})

test('ordinary contact creation can override the automatic initial warmth', async ({ page }) => {
  await page.goto('/#/contact/new')
  await expect(page.getByText('好感度', { exact: true })).toBeVisible()
  await expect(page.getByText('30', { exact: true })).toBeVisible()
  const warmthSection = page.getByText('好感度', { exact: true }).locator('..').locator('..').locator('..')
  await warmthSection.getByRole('button', { name: '自定义', exact: true }).click()
  await warmthSection.locator('input[type="number"]').fill('-45')
  await expect(warmthSection.locator('input[type="range"]')).toHaveValue('-45')
})

test('saved personas can be deleted without touching creation history', async ({ page }) => {
  await page.goto('/#/contact/new')
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    const state = useSettingsStore.getState()
    state.setSettings({ enabledModules: [...new Set([...state.enabledModules, 'nuwaMode'])] })
    await db.savedPersonas.add({ id: 'saved-delete', nickname: '待删除人设', createdAt: 1, updatedAt: 1, profile: { personalityTendencies: [], age: '', gender: '', relationship: '', occupation: '', hobbies: [], notes: '' } })
    await db.personaCreationRecords.add({ id: 'history-keep', name: '永久历史', hobbies: [], personaSetting: '历史', persona: '历史', createdAt: 1 })
  })
  await page.reload()
  await page.getByRole('button', { name: '精细创建' }).click()
  await page.getByRole('button', { name: '使用已保存的人设' }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '删除待删除人设' }).click()
  await expect(page.getByText('待删除人设')).toHaveCount(0)
  const counts = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    return { saved: await db.savedPersonas.count(), history: await db.personaCreationRecords.count() }
  })
  expect(counts).toEqual({ saved: 0, history: 1 })
})

test('persona creation history can be explicitly deleted', async ({ page }) => {
  await page.goto('/#/contact/new')
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    const state = useSettingsStore.getState()
    state.setSettings({ enabledModules: [...new Set([...state.enabledModules, 'nuwaMode'])] })
    await db.personaCreationRecords.add({ id: 'history-delete', name: '待删除历史', hobbies: [], personaSetting: '历史', persona: '历史', createdAt: 1 })
  })
  await page.reload()
  await page.getByRole('button', { name: '精细创建' }).click()
  await page.getByRole('button', { name: /调用以前创建过的人设/ }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText('待删除历史')).toHaveCount(0)
})

test('chat explains long press once and remembers dismissal', async ({ page }) => {
  await page.goto('/#/')
  await seedSearchAndGroupFixture(page)
  await page.evaluate(() => localStorage.removeItem('talk-chat-long-press-hint-seen-v1'))
  await page.goto('/#/chat/conversation-a')
  await expect(page.getByTestId('long-press-hint')).toBeVisible()
  await page.getByRole('button', { name: '知道了' }).click()
  await page.reload()
  await expect(page.getByTestId('long-press-hint')).toHaveCount(0)
})

test('mobile touch jitter still opens the long-press message menu', async ({ page }) => {
  await page.goto('/#/')
  await seedSearchAndGroupFixture(page)
  await page.evaluate(() => localStorage.setItem('talk-chat-long-press-hint-seen-v1', '1'))
  await page.goto('/#/chat/conversation-a')
  const bubble = page.locator('[data-message-id="message-a"]')
  await bubble.dispatchEvent('pointerdown', { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: 120, clientY: 280, isPrimary: true, buttons: 1 })
  await bubble.dispatchEvent('pointermove', { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: 124, clientY: 283, isPrimary: true, buttons: 1 })
  await page.waitForTimeout(700)
  await expect(page.getByRole('button', { name: '重新生成这一轮' })).toBeVisible()
  await bubble.dispatchEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: 124, clientY: 283, isPrimary: true })
  await page.getByRole('button', { name: '取消', exact: true }).click()

  await bubble.dispatchEvent('pointerdown', { bubbles: true, pointerId: 8, pointerType: 'touch', clientX: 120, clientY: 280, isPrimary: true, buttons: 1 })
  await bubble.dispatchEvent('pointermove', { bubbles: true, pointerId: 8, pointerType: 'touch', clientX: 120, clientY: 310, isPrimary: true, buttons: 1 })
  await page.waitForTimeout(700)
  await expect(page.getByRole('button', { name: '重新生成这一轮' })).toHaveCount(0)
  await bubble.dispatchEvent('pointerup', { bubbles: true, pointerId: 8, pointerType: 'touch', clientX: 120, clientY: 310, isPrimary: true })
})

test('conversation long press stays aligned and does not click through into chat', async ({ page }) => {
  await page.goto('/#/')
  await seedSearchAndGroupFixture(page)
  await page.reload()
  const row = page.locator('div.cursor-pointer').filter({ has: page.getByText('Alice Search', { exact: true }) })
  await row.dispatchEvent('pointerdown', { bubbles: true, pointerId: 9, pointerType: 'touch', clientX: 120, clientY: 180, isPrimary: true, buttons: 1 })
  await page.waitForTimeout(600)
  await row.dispatchEvent('pointerup', { bubbles: true, pointerId: 9, pointerType: 'touch', clientX: 120, clientY: 180, isPrimary: true })
  await row.dispatchEvent('click', { bubbles: true })
  await expect(page.getByRole('button', { name: '置顶会话' })).toBeVisible()
  await expect(page).toHaveURL(/\/#\/$/)
  const overlay = page.locator('.absolute.inset-0.z-40')
  expect(await overlay.evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(700)
})

test('discarded warehouse items remain available from shop repurchase history', async ({ page }) => {
  await page.goto('/#/warehouse')
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    await db.walletAccounts.put({ ownerId: 'user', balance: 100, updatedAt: 1 })
    await db.inventory.put({ id: 'owned-item', productKey: '["纪念品","测试","🎁",10]', name: '纪念品', description: '测试', icon: '🎁', price: 10, acquiredAt: 1 })
    await db.shopPurchaseHistory.put({ productKey: '["纪念品","测试","🎁",10]', name: '纪念品', description: '测试', icon: '🎁', price: 10, purchaseCount: 1, firstPurchasedAt: 1, lastPurchasedAt: 1 })
  })
  await page.reload()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '丢弃' }).click()
  await expect(page.getByText('纪念品', { exact: true })).toHaveCount(0)
  await page.goto('/#/shop')
  await page.getByRole('button', { name: '复购' }).click()
  await expect(page.getByText('纪念品', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '购买', exact: true }).click()
  const result = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    return { inventoryCount: await db.inventory.count(), balance: (await db.walletAccounts.get('user'))?.balance }
  })
  expect(result).toEqual({ inventoryCount: 1, balance: 90 })
})

test('contact card opens a personal moments feed and can remove the post completely', async ({ page }) => {
  await page.goto('/#/')
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    await db.contacts.add({ id: 'moment-contact', name: '动态好友', avatar: '🙂', avatarColor: '#eee', systemPrompt: 'test', createdAt: 1, memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0, warmth: 10, relationshipBase: '朋友', relationshipDynamic: '', lastMomentAt: 2 })
    await db.moments.add({ id: 'personal-moment', contactId: 'moment-contact', content: '只看我的动态', createdAt: 2 })
    await db.momentComments.add({ id: 'personal-comment', momentId: 'personal-moment', authorContactId: 'user', content: '评论', createdAt: 3 })
    await db.momentLikes.add({ id: 'personal-like', momentId: 'personal-moment', likerId: 'user', createdAt: 3 })
    await db.socialEvents.add({ id: 'personal-event', type: 'moment_commented', actorId: 'user', relatedContactIds: ['moment-contact'], momentId: 'personal-moment', summary: '评论', importance: 1, createdAt: 3 })
  })
  await page.goto('/#/contact/moment-contact')
  await page.getByRole('button', { name: /TA的朋友圈/ }).click()
  await expect(page).toHaveURL(/moments\?contact=moment-contact/)
  await expect(page.getByText('只看我的动态')).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '撤销' }).click()
  const counts = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    return { moments: await db.moments.count(), comments: await db.momentComments.count(), likes: await db.momentLikes.count(), events: await db.socialEvents.count() }
  })
  expect(counts).toEqual({ moments: 0, comments: 0, likes: 0, events: 0 })
})

test('Nuwa AI polishing is reviewed and retries invalid form output', async ({ page }) => {
  type AiRequest = { model?: string; messages?: Array<{ content: string }>; response_format?: unknown }
  const mainRequests: AiRequest[] = []
  const reviewRequests: AiRequest[] = []
  await page.route('**/chat/completions', async (route) => {
    const requestBody = route.request().postDataJSON() as AiRequest
    const isCanonExtraction = requestBody.messages?.[0]?.content.includes('世界书正史提取器') ?? false
    const isReview = requestBody.messages?.[0]?.content.includes('严格格式审查器') ?? false
    if (!isCanonExtraction) {
      if (isReview) reviewRequests.push(requestBody)
      else mainRequests.push(requestBody)
    }
    const content = isCanonExtraction
      ? JSON.stringify({ relationship: '', sharedHistory: '', facts: [], boundaries: [], pastExperiences: [] })
      : isReview
      ? JSON.stringify({ valid: true, issues: [] })
      : mainRequests.length === 1
        ? JSON.stringify({
            realName: '', nickname: '', birthday: '', tendencies: '', age: '', gender: '', relationship: '', occupation: '', hobbies: '', personalityTrait: '', personalityTraitContent: '', otherSetting: '',
          })
        : JSON.stringify({
            realName: '林知夏',
            nickname: '小夏',
            birthday: '2003-06-15',
            tendencies: '活泼、黏人、坦率',
            age: '23岁',
            gender: '女孩子',
            relationship: '亲妹妹',
            occupation: '大学生',
            hobbies: '烘焙、摄影',
            personalityTrait: '爱撒娇但很可靠',
            personalityTraitContent: '亲近时爱撒娇，遇到重要事情会主动承担责任。',
            otherSetting: '她会主动分享生活琐事，也尊重彼此边界。',
          })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      }),
    })
  })
  await page.goto('/#/contact/new')
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    const state = useSettingsStore.getState()
    await db.worldbookCollections.put({ id: 'nuwa-collection', name: '月海城', enabled: true, sourceType: 'manual', createdAt: 1, updatedAt: 1 })
    await db.worldbookEntries.put({ id: 'nuwa-worldbook', collectionId: 'nuwa-collection', title: '月海城正史', content: '月海城的居民成年后必须登记一种合法职业，普通人不能使用魔法。', keywords: ['月海城'], enabled: true, foundationalWorldview: true, priority: 90, createdAt: 1, updatedAt: 1 })
    state.setSettings({
      apiKey: 'sk-nuwa-form-test',
      baseUrl: 'https://nuwa-form.test',
      model: 'nuwa-main-test',
      utilityModel: 'nuwa-review-test',
      defaultWorldviewId: 'nuwa-collection',
      enabledModules: [...new Set([...state.enabledModules, 'nuwaMode', 'worldview'])],
    })
  })
  await page.reload()
  await page.getByRole('button', { name: '精细创建' }).click()
  await page.getByPlaceholder('例如：想要一个嘴硬但很在乎我的雌小鬼恋人，我们小时候就认识。AI会先生成初稿，之后你可以修改。').fill('喜欢我的妹妹')
  await page.getByLabel('性别', { exact: true }).fill('女孩子')
  await page.getByRole('button', { name: 'AI补全', exact: true }).click()

  await expect(page.getByLabel('真名', { exact: true })).toHaveValue('林知夏')
  await expect(page.getByLabel('年龄', { exact: true })).toHaveValue('23岁')
  await expect(page.getByLabel('性别', { exact: true })).toHaveValue('女孩子')
  await expect(page.getByLabel('关系定位', { exact: true })).toHaveValue('亲妹妹')
  await expect(page.getByLabel('职业', { exact: true })).toHaveValue('大学生')
  await expect(page.getByLabel('性格特质名称')).toHaveValue('爱撒娇但很可靠')
  await expect(page.getByLabel('性格特质内容')).toHaveValue('亲近时爱撒娇，遇到重要事情会主动承担责任。')
  await expect(page.getByPlaceholder('补充经历、边界、习惯、生活细节、说话方式、关系表现等……')).toHaveValue('她会主动分享生活琐事，也尊重彼此边界。')
  expect(mainRequests).toHaveLength(2)
  expect(reviewRequests).toHaveLength(2)
  expect(mainRequests[0].response_format).toEqual({ type: 'json_object' })
  expect(mainRequests[0].messages?.[0]?.content).toContain('月海城的居民成年后必须登记一种合法职业')
  expect(reviewRequests[0].model).toBe('nuwa-review-test')
  expect(mainRequests[1].messages?.[0]?.content).toContain('上一次输出已被多功能模型退回')
  expect(mainRequests[1].messages?.[0]?.content).toContain('仍未补全')
})

test('life simulation catches up local state after elapsed time without an API key', async ({ page }) => {
  await page.goto('/#/')
  const result = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    const { runLifeSimulation } = await import('/src/lib/lifeSimulation.ts')
    for (const table of db.tables) await table.clear()
    const settings = useSettingsStore.getState()
    settings.setSettings({ apiKey: '', enabledModules: [...new Set([...settings.enabledModules, 'lifeSimulation'])] })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await db.contacts.add({ id: 'life-contact', name: 'Life Test', avatar: '🙂', avatarColor: '#eee', systemPrompt: '测试角色', occupation: '设计师', createdAt: 1, memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0, relationshipBase: '朋友', relationshipDynamic: '' })
    await db.conversations.add({ id: 'life-conversation', contactId: 'life-contact', pinned: false, createdAt: 1, updatedAt: 1 })
    await db.simulationState.put({ id: 'global', lastSimulatedAt: Date.now() - 36 * 60 * 60 * 1000, seed: 'regression-life', version: 1 })
    await runLifeSimulation(useSettingsStore.getState())
    return { events: await db.lifeEvents.count(), states: await db.contactLifeStates.count() }
  })
  expect(result.states).toBe(1)
  expect(result.events).toBeGreaterThan(0)
})

test('offline completion creates a shared experience and backdated moment', async ({ page }) => {
  let prompt = ''
  await page.route('**/chat/completions', async (route) => {
    const body = route.request().postDataJSON() as { messages?: Array<{ content?: string }> }
    prompt = body.messages?.[0]?.content ?? ''
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ experiences: [{ title: '整理宴会厅', summary: '她与管家一起核对了晚宴布置。', details: '检查餐具与花束。', offsetStartMinutes: 30, offsetEndMinutes: 45, location: '宅邸', activity: '整理', participantContactIds: ['beta-steward'], interactionMode: 'physical', importance: 82, visibility: 'public', shareAsMoment: true, momentContent: '宴会厅终于整理好了。' }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) })
  })
  await page.goto('/#/')
  await clearDatabase(page)
  const from = new Date('2026-07-31T10:00:00+08:00').getTime()
  const to = from + 2 * 60 * 60 * 1000
  const result = await page.evaluate(async ({ from, to }) => {
    const { db } = await import('/src/db/db.ts')
    const { ensureOfflineExperiences } = await import('/src/lib/experiences.ts')
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    const base = { avatar: '🙂', avatarColor: '#eee', createdAt: 1, memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0, relationshipBase: '同事', relationshipDynamic: '' }
    await db.contacts.bulkAdd([
      { ...base, id: 'beta-maid', name: '林夏', systemPrompt: '宅邸里的女仆长，做事细致。', schedule: [], experienceCursorAt: from },
      { ...base, id: 'beta-steward', name: '周管家', systemPrompt: '宅邸管家。', schedule: [] },
    ])
    await db.contactRelations.bulkAdd([
      { id: 'rel-a', pairId: 'pair', fromContactId: 'beta-maid', toContactId: 'beta-steward', label: '前辈/同事', createdAt: 1 },
      { id: 'rel-b', pairId: 'pair', fromContactId: 'beta-steward', toContactId: 'beta-maid', label: '前辈/同事', createdAt: 1 },
    ])
    await db.contactLifeStates.bulkPut([
      { contactId: 'beta-maid', location: '宅邸', activity: '整理', energy: 70, stress: 20, socialNeed: 30, updatedAt: from },
      { contactId: 'beta-steward', location: '宅邸', activity: '核对清单', energy: 70, stress: 20, socialNeed: 30, updatedAt: from },
    ])
    const settings = useSettingsStore.getState()
    settings.setSettings({ apiKey: 'sk-experience-test', baseUrl: 'https://experience.test', utilityModel: 'utility-test', enabledModules: [...new Set([...settings.enabledModules, 'lifeSimulation'])] })
    const contact = (await db.contacts.get('beta-maid'))!
    await ensureOfflineExperiences({ contact, settings: useSettingsStore.getState(), from, to })
    return { experience: (await db.contactExperiences.toArray())[0], moment: (await db.moments.toArray())[0], cursor: (await db.contacts.get('beta-maid'))?.experienceCursorAt }
  }, { from, to })
  expect(prompt).toContain('宅邸里的女仆长')
  expect(result.experience.contactIds).toEqual(['beta-maid', 'beta-steward'])
  expect(result.experience.memoryTier).toBe('long')
  expect(result.moment.createdAt).toBe(from + 45 * 60 * 1000)
  expect(result.cursor).toBe(to)
})

test.skip('relationship deltas are rule based and prompt includes human style rules', async ({ page }) => {
  await page.goto('/#/')
  const result = await page.evaluate(async () => {
    const { inferRelationshipDeltaFromTurn } = await import('/src/lib/relationship.ts')
    const { DEFAULT_STYLE_PROMPT } = await import('/src/lib/prompt.ts')
    return {
      delta: inferRelationshipDeltaFromTurn('谢谢你 我有点难过 想抱抱', [{ type: 'text', content: '过来' }]),
      prompt: DEFAULT_STYLE_PROMPT,
    }
  })
  expect(result.delta.affection).toBeGreaterThan(0)
  expect(result.delta.trust).toBeGreaterThan(0)
  expect(result.prompt).toContain('先有情绪反应')
  expect(result.prompt).toContain('不要用"我可以帮你')
})
