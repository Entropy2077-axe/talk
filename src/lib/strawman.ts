import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type {
  AiTurnDebug,
  Contact,
  ContactMemory,
  ContactRelationLink,
  Conversation,
  Message,
  Moment,
  MomentComment,
  MomentLike,
  SocialEvent,
} from '../types'

export interface StrawmanResult {
  id: string
  name: string
}

function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nextStrawmanName(source: Contact, contacts: Contact[]): string {
  const prefix = `${source.name}-稻草人-`
  const maxIndex = contacts.reduce((max, contact) => {
    if (!contact.name.startsWith(prefix)) return max
    const index = Number(contact.name.slice(prefix.length))
    return Number.isInteger(index) && index > max ? index : max
  }, 0)
  return `${prefix}${String(maxIndex + 1).padStart(2, '0')}`
}

function replaceContactId(value: string | undefined, sourceId: string, newId: string): string | undefined {
  return value === sourceId ? newId : value
}

export async function createStrawmanContact(sourceId: string): Promise<StrawmanResult> {
  return db.transaction(
    'rw',
    [
      db.contacts,
      db.conversations,
      db.messages,
      db.aiTurns,
      db.contactMemories,
      db.contactRelations,
      db.moments,
      db.momentComments,
      db.momentLikes,
      db.socialEvents,
    ],
    async () => {
      const source = await db.contacts.get(sourceId)
      if (!source) throw new Error('联系人不存在，无法创建稻草人')

      const allContacts = await db.contacts.toArray()
      const now = Date.now()
      const newContactId = uuid()
      const newName = nextStrawmanName(source, allContacts)
      const newContact: Contact = {
        ...cloneData(source),
        id: newContactId,
        name: newName,
        createdAt: now,
      }
      delete newContact.remark
      await db.contacts.add(newContact)

      const memories = await db.contactMemories.where('contactId').equals(sourceId).toArray()
      const copiedMemories: ContactMemory[] = memories.map((memory) => ({
        ...cloneData(memory),
        id: uuid(),
        contactId: newContactId,
      }))
      if (copiedMemories.length > 0) await db.contactMemories.bulkAdd(copiedMemories)

      const conversationIdMap = new Map<string, string>()
      const aiTurnIdMap = new Map<string, string>()
      const messageIdMap = new Map<string, string>()
      const conversations = await db.conversations.where('contactId').equals(sourceId).toArray()
      for (const conversation of conversations) {
        const newConversationId = uuid()
        conversationIdMap.set(conversation.id, newConversationId)
        const copiedConversation: Conversation = {
          ...cloneData(conversation),
          id: newConversationId,
          contactId: newContactId,
          groupId: undefined,
          createdAt: now,
          updatedAt: now,
        }
        await db.conversations.add(copiedConversation)

        const aiTurns = await db.aiTurns.where('conversationId').equals(conversation.id).toArray()
        const copiedTurns: AiTurnDebug[] = aiTurns.map((turn) => {
          const newTurnId = uuid()
          aiTurnIdMap.set(turn.id, newTurnId)
          return {
            ...cloneData(turn),
            id: newTurnId,
            conversationId: newConversationId,
          }
        })
        if (copiedTurns.length > 0) await db.aiTurns.bulkAdd(copiedTurns)

        const messages = await db.messages.where('conversationId').equals(conversation.id).toArray()
        const copiedMessages: Message[] = messages.map((message) => {
          const newMessageId = uuid()
          messageIdMap.set(message.id, newMessageId)
          const copied = {
            ...cloneData(message),
            id: newMessageId,
            conversationId: newConversationId,
          }
          if (copied.replyToMessageId) copied.replyToMessageId = messageIdMap.get(copied.replyToMessageId) ?? copied.replyToMessageId
          if (copied.debugAiTurnId) copied.debugAiTurnId = aiTurnIdMap.get(copied.debugAiTurnId) ?? copied.debugAiTurnId
          return copied
        })
        if (copiedMessages.length > 0) await db.messages.bulkAdd(copiedMessages)
      }

      const relations = await db.contactRelations
        .filter((relation) => relation.fromContactId === sourceId || relation.toContactId === sourceId)
        .toArray()
      const copiedRelations: ContactRelationLink[] = relations.map((relation) => ({
        ...cloneData(relation),
        id: uuid(),
        fromContactId: replaceContactId(relation.fromContactId, sourceId, newContactId)!,
        toContactId: replaceContactId(relation.toContactId, sourceId, newContactId)!,
        createdAt: now,
      }))
      if (copiedRelations.length > 0) await db.contactRelations.bulkAdd(copiedRelations)

      const momentIdMap = new Map<string, string>()
      const moments = await db.moments.where('contactId').equals(sourceId).toArray()
      const copiedMoments: Moment[] = moments.map((moment) => {
        const newMomentId = uuid()
        momentIdMap.set(moment.id, newMomentId)
        return {
          ...cloneData(moment),
          id: newMomentId,
          contactId: newContactId,
        }
      })
      if (copiedMoments.length > 0) await db.moments.bulkAdd(copiedMoments)

      const copiedMomentIds = new Set(momentIdMap.keys())
      const comments = await db.momentComments
        .filter((comment) => copiedMomentIds.has(comment.momentId) || comment.authorContactId === sourceId)
        .toArray()
      const commentIdMap = new Map<string, string>()
      const copiedComments: MomentComment[] = comments.map((comment) => {
        const newCommentId = uuid()
        commentIdMap.set(comment.id, newCommentId)
        return {
          ...cloneData(comment),
          id: newCommentId,
          momentId: momentIdMap.get(comment.momentId) ?? comment.momentId,
          authorContactId: replaceContactId(comment.authorContactId, sourceId, newContactId)!,
        }
      })
      for (const comment of copiedComments) {
        if (comment.replyToCommentId) comment.replyToCommentId = commentIdMap.get(comment.replyToCommentId) ?? comment.replyToCommentId
      }
      if (copiedComments.length > 0) await db.momentComments.bulkAdd(copiedComments)

      const likes = await db.momentLikes
        .filter((like) => copiedMomentIds.has(like.momentId) || like.likerId === sourceId)
        .toArray()
      const copiedLikes: MomentLike[] = likes.map((like) => ({
        ...cloneData(like),
        id: uuid(),
        momentId: momentIdMap.get(like.momentId) ?? like.momentId,
        likerId: replaceContactId(like.likerId, sourceId, newContactId)!,
      }))
      if (copiedLikes.length > 0) await db.momentLikes.bulkAdd(copiedLikes)

      const socialEvents = await db.socialEvents
        .filter(
          (event) =>
            event.actorId === sourceId ||
            event.targetId === sourceId ||
            event.relatedContactIds.includes(sourceId) ||
            (event.conversationId ? conversationIdMap.has(event.conversationId) : false) ||
            (event.momentId ? momentIdMap.has(event.momentId) : false) ||
            (event.messageId ? messageIdMap.has(event.messageId) : false),
        )
        .toArray()
      const copiedEvents: SocialEvent[] = socialEvents.map((event) => ({
        ...cloneData(event),
        id: uuid(),
        actorId: replaceContactId(event.actorId, sourceId, newContactId)!,
        targetId: replaceContactId(event.targetId, sourceId, newContactId),
        relatedContactIds: event.relatedContactIds.map((id) => (id === sourceId ? newContactId : id)),
        conversationId: event.conversationId ? conversationIdMap.get(event.conversationId) ?? event.conversationId : undefined,
        momentId: event.momentId ? momentIdMap.get(event.momentId) ?? event.momentId : undefined,
        messageId: event.messageId ? messageIdMap.get(event.messageId) ?? event.messageId : undefined,
      }))
      if (copiedEvents.length > 0) await db.socialEvents.bulkAdd(copiedEvents)

      return { id: newContactId, name: newName }
    },
  )
}
