import { useEffect } from 'react'
import { liveQuery } from 'dexie'
import { create } from 'zustand'
import { db } from '../db/db'
import type { Message } from '../types'
import { isAiTestId } from './aiTestIsolation'

/** Only incoming (assistant) messages count as unread — the user's own sent messages never do, regardless of lastReadAt. */
export function unreadCountFor(lastReadAt: number | undefined, messages: Message[]): number {
  const since = lastReadAt ?? 0
  return messages.filter((m) => m.role === 'assistant' && m.image?.presentation !== 'illustration' && m.createdAt > since).length
}

interface UnreadCounts {
  byConversation: Map<string, number>
  lastMessageByConversation: Map<string, Message>
  total: number
}

const EMPTY_COUNTS: UnreadCounts = { byConversation: new Map(), lastMessageByConversation: new Map(), total: 0 }

/**
 * Shared unread counts computed by a single Dexie liveQuery subscription — previously every consumer
 * (BottomNav + MessagesPage + SearchOverlay) ran its own `db.messages.toArray()` full-table scan on
 * each message change. Now the scan + grouping happens once and all consumers read from this store.
 */
const useUnreadStore = create<UnreadCounts>(() => EMPTY_COUNTS)

let subscribed = false
function startUnreadTracking() {
  if (subscribed) return
  subscribed = true
  liveQuery(async () => {
    const [conversations, messages] = await Promise.all([
      db.conversations.toArray().then((items) => items.filter((item) => !isAiTestId(item.id))),
      db.messages.toArray().then((items) => items.filter((item) => !isAiTestId(item.conversationId))),
    ])
    const messagesByConv = new Map<string, Message[]>()
    const lastMessageByConversation = new Map<string, Message>()
    for (const m of messages) {
      if (m.image?.presentation === 'illustration') continue
      const arr = messagesByConv.get(m.conversationId)
      if (arr) arr.push(m)
      else messagesByConv.set(m.conversationId, [m])
      const previous = lastMessageByConversation.get(m.conversationId)
      if (!previous || m.createdAt > previous.createdAt) lastMessageByConversation.set(m.conversationId, m)
    }
    const byConversation = new Map<string, number>()
    let total = 0
    for (const c of conversations) {
      const n = unreadCountFor(c.lastReadAt, messagesByConv.get(c.id) ?? [])
      byConversation.set(c.id, n)
      total += n
    }
    return { byConversation, lastMessageByConversation, total }
  }).subscribe((value) => useUnreadStore.setState(value))
}

/** Total unread across all conversations. Backed by the shared single-scan subscription. */
export function useTotalUnread(): number {
  useEffect(startUnreadTracking, [])
  return useUnreadStore((s) => s.total)
}

/** Per-conversation unread counts from the same singleton message-table subscription. */
export function useUnreadByConversation(): Map<string, number> {
  useEffect(startUnreadTracking, [])
  return useUnreadStore((s) => s.byConversation)
}

/** Latest message for each conversation, computed during the same scan as unread counts. */
export function useLastMessageByConversation(): Map<string, Message> {
  useEffect(startUnreadTracking, [])
  return useUnreadStore((s) => s.lastMessageByConversation)
}
