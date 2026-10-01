import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { nextMessageTimestamp, sendMessage } from './chatEngine'
import { sendGroupMessage } from './groupChatEngine'
import { useSettingsStore } from '../store/useSettingsStore'
import type { Contact, Group } from '../types'

const contact: Contact = { id: 'draft-contact', name: '测试', avatar: '', avatarColor: '#eee', systemPrompt: '', createdAt: 1, memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0, relationshipBase: '朋友', relationshipDynamic: '' }
const group: Group = { id: 'draft-group', name: '群', avatar: '', avatarColor: '#eee', createdAt: 1, memberContactIds: [contact.id] }

describe('chat message admission', () => {
  beforeEach(async () => {
    await Promise.all([db.messages.clear(), db.conversations.clear(), db.contacts.clear(), db.groups.clear()])
    await db.conversations.add({ id: 'draft', pinned: false, createdAt: 1, updatedAt: 1 })
  })

  it('reports unconfigured private and group sends as not stored', async () => {
    const settings = { ...useSettingsStore.getState(), apiKey: '' }
    expect(await sendMessage('draft', contact, settings, [], 'keep draft')).toBe(false)
    expect(await sendGroupMessage('draft', group, [contact], settings, [], '@测试 keep reply', [contact.id], 'reply')).toBe(false)
    expect(await db.messages.count()).toBe(0)
  })

  it('rolls back the message when the conversation update fails', async () => {
    const update = vi.spyOn(db.conversations, 'update').mockRejectedValueOnce(new Error('storage failed'))
    try {
      await expect(sendMessage('draft', contact, { ...useSettingsStore.getState(), apiKey: 'fake-key' }, [], 'keep draft')).rejects.toThrow('storage failed')
      expect(await db.messages.count()).toBe(0)
    } finally { update.mockRestore() }
  })

  it('allows recording a message in an empty location group without an API key', async () => {
    const empty: Group = { ...group, kind: 'location', locationId: 'home-living', memberContactIds: [] }
    await db.groups.add(empty)
    expect(await sendGroupMessage('draft', empty, [], { ...useSettingsStore.getState(), apiKey: '' }, [], '这里暂时没人')).toBe(true)
    expect((await db.messages.where('conversationId').equals('draft').first())?.content).toBe('这里暂时没人')
  })

  it('keeps timestamp ordering without reading the conversation body', async () => {
    await db.messages.bulkAdd([
      { id: 'latest', conversationId: 'draft', role: 'assistant', type: 'text', content: '', createdAt: 100 },
      { id: 'older-inserted-last', conversationId: 'draft', role: 'user', type: 'text', content: '', createdAt: 20 },
      { id: 'unrelated', conversationId: 'another', role: 'assistant', type: 'text', content: '', createdAt: 1000 },
    ])
    expect(await nextMessageTimestamp('draft', 50)).toBe(101)
    expect(await nextMessageTimestamp('draft', 200)).toBe(200)
    expect(await nextMessageTimestamp('empty', 50)).toBe(50)
  })
})
