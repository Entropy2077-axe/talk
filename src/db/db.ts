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
  WorldbookCollection,
  WorldbookEntry,
  SimulationState, ContactLifeState, LifeEvent, AiUsageRecord,
  SocialEvent, GroupPlan, AdminLogRecord, AdminAiTrace, SaveSlot, SavedPersona, PersonaCreationRecord,
  Sticker,
  WalletAccount, WalletTransaction, Loan, JobListing, InterviewSession,
} from '../types'

export class TalkDB extends Dexie {
  contacts!: Table<Contact, string>
  conversations!: Table<Conversation, string>
  messages!: Table<Message, string>
  stickers!: Table<Sticker, string>
  inventory!: Table<InventoryItem, string>
  moments!: Table<Moment, string>
  momentComments!: Table<MomentComment, string>
  momentLikes!: Table<MomentLike, string>
  contactRelations!: Table<ContactRelationLink, string>
  groups!: Table<Group, string>
  knowledgeEntries!: Table<KnowledgeEntry, string>
  savedWorldviews!: Table<SavedWorldview, string>
  worldbookCollections!: Table<WorldbookCollection, string>
  worldbookEntries!: Table<WorldbookEntry, string>
  simulationState!: Table<SimulationState, string>
  contactLifeStates!: Table<ContactLifeState, string>
  lifeEvents!: Table<LifeEvent, string>
  aiUsageRecords!: Table<AiUsageRecord, string>
  aiTurns!: Table<AiTurnDebug, string>
  socialEvents!: Table<SocialEvent, string>
  contactMemories!: Table<ContactMemory, string>
  walletAccounts!: Table<WalletAccount, string>
  walletTransactions!: Table<WalletTransaction, string>
  loans!: Table<Loan, string>
  jobListings!: Table<JobListing, string>
  interviews!: Table<InterviewSession, string>
  groupPlans!: Table<GroupPlan, string>
  adminLogs!: Table<AdminLogRecord, string>
  adminAiTraces!: Table<AdminAiTrace, string>
  saveSlots!: Table<SaveSlot, string>
  savedPersonas!: Table<SavedPersona, string>
  personaCreationRecords!: Table<PersonaCreationRecord, string>

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
    // Structured memories gain optional scope/group/related-contact metadata.
    // Existing rows remain valid; missing scope is treated as private.
    this.version(14).stores({
      contactMemories: 'id, contactId, scope, groupId, kind, category, createdAt, *relatedContactIds',
    })
    // Dynamic relationship fields and social-event expiry are optional fields,
    // so no data migration is needed; this version records the schema step.
    this.version(15).stores({
      contactRelations: 'id, fromContactId, toContactId, lastInteractionAt',
      socialEvents: 'id, type, actorId, targetId, createdAt, expiresAt, *relatedContactIds',
    }).upgrade(async (tx) => {
      const events = await tx.table('socialEvents').toArray()
      for (const event of events) {
        if (event.expiresAt) continue
        const importance = typeof event.importance === 'number' ? event.importance : 1
        const days = importance >= 3 ? 14 : importance === 2 ? 7 : 3
        await tx.table('socialEvents').update(event.id, { expiresAt: event.createdAt + days * 24 * 60 * 60 * 1000 })
      }
    })
    // AI-to-AI relations are a symmetric social contract. Normalize legacy
    // one-way rows so every prompt can safely read either contact's view.
    this.version(16).stores({
      contactRelations: 'id, pairId, fromContactId, toContactId, lastInteractionAt',
    }).upgrade(async (tx) => {
      const table = tx.table('contactRelations')
      const rows = await table.toArray() as Array<Record<string, unknown>>
      const handled = new Set<string>()
      for (const row of rows) {
        const from = row.fromContactId as string
        const to = row.toContactId as string
        if (!from || !to) continue
        const key = [from, to].sort().join(':')
        if (handled.has(key)) continue
        handled.add(key)
        const pair = rows.filter((candidate) =>
          (candidate.fromContactId === from && candidate.toContactId === to) || (candidate.fromContactId === to && candidate.toContactId === from),
        )
        const pairId = (pair.find((item) => typeof item.pairId === 'string')?.pairId as string | undefined) || crypto.randomUUID()
        const rank = (label: unknown) => ['恋人', '家人', '暧昧对象', '好朋友', '损友', '前辈/同事', '点头之交', '普通朋友'].indexOf(String(label))
        const primary = [...pair].sort((a, b) => rank(b.label) - rank(a.label))[0]
        for (const item of pair) await table.update(item.id as string, { pairId, label: primary.label })
        if (!pair.some((item) => item.fromContactId === to && item.toContactId === from)) {
          await table.add({ ...primary, id: crypto.randomUUID(), pairId, fromContactId: to, toContactId: from })
        }
      }
    })
    this.version(17).stores({
      walletAccounts: '&ownerId, updatedAt',
      walletTransactions: 'id, &idempotencyKey, kind, fromOwnerId, toOwnerId, createdAt',
      loans: 'id, lenderId, borrowerId, status, createdAt',
      jobListings: 'id, status, createdAt',
      interviews: 'id, jobId, status, updatedAt',
    })
    // 待办功能整体移除，显式删除旧表。
    this.version(18).stores({ todos: null })
    this.version(19).stores({
      worldbookEntries: 'id, enabled, alwaysInclude, priority, updatedAt, *keywords',
    })
    this.version(20).stores({
      simulationState: 'id, lastSimulatedAt',
      contactLifeStates: '&contactId, updatedAt',
      lifeEvents: 'id, contactId, occurredAt, visibility, importance, *participantContactIds',
      aiUsageRecords: 'id, purpose, automatic, success, createdAt',
    })
    this.version(21).stores({
      groupPlans: 'id, groupId, status, scheduledAt, createdAt',
    })
    this.version(22).stores({
      adminLogs: 'id, level, createdAt',
      adminAiTraces: 'id, purpose, model, createdAt',
      saveSlots: 'id, &slot, updatedAt',
    })
    this.version(23).stores({
      savedPersonas: 'id, nickname, realName, updatedAt',
    })
    // Efficient newest-first chat pagination without loading an entire
    // conversation into memory first.
    this.version(24).stores({
      messages: 'id, conversationId, createdAt, [conversationId+createdAt]',
    })
    // Immutable Nuwa creation history. This table is deliberately omitted
    // from ordinary backups/restores so history survives rollback and wipes.
    this.version(25).stores({
      personaCreationRecords: 'id, sourceContactId, createdAt',
    }).upgrade(async (tx) => {
      const contacts = await tx.table('contacts').toArray() as Array<Record<string, any>>
      const records = tx.table('personaCreationRecords')
      for (const contact of contacts) {
        const profile = contact.creatorProfile as Record<string, any> | undefined
        const setting = typeof contact.personaConstraints === 'string' && contact.personaConstraints.trim()
          ? contact.personaConstraints.trim()
          : String(contact.systemPrompt || '')
        await records.add({
          id: crypto.randomUUID(),
          sourceContactId: contact.id,
          name: String(contact.name || '未命名角色'),
          realName: typeof contact.realName === 'string' ? contact.realName : undefined,
          nickname: typeof contact.nickname === 'string' ? contact.nickname : undefined,
          birthday: typeof contact.birthday === 'string' ? contact.birthday : undefined,
          gender: typeof contact.gender === 'string' ? contact.gender : profile?.gender,
          ageRange: typeof profile?.age === 'string' ? profile.age : undefined,
          relationship: typeof contact.relationshipBase === 'string' ? contact.relationshipBase : profile?.relationship,
          occupation: typeof contact.occupation === 'string' ? contact.occupation : profile?.occupation,
          personalityTrait: typeof contact.personalityTrait === 'string' ? contact.personalityTrait : undefined,
          hobbies: Array.isArray(profile?.hobbies) ? profile.hobbies : [],
          personaSetting: setting,
          roleDescription: typeof profile?.notes === 'string' ? profile.notes : undefined,
          persona: String(contact.systemPrompt || ''),
          personaProfile: contact.personaProfile,
          speechSamples: contact.speechSamples,
          mbti: contact.mbti,
          schedule: contact.schedule,
          sharedHistory: contact.sharedHistory,
          createdAt: Number(contact.createdAt) || Date.now(),
        })
      }
    })
    this.version(26).stores({
      worldbookCollections: 'id, enabled, updatedAt',
      worldbookEntries: 'id, collectionId, enabled, foundationalWorldview, priority, updatedAt, *keywords',
    }).upgrade(async (tx) => {
      const entries = await tx.table('worldbookEntries').toArray() as Array<Record<string, unknown>>
      if (entries.length === 0) return
      const collectionId = 'default-worldbook'
      await tx.table('worldbookCollections').put({
        id: collectionId,
        name: '默认世界书',
        enabled: true,
        sourceType: 'manual',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      for (const entry of entries) {
        await tx.table('worldbookEntries').update(entry.id, {
          collectionId: typeof entry.collectionId === 'string' && entry.collectionId ? entry.collectionId : collectionId,
          foundationalWorldview: entry.foundationalWorldview === true,
        })
      }
    })
    // Stack identical shop purchases while retaining zero-quantity products
    // in the warehouse so they can be bought again later.
    this.version(27).stores({
      inventory: 'id, productKey, acquiredAt',
    }).upgrade(async (tx) => {
      const table = tx.table('inventory')
      const items = await table.toArray() as Array<Record<string, any>>
      const groups = new Map<string, Array<Record<string, any>>>()
      const normalize = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
      for (const item of items) {
        const key = typeof item.productKey === 'string' && item.productKey
          ? item.productKey
          : JSON.stringify([normalize(item.name), normalize(item.description), String(item.icon ?? '').trim(), Math.round(Number(item.price || 0) * 100) / 100])
        groups.set(key, [...(groups.get(key) ?? []), item])
      }
      for (const [productKey, rows] of groups) {
        const [keeper, ...duplicates] = rows.sort((a, b) => Number(a.acquiredAt || 0) - Number(b.acquiredAt || 0))
        const quantity = rows.reduce((sum, row) => sum + (Number.isFinite(row.quantity) ? Math.max(0, Math.floor(row.quantity)) : 1), 0)
        await table.update(keeper.id, { productKey, quantity, updatedAt: Date.now() })
        if (duplicates.length > 0) await table.bulkDelete(duplicates.map((row) => row.id))
      }
    })
  }
}

export const db = new TalkDB()
