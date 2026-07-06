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

async function seedTodoRows(page: Page, count: number) {
  await page.evaluate(async (rowCount) => {
    const { db } = await import('/src/db/db.ts')
    for (const table of db.tables) await table.clear()
    await db.todos.bulkAdd(
      Array.from({ length: rowCount }, (_, index) => ({
        id: `todo-${index}`,
        title: `Long todo ${index + 1}`,
        done: false,
        createdAt: Date.now() + index,
        source: 'user' as const,
      })),
    )
  }, count)
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
        messages: [
          { type: 'text', content: 'first bubble' },
          { type: 'text', content: 'second bubble' },
        ],
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
  expect(backup.schemaVersion).toBe(1)
  expect(backup.settings.userNickname).toBe('Backup User')
  expect(backup.tables.contacts).toHaveLength(1)
  expect(backup.tables.conversations).toHaveLength(1)
  expect(backup.tables.messages).toHaveLength(1)
  expect(Object.keys(backup.tables)).toEqual(
    expect.arrayContaining(['stickers', 'todos', 'moments', 'knowledgeEntries', 'savedWorldviews']),
  )
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

test('long todo list keeps bottom navigation pinned to the viewport bottom', async ({ page }) => {
  await page.goto('/#/todos')
  await seedTodoRows(page, 45)
  await page.reload()

  const nav = page.locator('nav')
  await expect(nav).toBeVisible()
  const box = await nav.boundingBox()
  const viewport = page.viewportSize()
  expect(box).toBeTruthy()
  expect(viewport).toBeTruthy()
  expect(Math.abs(box!.y + box!.height - viewport!.height)).toBeLessThanOrEqual(1)
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

test('sky-eye settings dump shows all three api keys as redacted not raw values', async ({ page }) => {
  await page.goto('/#/sky-eye')
  await clearDatabase(page)
  await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    useSettingsStore.getState().setSettings({
      apiKey: 'sk-visible-bug',
      tavilyApiKey: 'tvly-visible-bug',
      pexelsApiKey: 'pexels-visible-bug',
    })
  })
  await page.reload()

  const body = page.locator('body')
  // Raw values must never appear
  await expect(body).not.toContainText('sk-visible-bug')
  await expect(body).not.toContainText('tvly-visible-bug')
  await expect(body).not.toContainText('pexels-visible-bug')
  // Key names should be present
  await expect(body).toContainText('apiKey')
  await expect(body).toContainText('tavilyApiKey')
  await expect(body).toContainText('pexelsApiKey')
  // Redacted placeholder must appear for configured keys
  await expect(body).toContainText('(已配置)')
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
  await page.goto('/#/settings')
  await clearDatabase(page)

  await page.getByLabel('切换暗色模式').click()
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

test('admin mode can expand assistant message debug json', async ({ page }) => {
  await page.goto('/#/chat/conversation-a')
  await seedSearchAndGroupFixture(page)
  await page.reload()

  await page.getByRole('button', { name: '展开 JSON' }).click()
  await expect(page.getByText('"raw"')).toBeVisible()
  await expect(page.getByText('"knowledgeQueries"')).toBeVisible()
  await expect(page.getByText('second bubble')).toBeVisible()
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
  await expect(page.locator('input[type="range"]')).toHaveCount(0)
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
