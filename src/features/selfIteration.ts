import type { FeatureModule } from './types'

export const selfIterationModule: FeatureModule = {
  id: 'selfIteration',
  name: '自我迭代',
  icon: '🧭',
  description: '每轮对话后后台学习用户表达、交流方式、期望模型和单个联系人的相处预期',
  parentId: 'chat-assist',
}
