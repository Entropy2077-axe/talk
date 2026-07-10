import { db } from '../db/db'
import type { ContactRelationLabel } from '../types'

export type RelationSentiment = 'good' | 'neutral' | 'bad'

const SENTIMENT_BY_LABEL: Record<ContactRelationLabel, RelationSentiment> = {
  好朋友: 'good',
  损友: 'good',
  暧昧对象: 'good',
  恋人: 'good',
  家人: 'good',
  '前辈/同事': 'neutral',
  点头之交: 'neutral',
  看不顺眼: 'bad',
  对头: 'bad',
}

export function relationSentiment(label: ContactRelationLabel): RelationSentiment {
  return SENTIMENT_BY_LABEL[label] ?? 'neutral'
}

/** Whether a relationship is close/positive enough that the two might plausibly interact on each other's moments at all — bad ones never do. */
export function canReactToMoments(label: ContactRelationLabel): boolean {
  return relationSentiment(label) !== 'bad'
}

export function dynamicRelationScore(link: { affinity?: number; familiarity?: number; tension?: number }): number {
  return (link.affinity ?? 0) * 0.65 + (link.familiarity ?? 0) * 0.2 - (link.tension ?? 0) * 0.45
}

/**
 * A stable label is the initial social contract. This predicate lets repeated
 * shared experiences soften or sharpen it without silently rewriting that
 * contract. A hostile pair can still occasionally react — usually tersely.
 */
export function momentReactionProbability(link: {
  label: ContactRelationLabel
  affinity?: number
  familiarity?: number
  tension?: number
}): number {
  const base = relationSentiment(link.label) === 'good' ? 0.62 : relationSentiment(link.label) === 'neutral' ? 0.28 : 0.08
  const score = dynamicRelationScore(link)
  return Math.max(0.02, Math.min(0.9, base + score / 230))
}

function inferInteractionDelta(content: string): { affinity: number; tension: number; summary: string } {
  const text = content.toLowerCase()
  const conflict = /吵|怼|讽|不爽|生气|误会|冷战|反驳|争执|看不顺眼|阴阳/.test(text)
  const positive = /帮|陪|夸|谢谢|和好|默契|关心|支持|一起|笑|接梗|安慰/.test(text)
  if (conflict && !positive) return { affinity: -4, tension: 6, summary: '最近互动带着明显摩擦' }
  if (positive && !conflict) return { affinity: 4, tension: -3, summary: '最近互动更熟络自然' }
  return { affinity: 1, tension: 0, summary: '最近有共同互动' }
}

/** Apply conservative, explainable changes from an extracted shared-memory item. */
export async function applyInterpersonalMemorySignals(
  fromContactId: string,
  items: Array<{ content: string; relatedContactIds?: string[] }>,
): Promise<void> {
  const relatedIds = Array.from(new Set(items.flatMap((item) => item.relatedContactIds ?? []).filter((id) => id !== fromContactId)))
  if (relatedIds.length === 0) return
  const now = Date.now()
  for (const relatedId of relatedIds) {
    const relatedItems = items.filter((item) => item.relatedContactIds?.includes(relatedId))
    if (relatedItems.length === 0) continue
    const signal = relatedItems.map((item) => inferInteractionDelta(item.content)).reduce(
      (acc, delta) => ({ affinity: acc.affinity + delta.affinity, tension: acc.tension + delta.tension, summary: delta.summary }),
      { affinity: 0, tension: 0, summary: '最近有共同互动' },
    )
    const links = await db.contactRelations
      .filter((link) =>
        (link.fromContactId === fromContactId && link.toContactId === relatedId)
        || (link.fromContactId === relatedId && link.toContactId === fromContactId),
      )
      .toArray()
    for (const link of links) {
      const affinity = Math.max(-100, Math.min(100, (link.affinity ?? 0) + signal.affinity))
      const familiarity = Math.max(0, Math.min(100, (link.familiarity ?? 0) + relatedItems.length * 2))
      const tension = Math.max(0, Math.min(100, (link.tension ?? 0) + signal.tension))
      await db.contactRelations.update(link.id, { affinity, familiarity, tension, dynamicSummary: signal.summary, lastInteractionAt: now })
    }
  }
}
