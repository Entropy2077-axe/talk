import { db } from '../db/db'
import { v4 as uuid } from 'uuid'
import { displayName } from './contact'
import type { Contact, ContactRelationLabel } from '../types'

export type RelationSentiment = 'good' | 'neutral' | 'bad'

const SENTIMENT_BY_LABEL: Record<ContactRelationLabel, RelationSentiment> = {
  普通朋友: 'neutral',
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

/** Create or replace one symmetric social contract. Both contacts always receive the same label. */
export async function setPairedContactRelation(fromContactId: string, toContactId: string, label: ContactRelationLabel): Promise<void> {
  if (fromContactId === toContactId) return
  const existing = await db.contactRelations.filter((link) =>
    (link.fromContactId === fromContactId && link.toContactId === toContactId) ||
    (link.fromContactId === toContactId && link.toContactId === fromContactId),
  ).toArray()
  const pairId = existing[0]?.pairId || uuid()
  const now = Date.now()
  if (existing.length) await db.contactRelations.bulkDelete(existing.map((link) => link.id))
  await db.contactRelations.bulkAdd([
    { id: uuid(), pairId, fromContactId, toContactId, label, createdAt: now },
    { id: uuid(), pairId, fromContactId: toContactId, toContactId: fromContactId, label, createdAt: now },
  ])
}

/** A single canonical record per pair for UI and scene selection. */
export function uniqueRelationPairs(links: import('../types').ContactRelationLink[]) {
  const seen = new Set<string>()
  return links.filter((link) => {
    const key = link.pairId || [link.fromContactId, link.toContactId].sort().join(':')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function aiRelationshipPrompt(contacts: Contact[]): Promise<string> {
  const ids = new Set(contacts.map((c) => c.id))
  const byId = new Map(contacts.map((c) => [c.id, c]))
  const links = uniqueRelationPairs((await db.contactRelations.toArray()).filter((l) => ids.has(l.fromContactId) && ids.has(l.toContactId)))
  const lines = links.map((link) => {
    const a = byId.get(link.fromContactId)
    const b = byId.get(link.toContactId)
    return a && b ? `- ${displayName(a)} 与 ${displayName(b)} 是彼此的${link.label}。这是既定事实，除非本轮有明确确认关系/分手/绝交事件，否则不能改称朋友。` : ''
  }).filter(Boolean)
  return lines.length ? `【不可擅自改变的 AI 关系】\n${lines.join('\n')}` : ''
}

/** Only unambiguous relationship events may rewrite the user-set label. */
export async function applyExplicitRelationshipEvent(fromContactId: string, toContactId: string, text: string): Promise<void> {
  const confirmed = /确认(?:恋爱|关系)|正式交往|已经在一起|表白.{0,12}(?:接受|答应)/.test(text)
  const broken = /已经分手|确认分手|离婚|已经绝交|断绝联系/.test(text)
  if (!confirmed && !broken) return
  const label: ContactRelationLabel = confirmed ? '恋人' : '普通朋友'
  const links = await db.contactRelations.filter((link) =>
    (link.fromContactId === fromContactId && link.toContactId === toContactId) ||
    (link.fromContactId === toContactId && link.toContactId === fromContactId),
  ).toArray()
  if (links.length === 0) return
  const now = Date.now()
  for (const link of links) await db.contactRelations.update(link.id, {
    label,
    dynamicSummary: broken ? '已分手/关系破裂' : '确认恋爱关系',
    lastInteractionAt: now,
  })
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
  items: Array<{ content: string; relatedContactIds?: string[]; kind?: string; confidence?: number }>,
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
    for (const item of relatedItems) {
      if (item.kind === 'relationship_event' && (item.confidence ?? 0) >= 0.85) {
        await applyExplicitRelationshipEvent(fromContactId, relatedId, item.content)
      }
    }
  }
}
