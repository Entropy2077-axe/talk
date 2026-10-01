import type { AppSettings } from '../types'

export interface SettingsEntry {
  to: string
  label: string
  note: string
  icon: string
}

/** Shared by the mobile account page and desktop settings sidebar. */
export function settingsEntries(settings: AppSettings): SettingsEntry[] {
  return [
    { to: '/experience-mode', label: '体验模式', note: settings.experienceMode === 'immersive' ? '沉浸模式' : '自由模式', icon: '◈' },
    { to: '/settings/ai', label: 'AI 设置', note: '模型、提示词与行动判断', icon: '🤖' },
    { to: '/settings/chat', label: '外观与聊天', note: '主题、背景、全屏与回复体验', icon: '🎨' },
    { to: '/settings/creation', label: '创作与素材', note: '绘图工具与表情包', icon: 'image' },
    { to: '/modules', label: '功能管理', note: '开关功能模块与配置', icon: '▦' },
    { to: '/settings/data', label: '数据管理', note: '备份、恢复与数据清理', icon: 'archive' },
  ]
}

export function settingsCategoryForPath(path: string): string | undefined {
  if (path === '/experience-mode') return path
  if (path === '/appearance' || path.startsWith('/settings/chat')) return '/settings/chat'
  if (path === '/presets' || path.startsWith('/settings/ai') || path === '/settings/api-configurations' || path === '/settings/global-prompts' || path === '/settings/other-interfaces') return '/settings/ai'
  if (path.startsWith('/settings/creation') || path === '/drawing-tool' || path.startsWith('/stickers') || path.startsWith('/settings/image-generation') || path.startsWith('/settings/speech-generation')) return '/settings/creation'
  if (path === '/modules' || path === '/proactive-settings' || path === '/settings/economy' || path === '/settings/admin' || path === '/ai-test-cards') return '/modules'
  if (path.startsWith('/settings/data')) return '/settings/data'
  return undefined
}
