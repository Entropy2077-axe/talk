import type { FeatureModule } from './types'

export const speechModule: FeatureModule = {
  id: 'speech',
  name: '语音功能',
  icon: 'volume-2',
  description: '为联系人配置音色，并生成和播放聊天语音',
  parentId: 'chat-assist',
}
