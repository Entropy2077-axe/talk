import { expect, test } from 'playwright/test'

test('large pixel map supports spaced custom places, notes, children and regeneration', async ({ page }) => {
  await page.goto('/#/locations')
  await expect(page.getByRole('heading', { name: '地点', exact: true })).toBeVisible()
  const mapView = page.getByTestId('location-map')
  await expect(mapView).toBeVisible()
  await expect(page.getByRole('button', { name: '地图图例' })).toBeVisible()
  await expect(page.getByRole('button', { name: '回到当前位置' })).toBeVisible()

  const initial = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const map = await db.worldMaps.get('active')
    const roots = (await db.locations.toArray()).filter((item) => item.mapBinding)
    return { width: map?.width, height: map?.height, generatorVersion: map?.generatorVersion, roots: roots.length, themes: map?.themeId }
  })
  expect(initial).toMatchObject({ width: 48, height: 48, generatorVersion: 4 })
  expect(initial.roots).toBeGreaterThan(20)

  await expect(page.getByRole('button', { name: '重新生成地图' })).toBeVisible()
  await expect(page.getByText(/点空白格显示/)).toBeVisible()

  const box = await mapView.boundingBox()
  expect(box).toBeTruthy()
  let found = false
  for (let y = 130; y < (box?.height ?? 650) - 100 && !found; y += 70) {
    for (let x = 35; x < (box?.width ?? 390) - 35 && !found; x += 55) {
      await mapView.click({ position: { x, y } })
      found = await page.getByRole('button', { name: '在这里新增地点' }).isVisible().catch(() => false)
    }
  }
  expect(found).toBe(true)
  await page.getByRole('button', { name: '在这里新增地点' }).click()
  await expect(page.getByRole('heading', { name: '新增地点' })).toBeVisible()
  await page.getByPlaceholder('例如：星河公寓').click()
  await page.getByPlaceholder('例如：星河公寓').fill('测试公寓')
  await expect(page.getByPlaceholder('例如：星河公寓')).toHaveValue('测试公寓')
  await page.getByPlaceholder('简单描述这个地点').fill('自动化测试创建的地点')
  await page.getByPlaceholder('记录这个地点的设定、用途或注意事项').fill('保留这条用户备注')
  await page.getByRole('button', { name: '住宅', exact: true }).click()
  await page.getByTitle('住宅 · 公寓').click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('button', { name: '测试公寓' })).toBeVisible()

  await page.getByRole('button', { name: '测试公寓' }).click()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByRole('button', { name: '添加子地点' }).click()
  await page.getByPlaceholder('子地点名称').fill('天台花园')
  await page.getByPlaceholder('子地点描述').fill('公寓顶层的小花园')
  await page.getByRole('button', { name: '保存子地点' }).click()
  await expect(page.getByRole('button', { name: /天台花园 公寓顶层的小花园/ })).toBeVisible()
  await page.getByRole('button', { name: '保存', exact: true }).click()

  const beforeRegenerate = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const map = await db.worldMaps.get('active')
    const roots = (await db.locations.toArray()).filter((item) => item.mapBinding).map((item) => `${item.id}:${item.mapBinding!.x},${item.mapBinding!.y}`).sort()
    return { seed: map?.seed, tiles: map?.tiles.join(','), roots }
  })
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '重新生成地图' }).click()
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/db/db.ts')).db.worldMaps.get('active'))?.seed)).not.toBe(beforeRegenerate.seed)

  const saved = await page.evaluate(async (before) => {
    const { db } = await import('/src/db/db.ts')
    const all = await db.locations.toArray()
    const location = all.find((item) => item.name === '测试公寓')
    const children = all.filter((item) => item.parentId === location?.id)
    const roots = all.filter((item) => item.mapBinding)
    const validSpacing = roots.every((a, index) => roots.slice(index + 1).every((b) => Math.max(Math.abs(a.mapBinding!.x - b.mapBinding!.x), Math.abs(a.mapBinding!.y - b.mapBinding!.y)) >= 2))
    const map = await db.worldMaps.get('active')
    const rootPositions = roots.map((item) => `${item.id}:${item.mapBinding!.x},${item.mapBinding!.y}`).sort()
    return { note: location?.note, iconId: location?.mapBinding?.iconId, childNames: children.map((item) => item.name), validSpacing, tilesChanged: map?.tiles.join(',') !== before.tiles, rootsChanged: rootPositions.some((value, index) => value !== before.roots[index]) }
  }, beforeRegenerate)
  expect(saved).toEqual({ note: '保留这条用户备注', iconId: 'apartment', childNames: ['天台花园'], validSpacing: true, tilesChanged: true, rootsChanged: true })
})

test('location marker labels remain readable in dark mode', async ({ page }) => {
  await page.goto('/#/locations')
  await page.evaluate(async () => (await import('/src/store/useSettingsStore.ts')).useSettingsStore.getState().setSettings({ themeMode: 'dark' }))
  await page.reload()
  const marker = page.getByRole('button', { name: '我的家' }).locator('span').filter({ hasText: '我的家' }).last()
  await expect(marker).toBeVisible()
  const colors = await marker.evaluate((element) => {
    const style = getComputedStyle(element)
    return { color: style.color, backgroundColor: style.backgroundColor }
  })
  expect(colors.color).not.toBe(colors.backgroundColor)
  expect(colors.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
})
