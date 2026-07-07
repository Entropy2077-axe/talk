import { WarehousePage } from '../pages/WarehousePage'
import type { FeatureModule } from './types'

export const warehouseModule: FeatureModule = {
  id: 'warehouse',
  name: '仓库',
  icon: '📦',
  description: '查看已购物品并赠送给联系人，关闭后页面隐藏但已存在的赠送卡片不受影响',
  parentId: 'more-interaction',
  routes: [{ path: '/warehouse', component: WarehousePage }],
  discoverEntries: [{ to: '/warehouse', icon: '📦', label: '仓库' }],
}
