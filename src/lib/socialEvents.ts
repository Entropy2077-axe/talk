import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { SocialEvent, SocialEventType } from '../types'

const MAX_EVENT_SUMMARY_LENGTH = 80

function defaultExpiry(createdAt: number, importance: number): number {
  const days = importance >= 3 ? 14 : importance === 2 ? 7 : 3
  return createdAt + days * 24 * 60 * 60 * 1000
}

function uniqueContactIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter((id) => id && id !== 'user')))
}

function cleanSummary(summary: string): string {
  const oneLine = summary.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_EVENT_SUMMARY_LENGTH ? `${oneLine.slice(0, MAX_EVENT_SUMMARY_LENGTH)}...` : oneLine
}

export async function recordSocialEvent(opts: {
  type: SocialEventType
  actorId: string
  targetId?: string
  relatedContactIds: string[]
  summary: string
  conversationId?: string
  groupId?: string
  momentId?: string
  messageId?: string
  importance?: number
  createdAt?: number
}): Promise<void> {
  const relatedContactIds = uniqueContactIds(opts.relatedContactIds)
  if (relatedContactIds.length === 0) return
  const event: SocialEvent = {
    id: uuid(),
    type: opts.type,
    actorId: opts.actorId,
    targetId: opts.targetId,
    relatedContactIds,
    summary: cleanSummary(opts.summary),
    conversationId: opts.conversationId,
    groupId: opts.groupId,
    momentId: opts.momentId,
    messageId: opts.messageId,
    importance: opts.importance ?? 1,
    createdAt: opts.createdAt ?? Date.now(),
  }
  event.expiresAt = defaultExpiry(event.createdAt, event.importance)
  await db.socialEvents.add(event)
}

export async function recentSocialEventsText(contactIds: string[], limit = 4, includePrivateGroups = true): Promise<string> {
  const ids = new Set(uniqueContactIds(contactIds))
  if (ids.size === 0) return ''

  let events = await recentSocialEvents(contactIds, limit + 8)
  if (!includePrivateGroups) {
    const groupIds = Array.from(new Set(events.map((event) => event.groupId).filter((id): id is string => !!id)))
    const groups = new Map((await db.groups.bulkGet(groupIds)).filter((group): group is NonNullable<typeof group> => !!group).map((group) => [group.id, group]))
    events = events.filter((event) => !event.groupId || (groups.get(event.groupId)?.momentSharing ?? 'enabled') === 'enabled')
  }
  return events
    .slice(0, limit)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((event) => `- ${event.summary}`)
    .join('\n')
}

export async function recentSocialEvents(contactIds: string[], limit = 4): Promise<SocialEvent[]> {
  const ids = new Set(uniqueContactIds(contactIds))
  if (ids.size === 0) return []

  const now = Date.now()
  const events = await db.socialEvents.orderBy('createdAt').reverse().limit(120).toArray()
  return events
    .filter((event) => event.relatedContactIds.some((id) => ids.has(id)) && (!event.expiresAt || event.expiresAt > now))
    // Importance matters, but an old event must not permanently eclipse a
    // fresh one. Half-life is intentionally short for ordinary social noise.
    .sort((a, b) => {
      const score = (event: SocialEvent) => event.importance * 100 - (now - event.createdAt) / (1000 * 60 * 60 * 18)
      return score(b) - score(a)
    })
    .slice(0, limit)
}
