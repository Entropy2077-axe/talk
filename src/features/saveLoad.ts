import { lazy } from 'react'
import type { FeatureModule } from './types'

const SaveLoadPage = lazy(() => import('../pages/SaveLoadPage').then(({ SaveLoadPage }) => ({ default: SaveLoadPage })))
const WorldbookCollectionPage = lazy(() => import('../pages/WorldbookCollectionPage').then(({ WorldbookCollectionPage }) => ({ default: WorldbookCollectionPage })))

export const saveLoadModule: FeatureModule = {
  id: 'saveLoad',
  name: '存档回档',
  icon: '💾',
  description: '以世界为核心保存和恢复完整状态',
  parentId: 'more-interaction',
  routes: [
    { path: '/save-load', component: SaveLoadPage },
    { path: '/save-load/world/:worldId', component: SaveLoadPage },
    { path: '/save-load/world/:worldId/snapshot/:snapshotId', component: SaveLoadPage },
    { path: '/save-load/world/:worldId/edit', component: WorldbookCollectionPage },
  ],
}
