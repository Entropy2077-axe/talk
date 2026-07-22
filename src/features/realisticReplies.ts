import type { FeatureModule } from './types'

/** Optional timing behavior: replies are generated after a human-like delay. */
export const realisticRepliesModule: FeatureModule = {
  id: 'realisticReplies',
  name: '更真实的回复',
  icon: '⏳',
  description: '开启后，角色会在0到5分钟内回复，不保证秒回',
  parentId: 'chat-assist',
}
