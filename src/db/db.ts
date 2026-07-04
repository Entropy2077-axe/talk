import Dexie, { type Table } from 'dexie'
import type { Contact, Conversation, Location, Message, ScheduleTask, Sticker } from '../types'

export class TalkDB extends Dexie {
  contacts!: Table<Contact, string>
  conversations!: Table<Conversation, string>
  messages!: Table<Message, string>
  stickers!: Table<Sticker, string>
  locations!: Table<Location, string>
  tasks!: Table<ScheduleTask, string>

  constructor() {
    super('talk-db')
    this.version(1).stores({
      contacts: 'id, name, createdAt',
      conversations: 'id, contactId, updatedAt, pinned',
      messages: 'id, conversationId, createdAt',
      stickers: 'id, &name, createdAt',
    })
    this.version(2).stores({
      contacts: 'id, name, createdAt',
      conversations: 'id, contactId, updatedAt, pinned',
      messages: 'id, conversationId, createdAt',
      stickers: 'id, &name, createdAt',
      locations: 'id, &name',
      tasks: 'id, contactId, date',
    })
  }
}

export const db = new TalkDB()
