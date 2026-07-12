import { lazy } from 'react'
import type { FeatureModule } from './types'

const RelationshipsPage = lazy(() => import('../pages/RelationshipsPage').then(({ RelationshipsPage }) => ({ default: RelationshipsPage })))

export const relationshipModule: FeatureModule = {
  id: 'relationship',
  name: '好感度',
  icon: '💕',
  description: 'AI对用户的好感度（-100~100），随聊天动态变化，影响说话语气',
  parentId: 'character-soul',
  routes: [{ path: '/relationships', component: RelationshipsPage }],
  discoverEntries: [{ to: '/relationships', icon: '💕', label: '好感度' }],
}
