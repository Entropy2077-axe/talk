import type { FeatureModule } from './types'

export const storyOutlineModule: FeatureModule = {
  id: 'storyOutline',
  name: '剧情大纲生成',
  icon: '🧪',
  description: '群聊主模型回复前先生成小型剧情大纲，帮助控制逻辑和话题推进；会额外消耗一次多功能模型 token',
  parentId: 'chat-assist',
}
