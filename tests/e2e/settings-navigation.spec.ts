import { expect, test, type Page } from 'playwright/test'

const categories = ['体验模式', 'AI 设置', '外观与聊天', '创作与素材', '功能管理', '数据管理']

async function open(page: Page, route = '/me') {
  await page.goto(`/#${route}`)
  await expect(page.locator('.app-shell')).toBeVisible()
  await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    useSettingsStore.getState().setSettings({ apiKey: '', tavilyApiKey: '', pexelsApiKey: '', actionDecisionApiKey: '', adminModeEnabled: false, experienceMode: 'free' })
  })
}

test('mobile account categories reach their pages and preserve back navigation', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await open(page)
  for (const label of categories) {
    await page.getByRole('button', { name: new RegExp(`^${label}`) }).click()
    await expect(page.getByRole('heading', { name: label, exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page).toHaveURL(/#\/me$/)
  }
  await expect(page.getByRole('button', { name: '进入全屏', exact: true })).toHaveCount(0)
  const shell = await page.locator('.app-shell').boundingBox()
  expect(shell!.y + shell!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1)
  expect(errors).toEqual([])
})

test('chat and advanced settings persist without changing experience mode', async ({ page }) => {
  await open(page, '/settings/chat')
  await expect(page.getByRole('button', { name: '进入全屏' })).toBeVisible()
  await page.getByLabel('每次加载消息条数').selectOption('20')
  await page.getByLabel('切换回复等待超时').click()
  await page.getByLabel('应用背景色 #edf4ff').click()
  await page.reload()
  await expect(page.getByLabel('每次加载消息条数')).toHaveValue('20')
  await expect(page.getByLabel('切换回复等待超时')).toHaveAttribute('aria-checked', 'false')
  await page.getByText('显示适配', { exact: true }).click()
  await page.getByLabel('顶部显示区域微调').fill('12')
  await page.goto('/#/settings/ai')
  await expect(page.getByRole('button', { name: /行动判断与调用预算/ })).toBeVisible()
  await page.getByRole('button', { name: /行动判断与调用预算/ }).click()
  await page.getByLabel('私聊工具判断方式').selectOption('jev')
  await page.getByLabel('Jev OpenRouter API Key').fill('test-ui-key')
  await page.getByRole('button', { name: '保存 Key' }).click()
  await page.reload()
  await expect(page.getByLabel('Jev OpenRouter API Key')).toHaveValue('test-ui-key')
  const state = await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    const s = useSettingsStore.getState()
    return { background: s.chatBackground, mode: s.experienceMode, inset: s.topInsetAdjustmentPx }
  })
  expect(state).toEqual({ background: '#edf4ff', mode: 'free', inset: 12 })
})

test('discover groups remember collapse and omit disabled features', async ({ page }) => {
  await open(page, '/discover')
  await page.getByRole('button', { name: '世界与生活', exact: true }).click()
  await expect(page.getByRole('button', { name: '商城', exact: true })).toBeHidden()
  await page.reload()
  await expect(page.getByRole('button', { name: '世界与生活', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('button', { name: '世界与生活', exact: true }).click()
  await expect(page.getByRole('button', { name: '商城', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    useSettingsStore.getState().setSettings({ enabledModules: [], adminModeEnabled: true })
  })
  await expect(page.getByRole('button', { name: '世界与生活', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '管理功能', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '朋友圈', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '天眼', exact: true })).toHaveCount(0)
})

test('management tools follow admin and experience mode restrictions', async ({ page }) => {
  await open(page, '/modules')
  await expect(page.getByRole('button', { name: /^管理工具/ })).toHaveCount(0)
  await page.getByLabel('切换管理员模式').click()
  await page.getByRole('button', { name: /^管理工具/ }).click()
  await expect(page.getByRole('button', { name: /^天眼/ })).toBeVisible()
  await expect(page.getByText('设定我的余额', { exact: true })).toBeVisible()
  await page.goto('/#/experience-mode')
  await page.getByRole('button', { name: /^沉浸模式/ }).click()
  await page.goto('/#/modules')
  await expect(page.getByLabel('切换管理员模式')).toHaveAttribute('aria-checked', 'false')
  await page.getByLabel('切换管理员模式').click()
  await expect(page.getByRole('button', { name: /^管理工具/ })).toHaveCount(0)
})

test('desktop shares categories and highlights the parent of nested settings', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'talkDesktop', { value: { minimize() {}, toggleMaximize() {}, close() {}, isMaximized: async () => false, onMaximizedChange: () => () => {} } })
  })
  await page.setViewportSize({ width: 1280, height: 800 })
  await open(page, '/settings')
  const sidebar = page.locator('.desktop-sidebar')
  for (const label of categories) await expect(sidebar.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible()
  await sidebar.getByRole('button', { name: /^创作与素材/ }).click()
  await page.locator('.desktop-main').getByRole('button', { name: /^绘图工具/ }).click()
  await expect(page).toHaveURL(/#\/drawing-tool$/)
  await expect(sidebar.getByRole('button', { name: /^创作与素材/ })).toHaveClass(/active/)
  await page.goto('/#/settings/chat')
  await expect(sidebar.getByRole('button', { name: /^外观与聊天/ })).toHaveClass(/active/)
  await page.goto('/#/settings/ai/advanced')
  await expect(sidebar.getByRole('button', { name: /^AI 设置/ })).toHaveClass(/active/)
  await page.goto('/#/settings/api-configurations')
  await expect(sidebar.getByRole('button', { name: /^AI 设置/ })).toHaveClass(/active/)
})

test('fullscreen remains available in appearance and exits normally', async ({ page }) => {
  await open(page, '/settings/chat')
  await page.getByRole('button', { name: '进入全屏', exact: true }).click()
  await expect(page.getByRole('button', { name: '退出全屏', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '退出全屏', exact: true }).click()
  await expect(page.getByRole('button', { name: '进入全屏', exact: true })).toBeVisible()
})

test('new settings remain readable and scroll inside mobile and desktop shells in all themes', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    if (window.innerWidth >= 1000) Object.defineProperty(window, 'talkDesktop', { configurable: true, value: { minimize() {}, toggleMaximize() {}, close() {}, isMaximized: async () => false, onMaximizedChange: () => () => {} } })
  })
  await open(page, '/settings/chat')
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 780 })
    await page.reload()
    if (width === 1280) await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop', 'true')
    else await expect(page.locator('.app-shell')).not.toHaveAttribute('data-desktop', 'true')
    for (const theme of ['sage', 'forge', 'fox', 'ink', 'nord', 'wetalk']) {
      for (const mode of ['light', 'dark']) {
        await page.evaluate(async ({ theme, mode }) => {
          const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
          useSettingsStore.getState().setSettings({ uiTheme: theme, themeMode: mode })
        }, { theme, mode })
        await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme)
        const dimensions = await page.locator('.ui-page-scroll').evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth, height: el.clientHeight }))
        expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1)
        expect(dimensions.height).toBeLessThan(780)
        const colors = await page.getByRole('heading', { name: '外观与聊天', exact: true }).evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el.closest('header')!).backgroundColor }))
        expect(colors.color).not.toBe(colors.background)
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 780 })
  await page.goto('/#/me')
  await page.reload()
  await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    useSettingsStore.getState().setSettings({ animationsEnabled: false })
    await document.fonts.ready
  })
  await page.screenshot({ path: testInfo.outputPath('account-dark.png'), animations: 'disabled' })
})
