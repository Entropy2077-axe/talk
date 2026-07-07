import { MoodSettingsPage } from '../pages/MoodSettingsPage'
import type { FeatureModule } from './types'

export const moodModule: FeatureModule = {
  id: 'mood',
  name: '心情系统',
  icon: '💭',
  description: 'AI在聊天中会表达暂时的情绪（如开心、吃醋、生气），影响当前说话语气',
  parentId: 'character-soul',
  routes: [{ path: '/mood-settings', component: MoodSettingsPage }],
  discoverEntries: [{ to: '/mood-settings', icon: '💭', label: '心情设置' }],
}
