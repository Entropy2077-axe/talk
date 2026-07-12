import { lazy } from 'react'
import type { FeatureModule } from './types'

const WorldSettingsPage = lazy(() => import('../pages/WorldSettingsPage').then(({ WorldSettingsPage }) => ({ default: WorldSettingsPage })))

export const worldviewModule: FeatureModule = {
  id: 'worldview',
  name: '世界书',
  icon: '📖',
  description: '共享世界观设定，注入到所有AI的对话和朋友圈中',
  parentId: 'character-soul',
  routes: [{ path: '/world-settings', component: WorldSettingsPage }],
  discoverEntries: [{ to: '/world-settings', icon: '📖', label: '世界书' }],
}
