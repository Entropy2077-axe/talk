import type { AiBubble, RelationshipDimensions } from '../types'

export const RELATIONSHIP_DIMENSIONS: { key: keyof RelationshipDimensions; label: string; description: string }[] = [
  { key: 'familiarity', label: '熟悉度', description: '你们互相了解多少 聊过的话题和经历越多越高' },
  { key: 'affection', label: '好感度', description: '对方对你的喜欢和亲近程度' },
  { key: 'trust', label: '信任度', description: '愿意对你敞开心扉、说真心话的程度' },
  { key: 'romance', label: '暧昧度', description: '你们之间暧昧、心动氛围的强弱' },
  { key: 'friction', label: '摩擦感', description: '累积的不耐烦和小摩擦 越高关系越紧张' },
]

export function dimensionQualifier(value: number): string {
  if (value >= 80) return '非常高'
  if (value >= 60) return '较高'
  if (value >= 40) return '中等'
  if (value >= 20) return '较低'
  return '很低'
}

function clampDimension(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

/** Starting point for a brand new contact, biased a little by the relationship the user picked when adding them. */
export function initialRelationshipFor(relationshipTag: string): RelationshipDimensions {
  const base: RelationshipDimensions = { familiarity: 8, affection: 50, trust: 35, romance: 0, friction: 0 }
  switch (relationshipTag) {
    case '恋人':
      return { ...base, affection: 75, trust: 55, romance: 60 }
    case '暧昧对象':
      return { ...base, affection: 60, romance: 35 }
    case '损友':
      return { ...base, affection: 60, friction: 15 }
    case '前辈/同事':
      return { ...base, affection: 40, trust: 30 }
    case '家人':
      return { ...base, familiarity: 40, affection: 65, trust: 55 }
    default:
      return base
  }
}

export type RelationshipDelta = Partial<Record<keyof RelationshipDimensions, number>>

export function applyRelationshipDelta(
  current: RelationshipDimensions,
  delta: RelationshipDelta,
): RelationshipDimensions {
  const next = { ...current }
  for (const { key } of RELATIONSHIP_DIMENSIONS) {
    const d = delta[key]
    if (typeof d === 'number' && Number.isFinite(d)) {
      next[key] = clampDimension(current[key] + d)
    }
  }
  return next
}

export function relationshipStatsText(rel: RelationshipDimensions): string {
  return RELATIONSHIP_DIMENSIONS.map(({ key, label }) => `- ${label}: ${rel[key]}/100（${dimensionQualifier(rel[key])}）`).join('\n')
}

export function relationshipUnlocks(rel: RelationshipDimensions): string[] {
  const unlocks: string[] = []
  if (rel.affection >= 70) unlocks.push('更亲近的日常语气：可以更自然地关心、撒娇、使用昵称或内部梗')
  if (rel.trust >= 70) unlocks.push('更深的话题：可以聊自己的脆弱、烦恼和真实想法')
  if (rel.romance >= 60) unlocks.push('暧昧/恋爱语气：可以更明显地吃醋、心动、贴近，但仍符合角色性格')
  if (rel.friction >= 60) unlocks.push('冲突语气：可以冷淡、顶嘴、催促或表达不满，不必强行友好')
  if (rel.familiarity >= 60) unlocks.push('熟人默契：可以省略解释、接内部梗、用更短更随意的表达')
  return unlocks
}

export function relationshipUnlocksText(rel: RelationshipDimensions): string {
  const unlocks = relationshipUnlocks(rel)
  return unlocks.length > 0 ? unlocks.map((u) => `- ${u}`).join('\n') : '（暂无额外解锁，保持基础关系语气）'
}

const THRESHOLDS = [30, 60, 80]

export function crossedRelationshipMilestones(before: RelationshipDimensions, after: RelationshipDimensions): string[] {
  const messages: string[] = []
  for (const { key, label } of RELATIONSHIP_DIMENSIONS) {
    for (const threshold of THRESHOLDS) {
      if (before[key] < threshold && after[key] >= threshold) {
        messages.push(`${label}达到 ${threshold}`)
      }
    }
  }
  return messages
}

export function inferRelationshipDeltaFromTurn(userText: string, bubbles: AiBubble[]): RelationshipDelta {
  const text = `${userText}\n${bubbles
    .map((b) => {
      if (b.type === 'text') return b.content
      if (b.type === 'commission') return `${b.title} ${b.description}`
      return ''
    })
    .join('\n')}`.toLowerCase()
  const delta: RelationshipDelta = {}
  const add = (key: keyof RelationshipDimensions, amount: number) => {
    delta[key] = (delta[key] ?? 0) + amount
  }

  if (userText.trim()) add('familiarity', 1)
  if (/[谢谢|谢啦|辛苦|喜欢|开心|哈哈|嘿嘿|抱抱|爱你]/.test(text)) add('affection', 2)
  if (/[秘密|难过|害怕|压力|焦虑|崩溃|心事|告诉你]/.test(text)) {
    add('trust', 2)
    add('familiarity', 1)
  }
  if (/[想你|亲|吻|抱抱|宝贝|老婆|老公|心动|暧昧]/.test(text)) add('romance', 2)
  if (/[烦|闭嘴|算了|滚|讨厌|生气|不想理|别管]/.test(text)) add('friction', 3)
  if (/[对不起|抱歉|不好意思]/.test(text)) add('friction', -1)
  if (bubbles.some((b) => b.type === 'commission')) add('trust', 1)

  for (const key of Object.keys(delta) as (keyof RelationshipDimensions)[]) {
    delta[key] = Math.max(-3, Math.min(3, delta[key] ?? 0))
  }
  return delta
}

/** Reduces the five numeric dimensions to a single memorable label, the same way MBTI reduces axes to a type code. */
export function relationshipStageLabel(rel: RelationshipDimensions): string {
  if (rel.friction >= 60) return '关系紧张'
  if (rel.romance >= 60 && rel.affection >= 60) return '热恋'
  if (rel.romance >= 30) return '暧昧不明'
  if (rel.familiarity <= 15) return '刚认识'
  if (rel.affection >= 70 && rel.trust >= 70) return '挚友'
  if (rel.familiarity >= 60 && rel.affection >= 50) return '熟悉的朋友'
  return '普通朋友'
}
