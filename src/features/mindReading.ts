import type { FeatureModule } from './types'

export const mindReadingModule: FeatureModule = {
  id: 'mindReading',
  name: '读心',
  icon: '🔮',
  description: '显示AI回复时的内心想法（默认隐藏，开启后每条回复下方出现想法卡片）',
  parentId: 'character-soul',
}
