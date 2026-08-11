import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const browser = await chromium.connectOverCDP(process.env.TALK_CDP_URL || 'http://127.0.0.1:9223')
const contexts = browser.contexts()
const pages = contexts.flatMap((context) => context.pages())
const page = pages.find((candidate) => candidate.url().startsWith('talk://')) ?? pages[0]
if (!page) throw new Error('Talk Electron page was not found')

const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })

await mkdir('artifacts/desktop', { recursive: true })
await page.reload()
await page.waitForLoadState('domcontentloaded')
await page.screenshot({ path: 'artifacts/desktop/main.png' })
await page.locator('.desktop-rail-button[title="设置"]').click()
await page.locator('.desktop-settings-list').waitFor()
await page.screenshot({ path: 'artifacts/desktop/settings.png' })
const settingsGroups = await page.locator('.desktop-settings-group').count()
await page.locator('.desktop-user-avatar').click()
await page.locator('.desktop-profile-page').waitFor()
await page.screenshot({ path: 'artifacts/desktop/profile-edit.png' })
const profileEditor = await page.locator('.desktop-profile-page').count()
await page.locator('.desktop-rail-button[title="朋友圈"]').click()
await page.locator('.moments-cover').waitFor()
await page.screenshot({ path: 'artifacts/desktop/moments.png' })
const momentsCover = await page.locator('.moments-cover').count()
const proxyStatus = await page.evaluate(async () => {
  const target = encodeURIComponent('https://api.github.com/repos/Entropy2077-axe/talk/releases/latest')
  return (await fetch(`talk://app/__api__/${target}`)).status
})

const result = {
  url: page.url(),
  titlebar: await page.locator('.desktop-titlebar').count(),
  rail: await page.locator('.desktop-rail').count(),
  sidebar: await page.locator('.desktop-sidebar').count(),
  desktopFlag: await page.locator('.app-shell[data-desktop="true"]').count(),
  settingsGroups,
  profileEditor,
  momentsCover,
  errors,
  proxyStatus,
}
console.log(JSON.stringify(result))
await browser.close()
