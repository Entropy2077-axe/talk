import { ValidatorSettingsPage } from '../pages/ValidatorSettingsPage'
import type { FeatureModule } from './types'

export const validatorModule: FeatureModule = {
  id: 'validator',
  name: '校验器',
  icon: '✅',
  description: 'AI回复质量校验，防止跑题或胡编。默认开启，可在设置中选择模式',
  routes: [{ path: '/validator-settings', component: ValidatorSettingsPage }],
  discoverEntries: [{ to: '/validator-settings', icon: '✅', label: '校验器' }],
}
