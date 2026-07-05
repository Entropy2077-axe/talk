import Dexie, { type Table } from 'dexie'
import type {
  Commission,
  Contact,
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
  Sticker,
  Todo,
} from '../types'

export class TalkDB extends Dexie {
  contacts!: Table<Contact, string>
  conversations!: Table<Conversation, string>
  messages!: Table<Message, string>
  stickers!: Table<Sticker, string>
  todos!: Table<Todo, string>
  commissions!: Table<Commission, string>
  inventory!: Table<InventoryItem, string>
  moments!: Table<Moment, string>
  momentComments!: Table<MomentComment, string>
  momentLikes!: Table<MomentLike, string>
  contactRelations!: Table<ContactRelationLink, string>
  groups!: Table<Group, string>
  knowledgeEntries!: Table<KnowledgeEntry, string>
  savedWorldviews!: Table<SavedWorldview, string>

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
      todos: 'id, done, commissionId, createdAt',
      commissions: 'id, contactId, status, createdAt',
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
  }
}

export const db = new TalkDB()
