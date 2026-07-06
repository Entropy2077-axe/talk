import { expect, test, type Page } from 'playwright/test'
import { existsSync } from 'node:fs'
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
      relationship: { familiarity: 10, affection: 20, trust: 30, romance: 0, friction: 0 },
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

test('settings page exports a complete Talk backup json', async ({ page }) => {
  await page.goto('/#/settings')
  await seedBackupFixture(page)

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
  await page.locator('input[type="file"]').setInputFiles(backupPath!)
  await expect(page.getByText('备份已恢复')).toBeVisible()

  const restored = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    return {
      contacts: await db.contacts.toArray(),
      messages: await db.messages.toArray(),
      userNickname: useSettingsStore.getState().userNickname,
      apiKey: useSettingsStore.getState().apiKey,
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
