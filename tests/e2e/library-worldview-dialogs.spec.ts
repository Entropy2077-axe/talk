import { expect, test, type Page } from 'playwright/test'

async function clearRelevantData(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    await db.libraryItems.clear()
    await db.worldbookEntries.clear()
    await db.worldbookCollections.clear()
    await db.worldSnapshots.clear()
    await db.worldContactStates.clear()
  })
}

test('world picker stays in place, opens current backups, and batch-deletes only inactive worlds', async ({ page }) => {
  await page.goto('/#/save-load')
  await clearRelevantData(page)
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { createEmptyWorld } = await import('/src/lib/worldSnapshots.ts')
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    const activeId = useSettingsStore.getState().activeWorldId || useSettingsStore.getState().defaultWorldviewId
    if (activeId) await db.worldbookCollections.put({ id: activeId, name: '旧世界', enabled: true, sourceType: 'manual', createdAt: 1, updatedAt: 1 })
    await createEmptyWorld('世界 A')
    await createEmptyWorld('世界 B')
  })
  await page.getByRole('button', { name: /世界 A/ }).click()
  await expect(page.getByRole('button', { name: /世界 A.*当前世界/ })).toBeVisible()
  const worldCards = page.locator('button').filter({ hasText: '个备份' })
  await expect(worldCards.first()).toContainText('世界 A')
  await expect(worldCards.first()).toHaveClass(/border-\[var\(--ui-action\)\]/)
  await page.getByRole('button', { name: /世界 B/ }).click()
  await expect(page).toHaveURL(/#\/save-load$/)
  await expect(page.getByRole('button', { name: /世界 B.*当前世界/ })).toBeVisible()
  await expect(worldCards.first()).toContainText('世界 B')
  await page.getByRole('button', { name: /世界 B.*当前世界/ }).click()
  await expect(page).toHaveURL(/#\/save-load\/world\/[^/]+$/)

  await page.getByRole('button', { name: '返回' }).click()
  await page.getByRole('button', { name: '批量删除' }).click()
  await expect(page.getByRole('button', { name: /世界 B.*当前世界/ })).toBeDisabled()
  await page.getByRole('button', { name: /世界 A/ }).click()
  await page.getByRole('button', { name: '删除' }).click()
  await page.getByRole('dialog', { name: '删除世界' }).getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByRole('button', { name: /世界 A/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /世界 B.*当前世界/ })).toBeVisible()
})

test('desktop world editor remains in the settings section', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'talkDesktop', { configurable: true, value: {
      minimize() {}, toggleMaximize() {}, close() {}, isMaximized: async () => false, onMaximizedChange: () => () => {},
    } })
  })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/#/save-load')
  await clearRelevantData(page)
  await page.evaluate(async () => {
    const { createEmptyWorld } = await import('/src/lib/worldSnapshots.ts')
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    useSettingsStore.setState({ activeWorldId: undefined, defaultWorldviewId: undefined, worldSnapshotMigrationVersion: 3 })
    await createEmptyWorld('桌面世界')
  })
  await page.getByRole('button', { name: /桌面世界/ }).click()

  await page.getByRole('button', { name: '编辑当前世界观' }).click()
  await expect(page).toHaveURL(/#\/library\/world\/[^/]+$/)
  await expect(page.locator('.desktop-rail-button[title="设置"]')).toHaveClass(/active/)
  await expect(page.locator('.desktop-sidebar')).toContainText('个人与设置')
})

for (const viewport of [
  { label: 'PC', width: 1280, height: 800 },
  { label: 'Android viewport', width: 393, height: 851 },
]) {
  test(`${viewport.label}: worldview and manual library dialogs save data`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/#/save-load')
    await clearRelevantData(page)

    await page.getByRole('button', { name: '新建独立世界' }).click()
    const worldDialog = page.getByRole('dialog', { name: '新建独立世界' })
    await expect(worldDialog).toBeVisible()
    await worldDialog.getByPlaceholder('世界或分支名称').fill(`${viewport.label} 测试世界`)
    await worldDialog.getByRole('button', { name: '确认创建' }).click()

    await expect(page).toHaveURL(/#\/save-load$/)
    const world = await page.evaluate(async (name) => {
      const { db } = await import('/src/db/db.ts')
      return (await db.worldbookCollections.toArray()).find((item) => item.name === name)
    }, `${viewport.label} 测试世界`)
    expect(world?.sourceType).toBe('manual')

    await page.goto('/#/library')
    await page.getByRole('button', { name: '手写资料' }).click()
    const libraryDialog = page.getByRole('dialog', { name: '添加手写资料' })
    await expect(libraryDialog).toBeVisible()
    await libraryDialog.getByLabel('资料标题').fill(`${viewport.label} 测试资料`)
    await libraryDialog.getByLabel('资料正文').fill('这是一段跨平台保存测试正文。')
    await libraryDialog.getByLabel('关键词（可选）').fill('测试，跨平台、测试')
    await libraryDialog.getByRole('button', { name: '保存资料' }).click()

    await expect(page.getByText('已添加手写资料')).toBeVisible()
    await expect(page.getByText(`${viewport.label} 测试资料`)).toBeVisible()
    const libraryItem = await page.evaluate(async (title) => {
      const { db } = await import('/src/db/db.ts')
      return (await db.libraryItems.toArray()).find((item) => item.title === title)
    }, `${viewport.label} 测试资料`)
    expect(libraryItem?.content).toBe('这是一段跨平台保存测试正文。')
    expect(libraryItem?.keywords).toEqual(['测试', '跨平台'])
  })
}
