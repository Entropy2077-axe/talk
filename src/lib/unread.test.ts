import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../types'
import { readConversationSummary, trackConversationSummaries, unreadCountFor } from './unread'
import { db } from '../db/db'

const base: Message = { id: 'm', conversationId: 'c', role: 'assistant', type: 'text', content: 'hello', createdAt: 2 }

describe('unreadCountFor', () => {
  it('does not count system-presented turn illustrations as incoming chat messages', () => {
    const illustration: Message = {
      ...base,
      id: 'illustration',
      type: 'image',
      content: '[本轮配图]',
      image: { assetId: 'asset', presentation: 'illustration' },
      createdAt: 3,
    }
    expect(unreadCountFor(0, [base, illustration])).toBe(1)
  })
})

describe('indexed conversation summaries', () => {
  let stop: (() => void) | undefined
  beforeEach(async () => {
    await Promise.all([db.messages.clear(), db.conversations.clear()])
    await db.conversations.bulkAdd(['c', 'other', 'ai-test-hidden'].map((id) => ({ id, pinned: false, createdAt: 1, updatedAt: 1, lastReadAt: 1 })))
  })
  afterEach(() => { stop?.(); stop = undefined })

  it('excludes outgoing and illustration messages, and uses an exclusive read boundary', async () => {
    await db.messages.bulkAdd([
      { ...base, id: 'read', createdAt: 1 },
      base,
      { ...base, id: 'outgoing', role: 'user', createdAt: 3 },
      { ...base, id: 'illustration', type: 'image', image: { presentation: 'illustration' }, createdAt: 4 },
      { ...base, id: 'other', conversationId: 'other', createdAt: 5 },
    ])
    expect(await readConversationSummary('c')).toEqual({ count: 1, lastMessage: expect.objectContaining({ id: 'outgoing' }) })
    await db.conversations.update('c', { lastReadAt: 2 })
    expect((await readConversationSummary('c')).count).toBe(0)
  })

  it('tracks edits, deletion, read changes, and newly restored conversations without exposing test data', async () => {
    let current: Parameters<Parameters<typeof trackConversationSummaries>[0]>[0] | undefined
    stop = trackConversationSummaries((value) => { current = value })
    await db.messages.bulkAdd([base, { ...base, id: 'hidden', conversationId: 'ai-test-hidden' }])
    await vi.waitFor(() => expect(current?.total).toBe(1))
    expect(current?.byConversation.has('ai-test-hidden')).toBe(false)
    await db.messages.update('m', { content: 'edited' })
    await vi.waitFor(() => expect(current?.lastMessageByConversation.get('c')?.content).toBe('edited'))
    await db.conversations.update('c', { lastReadAt: 2 })
    await vi.waitFor(() => expect(current?.total).toBe(0))
    await db.messages.delete('m')
    await vi.waitFor(() => expect(current?.lastMessageByConversation.has('c')).toBe(false))
    await db.conversations.delete('c')
    await vi.waitFor(() => expect(current?.byConversation.has('c')).toBe(false))
    await db.conversations.add({ id: 'restored', pinned: false, createdAt: 1, updatedAt: 1 })
    await db.messages.add({ ...base, id: 'restored-message', conversationId: 'restored' })
    await vi.waitFor(() => expect(current?.total).toBe(1))
  })
})
