import type { FeatureModule } from './types'

export const personalityTraitsModule: FeatureModule = {
  id: 'personalityTraits',
  name: '特色人格',
  icon: '🎭',
  description: 'AI可拥有病娇/傲娇/天然呆等特色人格，影响好感度变化速率和说话风格',
  parentId: 'character-soul',
  // No standalone page — personality traits are configured per-contact
  // during creation (ContactAddPage) and viewing (ContactCardPage).
}
