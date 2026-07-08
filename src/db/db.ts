import Dexie, { type Table } from 'dexie'
import type {
  AiTurnDebug,
  Contact,
  ContactMemory,
  ContactRelationLink,
  Conversation,
  Group,
  InventoryItem,
  KnowledgeEntry,
  Message,
  Moment,
  MomentComment,
  MomentLike,
  SavedWorldview,
  SocialEvent,
  Sticker,
  Todo,
} from '../types'

export class TalkDB extends Dexie {
  contacts!: Table<Contact, string>
  conversations!: Table<Conversation, string>
  messages!: Table<Message, string>
  stickers!: Table<Sticker, string>
  todos!: Table<Todo, string>
  inventory!: Table<InventoryItem, string>
  moments!: Table<Moment, string>
  momentComments!: Table<MomentComment, string>
  momentLikes!: Table<MomentLike, string>
  contactRelations!: Table<ContactRelationLink, string>
  groups!: Table<Group, string>
  knowledgeEntries!: Table<KnowledgeEntry, string>
  savedWorldviews!: Table<SavedWorldview, string>
  aiTurns!: Table<AiTurnDebug, string>
  socialEvents!: Table<SocialEvent, string>
  contactMemories!: Table<ContactMemory, string>

  constructor() {
    super('talk-db')
    this.version(1).stores({
      contacts: 'id, name, createdAt',
      conversations: 'id, contactId, updatedAt, pinned',
      messages: 'id, conversationId, createdAt',
      stickers: 'id, &name, createdAt',
    })
    this.version(2).stores({
      locations: 'id, &name',
      tasks: 'id, contactId, date',
    })
    // Map/schedule feature was removed — drop the tables it created.
    this.version(3).stores({
      locations: null,
      tasks: null,
    })
    this.version(4).stores({
      todos: 'id, done, createdAt',
      inventory: 'id, acquiredAt',
    })
    this.version(5).stores({
      moments: 'id, contactId, createdAt',
      momentComments: 'id, momentId, authorContactId',
      momentLikes: 'id, momentId, likerId',
      contactRelations: 'id, fromContactId, toContactId',
    })
    // Group chats: conversations gain an optional groupId (mutually
    // exclusive with contactId) alongside a new groups table.
    this.version(6).stores({
      groups: 'id, createdAt',
      conversations: 'id, contactId, groupId, updatedAt, pinned',
    })
    // Knowledge base (see lib/knowledgeBase.ts). Schedule itself is NOT a
    // new table — a contact's weekly pattern/overrides are plain fields on
    // Contact (same shape as pendingEvents/upcomingPlans), unrelated to the
    // old version(2)/(3) locations+tasks map/calendar system that was
    // deleted; don't confuse the two.
    this.version(7).stores({
      knowledgeEntries: 'id, fetchedAt',
    })
    this.version(8).stores({
      savedWorldviews: 'id, createdAt',
    })
    this.version(9).stores({
      aiTurns: 'id, conversationId, createdAt',
    })
    // Commission system removed — drop the table.
    this.version(10).stores({
      commissions: null,
    })
    // 5-dimension relationship → single warmth.
    this.version(11).upgrade(async (tx) => {
      const contacts = await tx.table('contacts').toArray()
      for (const c of contacts) {
        const rel = (c as Record<string, unknown>).relationship as Record<string, number> | undefined
        if (!rel || typeof rel.affection !== 'number') continue
        const warmth = Math.round(rel.affection * 0.7 + (rel.familiarity ?? 0) * 0.3 - (rel.friction ?? 0) * 0.5 - 10)
        const clamped = Math.max(-100, Math.min(100, warmth))
        const base =
          typeof (c as Record<string, unknown>).relationshipType === 'string'
            ? (c as Record<string, unknown>).relationshipType as string
            : '朋友'
        await tx.table('contacts').update(c.id, {
          warmth: clamped,
          relationshipBase: base,
          relationshipDynamic: '',
        })
      }
    })
    this.version(12).stores({
      socialEvents: 'id, type, actorId, targetId, createdAt, *relatedContactIds',
    })
    // Structured per-item memory table (see lib/memory.ts).
    this.version(13).stores({
      contactMemories: 'id, contactId, kind, category, createdAt',
    })
  }
}

export const db = new TalkDB()
