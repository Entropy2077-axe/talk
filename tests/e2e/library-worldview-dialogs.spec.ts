import { expect, test, type Page } from 'playwright/test'

async function clearRelevantData(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    await db.libraryItems.clear()
    await db.worldbookEntries.clear()
    await db.worldbookCollections.clear()
    await db.worldSnapshots.clear()
  })
}

for (const viewport of [
  { label: 'PC', width: 1280, height: 800 },
  { label: 'Android viewport', width: 393, height: 851 },
]) {
  test(`${viewport.label}: worldview and manual library dialogs save data`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/#/save-load')
    await clearRelevantData(page)

    await page.getByRole('button', { name: '新建世界观' }).click()
    const worldDialog = page.getByRole('dialog', { name: '新建世界观' })
    await expect(worldDialog).toBeVisible()
    await worldDialog.getByPlaceholder('世界名称').fill(`${viewport.label} 测试世界`)
    await worldDialog.getByRole('button', { name: '创建' }).click()

    await expect(page).toHaveURL(/#\/save-load\/world\/[^/]+$/)
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
