import Dexie, { type Table } from 'dexie'
import type {
  AiTurnDebug,
  AiTestSuiteRecord,
  Contact,
  ContactMemory,
  ContactRelationLink,
  Conversation,
  Group,
  InventoryItem,
  KnowledgeEntry,
  LibraryItem,
  Message,
  Moment,
  MomentComment,
  MomentLike,
  SavedWorldview,
  WorldbookCollection,
  WorldbookEntry,
  SimulationState, ContactLifeState, LifeEvent, ContactExperience, AiUsageRecord,
  SocialEvent, GroupPlan, AdminLogRecord, AdminAiTrace, SaveSlot, ContactStoryline, ContactSaveSnapshot, GlobalSaveSnapshot, WorldSnapshot, SavedPersona, PersonaCreationRecord, ShopPurchaseHistory, ContactGenerationTask,
  Sticker, SpeechCacheRecord,
  WalletAccount, WalletTransaction, Loan, JobListing, InterviewSession,
  LocationNode, WorldMapRecord, LocationModuleState, AcousticEdge, InternalTask, MediaAsset, WorldContactState,
} from '../types'
import { compactLegacyPersonaText, removeRepeatedPersonaBiography } from '../lib/personaMigration'

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
  libraryItems!: Table<LibraryItem, string>
  savedWorldviews!: Table<SavedWorldview, string>
  worldbookCollections!: Table<WorldbookCollection, string>
  worldbookEntries!: Table<WorldbookEntry, string>
  simulationState!: Table<SimulationState, string>
  contactLifeStates!: Table<ContactLifeState, string>
  lifeEvents!: Table<LifeEvent, string>
  contactExperiences!: Table<ContactExperience, string>
  aiUsageRecords!: Table<AiUsageRecord, string>
  aiTurns!: Table<AiTurnDebug, string>
  aiTestSuites!: Table<AiTestSuiteRecord, string>
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
  contactStorylines!: Table<ContactStoryline, string>
  contactSaveSnapshots!: Table<ContactSaveSnapshot, string>
  globalSaveSnapshots!: Table<GlobalSaveSnapshot, string>
  worldSnapshots!: Table<WorldSnapshot, string>
  worldContactStates!: Table<WorldContactState, string>
  savedPersonas!: Table<SavedPersona, string>
  personaCreationRecords!: Table<PersonaCreationRecord, string>
  shopPurchaseHistory!: Table<ShopPurchaseHistory, string>
  contactGenerationTasks!: Table<ContactGenerationTask, string>
  locations!: Table<LocationNode, string>
  worldMaps!: Table<WorldMapRecord, string>
  locationModuleState!: Table<LocationModuleState, string>
  acousticEdges!: Table<AcousticEdge, string>
  speechCache!: Table<SpeechCacheRecord, string>
  internalTasks!: Table<InternalTask, string>
  mediaAssets!: Table<MediaAsset, string>

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
      const normalize = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
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
    // Optional 地点 module. The legacy v2 locations table was deliberately
    // removed in v3; this is a new, independently modelled map feature.
    this.version(28).stores({
      locations: 'id, parentId, sortOrder, kind',
      worldMaps: '&id, mode, seed',
      locationModuleState: '&id, currentLocationId, updatedAt',
      conversations: 'id, contactId, groupId, updatedAt, pinned, systemPinned',
      groups: 'id, kind, locationId, createdAt',
    })
    this.version(29).stores({
      acousticEdges: '&id, fromLocationId, toLocationId',
    })
    this.version(30).stores({
      contactExperiences: 'id, kind, memoryTier, startedAt, endedAt, importance, *contactIds',
    })
    this.version(31).stores({
      aiTestSuites: 'id, status, kind, createdAt, updatedAt',
    })
    // Restore one-card-per-item inventory while keeping a separate catalogue
    // for products that can be repurchased from the shop.
    this.version(32).stores({
      inventory: 'id, acquiredAt',
      shopPurchaseHistory: '&productKey, lastPurchasedAt',
    }).upgrade(async (tx) => {
      const inventory = tx.table('inventory')
      const history = tx.table('shopPurchaseHistory')
      const items = await inventory.toArray() as Array<Record<string, any>>
      const normalize = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
      for (const item of items) {
        const productKey = typeof item.productKey === 'string' && item.productKey
          ? item.productKey
          : JSON.stringify([normalize(item.name), normalize(item.description), String(item.icon ?? '').trim(), Math.round(Number(item.price || 0) * 100) / 100])
        const quantity = Number.isFinite(item.quantity) ? Math.max(0, Math.floor(item.quantity)) : 1
        await history.put({
          productKey,
          name: String(item.name || ''),
          description: String(item.description || ''),
          icon: String(item.icon || ''),
          price: Number(item.price || 0),
          purchaseCount: Math.max(1, quantity),
          firstPurchasedAt: Number(item.acquiredAt || Date.now()),
          lastPurchasedAt: Number(item.updatedAt || item.acquiredAt || Date.now()),
        })
        if (quantity === 0) {
          await inventory.delete(item.id)
          continue
        }
        await inventory.put({ ...item, productKey, quantity: undefined, updatedAt: undefined })
        for (let index = 1; index < quantity; index += 1) {
          await inventory.add({ ...item, id: crypto.randomUUID(), productKey, quantity: undefined, updatedAt: undefined, acquiredAt: Number(item.acquiredAt || Date.now()) + index })
        }
      }
    })
    this.version(33).stores({
      contactGenerationTasks: 'id, status, createdAt, updatedAt',
    })
    // Unified source library. Existing worldbook/knowledge rows are copied,
    // never removed: old backups and in-flight generation tasks stay valid.
    this.version(34).stores({
      libraryItems: 'id, packageId, parentId, sourceType, updatedAt, *keywords',
      contacts: 'id, name, worldviewId, createdAt',
      groups: 'id, kind, worldviewId, locationId, createdAt',
    }).upgrade(async (tx) => {
      const now = Date.now()
      const collections = await tx.table('worldbookCollections').toArray() as Array<Record<string, any>>
      const entries = await tx.table('worldbookEntries').toArray() as Array<Record<string, any>>
      const library = tx.table('libraryItems')
      for (const entry of entries) {
        const collection = collections.find((item) => item.id === entry.collectionId)
        await library.put({
          id: `legacy-worldbook:${entry.id}`,
          packageId: `legacy-collection:${entry.collectionId || 'default'}`,
          sourceType: 'worldbook',
          title: String(entry.title || '未命名世界书条目'),
          content: String(entry.content || ''),
          keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
          sourceLabel: String(collection?.sourceLabel || collection?.name || '旧世界书'),
          sourceFileName: typeof collection?.sourceFileName === 'string' ? collection.sourceFileName : undefined,
          rawData: entry.rawData,
          createdAt: Number(entry.createdAt || now),
          updatedAt: Number(entry.updatedAt || now),
        })
      }
      const knowledge = await tx.table('knowledgeEntries').toArray() as Array<Record<string, any>>
      for (const item of knowledge) await library.put({
        id: `legacy-knowledge:${item.id}`,
        sourceType: 'web',
        title: String(item.topic || item.sourceQuery || '联网资料'),
        content: String(item.content || ''),
        keywords: item.sourceQuery ? [String(item.sourceQuery)] : [],
        sourceLabel: '旧知识库',
        fetchedAt: Number(item.fetchedAt || now),
        createdAt: Number(item.fetchedAt || now),
        updatedAt: Number(item.fetchedAt || now),
      })
      let defaultWorldId = String(collections.find((item) => item.enabled)?.id || collections[0]?.id || '')
      if (!defaultWorldId) {
        defaultWorldId = 'default-worldview'
        await tx.table('worldbookCollections').put({ id: defaultWorldId, name: '默认现实世界', enabled: true, sourceType: 'manual', createdAt: now, updatedAt: now })
      }
      const contacts = await tx.table('contacts').toArray() as Array<Record<string, any>>
      for (const contact of contacts) if (!contact.worldviewId) await tx.table('contacts').update(contact.id, { worldviewId: defaultWorldId })
      const groups = await tx.table('groups').toArray() as Array<Record<string, any>>
      for (const group of groups) if (!group.worldviewId) {
        const firstMember = contacts.find((contact) => Array.isArray(group.memberContactIds) && group.memberContactIds.includes(contact.id))
        await tx.table('groups').update(group.id, { worldviewId: firstMember?.worldviewId || defaultWorldId })
      }
    })
    // Scoped save history: contacts own story branches and snapshots, while
    // worldbooks/maps remain global resources with their own version history.
    this.version(35).stores({
      contactStorylines: 'id, contactId, worldviewId, updatedAt',
      contactSaveSnapshots: 'id, contactId, storylineId, createdAt, [contactId+createdAt], [storylineId+createdAt]',
      globalSaveSnapshots: 'id, resourceType, resourceId, createdAt, [resourceType+resourceId], [resourceId+createdAt]',
    })
    this.version(36).stores({
      speechCache: '&id, messageId, provider, lastAccessedAt',
    })
    this.version(37).stores({
      internalTasks: 'id, contactId, conversationId, status, createdAt',
    })
    this.version(38).stores({
      mediaAssets: 'id, origin, originId, conversationId, provider, status, createdAt, updatedAt, *ownerContactIds',
    })
    this.version(39).stores({
      worldSnapshots: 'id, worldId, kind, createdAt, updatedAt, [worldId+updatedAt]',
    })
    // Compatibility index for per-world contact story fields. Complete
    // contacts now live in world snapshots and only the active world's set is
    // materialized in `contacts`.
    this.version(40).stores({
      worldContactStates: 'id, worldId, contactId, [worldId+contactId], updatedAt',
    })
    // Remove retired virtual-life scene data while preserving the standard
    // location map, its shared conversation, and all contact positions.
    this.version(41).upgrade(async (tx) => {
      const groups = await tx.table('groups').toArray() as Array<Record<string, any>>
      const retiredGroupIds = groups
        .filter((group) => group.sceneMode === 'slg' || String(group.id || '').startsWith('talk-slg-location-group:'))
        .map((group) => String(group.id))
      const retiredGroupIdSet = new Set(retiredGroupIds)
      const conversations = await tx.table('conversations').toArray() as Array<Record<string, any>>
      const retiredConversationIds = conversations
        .filter((conversation) => retiredGroupIdSet.has(String(conversation.groupId || '')) || String(conversation.id || '').startsWith('talk-slg-location-conversation:'))
        .map((conversation) => String(conversation.id))
      if (retiredConversationIds.length) {
        const retiredConversationIdSet = new Set(retiredConversationIds)
        const messages = await tx.table('messages').toArray() as Array<Record<string, any>>
        await tx.table('messages').bulkDelete(messages.filter((message) => retiredConversationIdSet.has(String(message.conversationId || ''))).map((message) => message.id))
        await tx.table('conversations').bulkDelete(retiredConversationIds)
      }
      if (retiredGroupIds.length) await tx.table('groups').bulkDelete(retiredGroupIds)
      const locationState = await tx.table('locationModuleState').get('active') as Record<string, any> | undefined
      if (locationState && 'slgCurrentLocationId' in locationState) {
        delete locationState.slgCurrentLocationId
        await tx.table('locationModuleState').put(locationState)
      }
    })
    // Collapse legacy persona fragments and experience/life-event data into
    // the two canonical runtime sources: contacts.systemPrompt and
    // contactMemories. Retired tables stay empty for backup compatibility.
    this.version(42).upgrade(async (tx) => {
      const contacts = await tx.table('contacts').toArray() as Array<Record<string, any>>
      for (const contact of contacts) {
        const profile = contact.personaProfile as Record<string, unknown> | undefined
        const profileLines = [
          Array.isArray(profile?.facts) && profile.facts.length ? `身份与背景：${profile.facts.join('；')}` : '',
          Array.isArray(profile?.boundaries) && profile.boundaries.length ? `关系边界：${profile.boundaries.join('；')}` : '',
          Array.isArray(profile?.habits) && profile.habits.length ? `稳定习惯：${profile.habits.join('；')}` : '',
          Array.isArray(profile?.behaviorAnchors) && profile.behaviorAnchors.length ? `行为方式：${profile.behaviorAnchors.join('；')}` : '',
        ].filter(Boolean)
        const customTraits = Array.isArray(contact.customPersonalityTraits)
          ? contact.customPersonalityTraits.map((trait: Record<string, any>) => `${trait.name || ''}：${trait.meaning || ''}`).filter((line: string) => line !== '：')
          : []
        const trait = contact.personalityTrait && contact.personalityTrait !== '无' ? String(contact.personalityTrait) : ''
        const samples = Array.isArray(contact.speechSamples) && contact.speechSamples.length ? `说话方式参考：\n${contact.speechSamples.map((sample: string) => `- ${sample}`).join('\n')}` : ''
        const parts = [String(contact.systemPrompt || '').trim(), contact.personaConstraints ? `补充设定：${String(contact.personaConstraints).trim()}` : '', profileLines.length ? `人物事实与行为：\n${profileLines.join('\n')}` : '', trait || customTraits.length ? `性格表现：\n${[trait, ...customTraits].filter(Boolean).join('\n')}` : '', samples].filter(Boolean)
        contact.systemPrompt = Array.from(new Set(parts)).join('\n\n')
        delete contact.personaConstraints
        delete contact.personaProfile
        delete contact.personalityTrait
        delete contact.customPersonalityTraits
        delete contact.speechSamples
        delete contact.mbti
        delete contact.intentQueue
        await tx.table('contacts').put(contact)
      }
      const memories = tx.table('contactMemories')
      const experiences = await tx.table('contactExperiences').toArray() as Array<Record<string, any>>
      for (const experience of experiences) for (const contactId of experience.contactIds ?? []) await memories.add({
        id: crypto.randomUUID(), contactId, scope: (experience.contactIds?.length ?? 0) > 1 ? 'interpersonal' : 'private',
        relatedContactIds: (experience.contactIds ?? []).filter((id: string) => id !== contactId), category: '重要事件', kind: 'relationship_event',
        content: [experience.periodLabel, experience.title, experience.summary, experience.details].filter(Boolean).join('｜'), tags: ['迁移记忆'],
        importance: Math.max(0, Math.min(1, Number(experience.importance || 70) / 100)), emotionalWeight: 0.5, confidence: 1,
        sourceMessageIds: [], createdAt: Number(experience.endedAt || experience.createdAt || Date.now()), updatedAt: Date.now(), usageCount: 0,
      })
      const lifeEvents = await tx.table('lifeEvents').toArray() as Array<Record<string, any>>
      for (const event of lifeEvents.filter((row) => Number(row.importance || 0) >= 3)) await memories.add({
        id: crypto.randomUUID(), contactId: event.contactId, scope: (event.participantContactIds?.length ?? 0) ? 'interpersonal' : 'private', relatedContactIds: event.participantContactIds ?? [],
        category: '四季日常', kind: (event.participantContactIds?.length ?? 0) ? 'relationship_event' : 'general', content: String(event.summary || ''), tags: ['迁移生活事件'],
        importance: 0.6, emotionalWeight: 0.4, confidence: 0.8, sourceMessageIds: [], createdAt: Number(event.occurredAt || Date.now()), updatedAt: Date.now(), usageCount: 0,
      })
      await tx.table('contactExperiences').clear()
      await tx.table('lifeEvents').clear()
      await tx.table('simulationState').clear()
    })
    // `sharedHistory` used to be a third, parallel source of past facts. Move
    // it into unified memory and retire the contact field so new prompts have
    // only persona + memory as canonical sources.
    this.version(43).upgrade(async (tx) => {
      const contacts = await tx.table('contacts').toArray() as Array<Record<string, any>>
      const memories = tx.table('contactMemories')
      for (const contact of contacts) {
        const content = typeof contact.sharedHistory === 'string' ? contact.sharedHistory.trim() : ''
        if (content) {
          const existing = await memories.where('contactId').equals(contact.id).toArray() as Array<Record<string, any>>
          if (!existing.some((memory) => String(memory.content || '').trim() === content)) await memories.add({
            id: crypto.randomUUID(), contactId: contact.id, scope: 'private', relatedContactIds: [],
            category: '关系记忆', kind: 'relationship_event', content, tags: ['迁移记忆'],
            importance: 0.85, emotionalWeight: 0.7, confidence: 1, sourceMessageIds: [],
            createdAt: Number(contact.createdAt || Date.now()), updatedAt: Date.now(), usageCount: 0,
          })
        }
        delete contact.sharedHistory
        await tx.table('contacts').put(contact)
      }
    })
    // v42 mechanically concatenated every retired persona field, even when
    // the generated narrative already contained the same details. Compact
    // only that recognizable legacy shape into the single canonical persona.
    this.version(44).upgrade(async (tx) => {
      const contacts = await tx.table('contacts').toArray() as Array<Record<string, any>>
      for (const contact of contacts) {
        const compacted = compactLegacyPersonaText(contact.systemPrompt)
        if (compacted !== contact.systemPrompt) {
          contact.systemPrompt = compacted
          await tx.table('contacts').put(contact)
        }
      }
    })
    // Some v44 rows had already lost the old section headings while still
    // containing a complete second biography. Remove only the recognizable
    // repeated-name biography shape; do not rewrite ordinary custom personas.
    this.version(45).upgrade(async (tx) => {
      const contacts = await tx.table('contacts').toArray() as Array<Record<string, any>>
      for (const contact of contacts) {
        const cleaned = removeRepeatedPersonaBiography(contact.systemPrompt, contact.name)
        if (cleaned !== contact.systemPrompt) {
          contact.systemPrompt = cleaned
          await tx.table('contacts').put(contact)
        }
      }
    })
    // The separate life-simulation state is retired. Offline events now use
    // schedules/locations directly and write only meaningful facts to memory.
    this.version(46).upgrade(async (tx) => {
      await tx.table('contactLifeStates').clear()
    })
  }
}

export const db = new TalkDB()
