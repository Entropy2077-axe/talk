import { SkyEyePage } from '../pages/SkyEyePage'
import type { FeatureModule } from './types'

export const adminModeModule: FeatureModule = {
  id: 'adminMode',
  name: '管理员模式',
  icon: '🔭',
  description: '天眼调试页面、联系人系统提示词预览、消息调试信息',
  routes: [{ path: '/sky-eye', component: SkyEyePage }],
  discoverEntries: [{ to: '/sky-eye', icon: '🔭', label: '天眼' }],
}
