import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import type { Contact } from '../types'
import { ensureContactConversations } from './contactConversations'

function contact(id: string): Contact {
  return {
    id, name: id, avatar: '🙂', avatarColor: '#eee', systemPrompt: '测试人设', createdAt: 1,
    memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0,
    relationshipBase: '朋友', relationshipDynamic: '',
  }
}

describe('ensureContactConversations', () => {
  beforeEach(async () => {
    await Promise.all([db.conversations.clear(), db.contacts.clear()])
  })

  it('creates a missing normal contact conversation without duplicating existing or test conversations', async () => {
    await db.contacts.bulkAdd([contact('missing'), contact('existing'), contact('ai-test-contact')])
    await db.conversations.add({ id: 'existing-conversation', contactId: 'existing', pinned: false, createdAt: 1, updatedAt: 1 })

    expect(await ensureContactConversations()).toBe(1)
    expect(await db.conversations.where('contactId').equals('missing').count()).toBe(1)
    expect(await db.conversations.where('contactId').equals('existing').count()).toBe(1)
    expect(await db.conversations.where('contactId').equals('ai-test-contact').count()).toBe(0)
    expect(await ensureContactConversations()).toBe(0)
  })
})
