import { useEffect } from 'react'
import Dexie, { liveQuery } from 'dexie'
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

/** Read only the latest visible message and the unread range for one conversation. */
export async function readConversationSummary(conversationId: string): Promise<{ count: number; lastMessage?: Message }> {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation || isAiTestId(conversationId)) return { count: 0 }
  const range = () => db.messages.where('[conversationId+createdAt]')
    .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey], true, true)
  const [count, lastMessage] = await Promise.all([
    db.messages.where('[conversationId+createdAt]')
      .between([conversationId, conversation.lastReadAt ?? 0], [conversationId, Dexie.maxKey], false, true)
      .filter((message) => message.role === 'assistant' && message.image?.presentation !== 'illustration').count(),
    range().reverse().filter((message) => message.image?.presentation !== 'illustration').first(),
  ])
  return { count, lastMessage }
}

const useUnreadStore = create<UnreadCounts>(() => EMPTY_COUNTS)

/** One shared tracker; each conversation observes only its own indexed message range. */
export function trackConversationSummaries(publish: (counts: UnreadCounts) => void): () => void {
  const subscriptions = new Map<string, { unsubscribe: () => void }>()
  const summaries = new Map<string, { count: number; lastMessage?: Message }>()
  function emit() {
    const byConversation = new Map<string, number>()
    const lastMessageByConversation = new Map<string, Message>()
    let total = 0
    for (const [id, summary] of summaries) {
      byConversation.set(id, summary.count)
      total += summary.count
      if (summary.lastMessage) lastMessageByConversation.set(id, summary.lastMessage)
    }
    publish({ byConversation, lastMessageByConversation, total })
  }
  const registry = liveQuery(() => db.conversations.toCollection().primaryKeys()).subscribe({
    next(keys) {
      const ids = new Set<string>(keys.filter((id): boolean => !isAiTestId(id)))
      let removed = false
      for (const [id, subscription] of subscriptions) {
        if (!ids.has(id)) { subscription.unsubscribe(); subscriptions.delete(id); summaries.delete(id); removed = true }
      }
      if (removed) emit()
      for (const id of ids) {
        if (subscriptions.has(id)) continue
        const subscription = liveQuery(() => readConversationSummary(id)).subscribe({
          next(summary) { if (subscriptions.has(id)) { summaries.set(id, summary); emit() } },
          error(error) { console.error('Unread conversation query failed', error) },
        })
        subscriptions.set(id, subscription)
      }
    },
    error(error) { console.error('Unread conversation registry failed', error) },
  })
  return () => { registry.unsubscribe(); for (const subscription of subscriptions.values()) subscription.unsubscribe(); subscriptions.clear() }
}

let subscribed = false
function startUnreadTracking() {
  if (subscribed) return
  subscribed = true
  trackConversationSummaries((counts) => useUnreadStore.setState(counts))
}

/** Total unread across all conversations. Backed by the shared per-conversation tracker. */
export function useTotalUnread(): number {
  useEffect(startUnreadTracking, [])
  return useUnreadStore((s) => s.total)
}

/** Per-conversation unread counts from the same shared per-conversation tracker. */
export function useUnreadByConversation(): Map<string, number> {
  useEffect(startUnreadTracking, [])
  return useUnreadStore((s) => s.byConversation)
}

/** Latest message for each conversation, queried by the same tracker as unread counts. */
export function useLastMessageByConversation(): Map<string, Message> {
  useEffect(startUnreadTracking, [])
  return useUnreadStore((s) => s.lastMessageByConversation)
}
