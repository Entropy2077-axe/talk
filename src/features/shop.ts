import { lazy } from 'react'
import type { FeatureModule } from './types'

const ShopPage = lazy(() => import('../pages/ShopPage').then(({ ShopPage }) => ({ default: ShopPage })))

export const shopModule: FeatureModule = {
  id: 'shop',
  name: '商城',
  icon: '🛍️',
  description: 'AI生成商品，用户购买后存入仓库',
  parentId: 'more-interaction',
  routes: [{ path: '/shop', component: ShopPage }],
  discoverEntries: [{ to: '/shop', icon: '🛍️', label: '商城' }],
  linkApps: [{ app: 'shop', desc: '虚拟网购小程序' }],
}
