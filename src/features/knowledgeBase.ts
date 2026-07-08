import { KnowledgeBasePage } from '../pages/KnowledgeBasePage'
import type { FeatureModule } from './types'

export const knowledgeBaseModule: FeatureModule = {
  id: 'knowledgeBase',
  name: '知识库',
  icon: '📚',
  description: 'AI遇到不了解的热梗/番剧/游戏时自动搜索补充知识',
  parentId: 'character-soul',
  routes: [{ path: '/knowledge-base', component: KnowledgeBasePage }],
  discoverEntries: [{ to: '/knowledge-base', icon: '📚', label: '知识库' }],
}
