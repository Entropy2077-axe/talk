import type { FeatureModule } from './types'

/** Opt-in, potentially costly: creates one generated illustration per completed AI turn. */
export const conversationIllustrationModule: FeatureModule = {
  id: 'conversationIllustration',
  name: '对话配图',
  icon: 'image',
  description: '每轮回复自动生成一张情境配图（会增加生图次数和费用）',
  parentId: 'chat-assist',
}
