import { WorldSettingsPage } from '../pages/WorldSettingsPage'
import type { FeatureModule } from './types'

export const knowledgeBaseModule: FeatureModule = {
  id: 'knowledgeBase',
  name: '知识库',
  icon: '📚',
  description: 'AI遇到不了解的热梗/番剧/游戏时自动搜索补充知识',
  parentId: 'character-soul',
  // Shares /world-settings with worldview; the page shows both sections
  // when both are enabled, or just one when only one is.
  routes: [{ path: '/world-settings', component: WorldSettingsPage }],
  discoverEntries: [{ to: '/world-settings', icon: '📚', label: '知识库' }],
}
