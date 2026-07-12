import { lazy } from 'react'
import type { FeatureModule } from './types'

const ProactiveSettingsPage = lazy(() => import('../pages/ProactiveSettingsPage').then(({ ProactiveSettingsPage }) => ({ default: ProactiveSettingsPage })))

export const proactiveChatModule: FeatureModule = {
  id: 'proactiveChat',
  name: 'AI自主行为',
  icon: '🤖',
  description: 'AI在后台定时自主发朋友圈、主动找你聊天（会产生API费用）',
  parentId: 'chat-assist',
  routes: [{ path: '/proactive-settings', component: ProactiveSettingsPage }],
  discoverEntries: [{ to: '/proactive-settings', icon: '🤖', label: '自主行为设置' }],
}
