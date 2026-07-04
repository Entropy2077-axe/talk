import type { RelationshipDimensions } from '../types'

export const RELATIONSHIP_DIMENSIONS: { key: keyof RelationshipDimensions; label: string }[] = [
  { key: 'familiarity', label: '熟悉度' },
  { key: 'affection', label: '好感度' },
  { key: 'trust', label: '信任度' },
  { key: 'romance', label: '暧昧度' },
  { key: 'friction', label: '摩擦感' },
]

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
