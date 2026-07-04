import Dexie, { type Table } from 'dexie'
import type { Commission, Contact, Conversation, InventoryItem, Message, Sticker, Todo } from '../types'

export class TalkDB extends Dexie {
  contacts!: Table<Contact, string>
  conversations!: Table<Conversation, string>
  messages!: Table<Message, string>
  stickers!: Table<Sticker, string>
  todos!: Table<Todo, string>
  commissions!: Table<Commission, string>
  inventory!: Table<InventoryItem, string>

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
  }
}

export const db = new TalkDB()
