import type { FeatureModule } from './types'

export const intentModule: FeatureModule = {
  id: 'intent',
  name: 'AI内部意图',
  icon: '💭',
  description: '让角色保留少量未说出口的小念头，用来增强下一轮聊天的延续感',
  parentId: 'character-soul',
}
