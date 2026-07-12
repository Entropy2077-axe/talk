import { lazy } from 'react'
import type { FeatureModule } from './types'
const SaveLoadPage = lazy(() => import('../pages/SaveLoadPage').then(({ SaveLoadPage }) => ({ default: SaveLoadPage })))
export const saveLoadModule: FeatureModule = { id: 'saveLoad', name: '存档回档', icon: '💾', description: '本机保存和恢复完整世界状态', parentId: 'more-interaction', routes: [{ path: '/save-load', component: SaveLoadPage }] }
