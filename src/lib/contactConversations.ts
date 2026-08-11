import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { isAiTestId } from './aiTestIsolation'

/**
 * A normal contact must always have a private conversation. Older world
 * snapshots can contain the contact record without its conversation, which
 * leaves the contact reachable from Contacts but invisible from Messages.
 */
export async function ensureContactConversations(): Promise<number> {
  return db.transaction('rw', [db.contacts, db.conversations], async () => {
    const [contacts, conversations] = await Promise.all([
      db.contacts.toArray(),
      db.conversations.toArray(),
    ])
    const contactIdsWithConversation = new Set(
      conversations.flatMap((conversation) => conversation.contactId ? [conversation.contactId] : []),
    )
    const now = Date.now()
    const missing = contacts.filter((contact) =>
      !isAiTestId(contact.id) && !contactIdsWithConversation.has(contact.id),
    )

    if (!missing.length) return 0
    await db.conversations.bulkAdd(missing.map((contact, index) => ({
      id: uuid(),
      contactId: contact.id,
      pinned: false,
      // Keep the existing conversation order stable when repairing multiple
      // legacy contacts in the same millisecond.
      createdAt: now + index,
      updatedAt: now + index,
    })))
    return missing.length
  })
}
