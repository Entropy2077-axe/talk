import type { Table } from 'dexie'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'
import type {
  AppSettings, Contact, WorldContactState, WorldSnapshot, WorldSnapshotData,
  WorldSnapshotKind, WorldbookCollection, WorldbookEntry,
} from '../types'
import { resetAllChatTurns } from './chatEngine'
import { resetAllGroupChatTurns } from './groupChatEngine'
import { estimateWorldbookTokens } from './worldbookTokens'
import { ensureWallets, USER_WALLET_ID } from './finance'
import { resumeMediaAssets } from './imageAssets'
import { isAiTestId } from './aiTestIsolation'

export const WORLD_SNAPSHOT_SCHEMA_VERSION = 3
export const WORLD_SNAPSHOT_MIGRATION_VERSION = 5
export const WORLD_CONTACT_STATE_SCHEMA_VERSION = 1

/** Tables whose live rows always represent the active world's story. */
const WORLD_STORY_TABLES = [
  'conversations', 'messages', 'moments', 'momentComments', 'momentLikes',
  'contactRelations', 'groups', 'simulationState', 'contactLifeStates', 'lifeEvents',
  'contactExperiences', 'socialEvents', 'contactMemories', 'groupPlans',
  'locations', 'worldMaps', 'locationModuleState', 'acousticEdges', 'mediaAssets',
  'internalTasks',
] as const

const ECONOMY_TABLES = [
  'inventory', 'walletAccounts', 'walletTransactions', 'loans', 'jobListings',
  'interviews', 'shopPurchaseHistory',
] as const

type StoryTableName = (typeof WORLD_STORY_TABLES)[number] | (typeof ECONOMY_TABLES)[number]

/** Fields reset by a blank branch while the rest of the contact record remains
 * part of that branch's independent world-local contact set. */
export const CONTACT_STORY_FIELDS = [
  'sharedHistory',
  'memoryFacts', 'memoryStyle', 'memoryUpdatedAt', 'memoryMessageCursor',
  'warmth', 'relationshipBase', 'relationshipDynamic', 'mood',
  'lastMomentAt', 'pendingEvents', 'upcomingPlans', 'intentQueue',
  'lastProactiveMessageAt', 'proactiveTopicHistory',
  'schedule', 'scheduleOverrides',
  'currentLocationId', 'locationUpdatedAt', 'locationSource',
  'currentTaskId', 'currentTaskKind', 'currentActivity', 'taskUpdatedAt',
  'worldbookEntryIds', 'experienceCursorAt',
] as const satisfies readonly (keyof Contact)[]

const CONTACT_ECONOMY_FIELDS = ['monthlySalary', 'jobStartedDate', 'lastSalaryDate'] as const satisfies readonly (keyof Contact)[]

const BLANK_CONTACT_STORY: Partial<Contact> = {
  memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0,
  relationshipDynamic: '',
}

function table(name: StoryTableName): Table {
  return db.table(name)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function blankContactStoryState(): Partial<Contact> {
  return clone(BLANK_CONTACT_STORY)
}

function sanitizeContactStoryState(value?: Partial<Contact>, includeEconomy = true): Partial<Contact> {
  const state = blankContactStoryState()
  if (!value) return state
  const fields: readonly (keyof Contact)[] = includeEconomy ? [...CONTACT_STORY_FIELDS, ...CONTACT_ECONOMY_FIELDS] : CONTACT_STORY_FIELDS
  for (const key of fields) {
    const child = value[key]
    if (child !== undefined) Object.assign(state, { [key]: clone(child) })
  }
  return state
}

export function extractContactStoryState(contact: Contact, includeEconomy = false): Partial<Contact> {
  const state: Partial<Contact> = {}
  const fields: readonly (keyof Contact)[] = includeEconomy ? [...CONTACT_STORY_FIELDS, ...CONTACT_ECONOMY_FIELDS] : CONTACT_STORY_FIELDS
  for (const key of fields) {
    const value = contact[key]
    if (value !== undefined) Object.assign(state, { [key]: clone(value) })
  }
  return { ...blankContactStoryState(), ...state }
}

/** Preserve identity/persona fields while replacing every story field. */
export function applyContactStoryState(contact: Contact, state?: Partial<Contact>, isolateEconomy = false): Contact {
  const next = clone(contact) as Contact & Record<string, unknown>
  const initialRelationshipBase = contact.initialRelationshipBase || contact.creatorProfile?.relationship || contact.relationshipBase || '朋友'
  const initialSchedule = contact.initialSchedule ? clone(contact.initialSchedule) : contact.schedule ? clone(contact.schedule) : undefined
  const fields: readonly (keyof Contact)[] = isolateEconomy ? [...CONTACT_STORY_FIELDS, ...CONTACT_ECONOMY_FIELDS] : CONTACT_STORY_FIELDS
  for (const key of fields) delete next[key]
  delete next.worldviewId
  const story = sanitizeContactStoryState(state, isolateEconomy)
  if (!story.relationshipBase) story.relationshipBase = initialRelationshipBase
  if (!story.schedule && initialSchedule) story.schedule = initialSchedule
  return Object.assign(next, story) as Contact
}

/** Strip a legacy snapshot contact down to a reusable identity record. */
function contactBase(contact: Contact): Contact {
  return applyContactStoryState({
    ...contact,
    initialRelationshipBase: contact.initialRelationshipBase || contact.creatorProfile?.relationship || contact.relationshipBase || '朋友',
    initialSchedule: contact.initialSchedule ?? (contact.schedule ? clone(contact.schedule) : undefined),
  })
}

function economySettings(settings: AppSettings): WorldSnapshotData['economySettings'] {
  return {
    userOccupation: settings.userOccupation,
    userMonthlySalary: settings.userMonthlySalary,
    userJobStartedDate: settings.userJobStartedDate,
    userLastSalaryDate: settings.userLastSalaryDate,
  }
}

async function readTables(names: readonly StoryTableName[]) {
  const rows = await Promise.all(names.map(async (name) => [name, clone(await table(name).toArray())] as const))
  return Object.fromEntries(rows) as Record<string, unknown[]>
}

function stableValue(value: unknown, key = ''): unknown {
  if (key === 'updatedAt' || key === 'lastReadAt' || key === 'lastAccessedAt') return undefined
  if (Array.isArray(value)) return value.map((item) => stableValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([childKey, childValue]) => {
        const normalized = stableValue(childValue, childKey)
        return normalized === undefined ? [] : [[childKey, normalized]]
      }))
  }
  return value
}

async function hashSnapshot(data: WorldSnapshotData) {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(data)))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function snapshotContactStates(data: WorldSnapshotData): Record<string, Partial<Contact>> {
  if (data.schemaVersion >= 2 && data.contactStates) return Object.fromEntries(Object.entries(data.contactStates).map(([id, state]) => [id, sanitizeContactStoryState(state)]))
  const contacts = Array.isArray(data.tables?.contacts) ? data.tables.contacts as Contact[] : []
  return Object.fromEntries(contacts.map((contact) => [contact.id, extractContactStoryState(contact, true)]))
}

function snapshotContacts(data: WorldSnapshotData): Contact[] {
  const contacts = Array.isArray(data.contacts)
    ? data.contacts
    : Array.isArray(data.tables?.contacts) ? data.tables.contacts as Contact[] : []
  return contacts.filter((contact) => contact?.id && !isAiTestId(contact.id)).map(clone)
}

function snapshotContactIds(data: WorldSnapshotData): string[] {
  if (Array.isArray(data.contactIds)) return [...new Set(data.contactIds.filter(Boolean))]
  const contacts = Array.isArray(data.tables?.contacts) ? data.tables.contacts as Contact[] : []
  return [...new Set(contacts.map((contact) => contact.id).filter(Boolean))]
}

function storyContactIds(tables: Record<string, unknown[]>): Set<string> {
  const ids = new Set<string>()
  const add = (value: unknown) => { if (typeof value === 'string' && value && value !== 'user' && !isAiTestId(value)) ids.add(value) }
  const rows = (name: string) => (tables[name] ?? []) as Array<Record<string, any>>
  for (const row of rows('conversations')) add(row.contactId)
  for (const row of rows('groups')) for (const id of row.memberContactIds ?? []) add(id)
  for (const row of rows('moments')) add(row.contactId)
  for (const row of rows('momentComments')) add(row.authorContactId)
  for (const row of rows('momentLikes')) add(row.likerId)
  for (const row of rows('contactRelations')) { add(row.fromContactId); add(row.toContactId) }
  for (const name of ['contactLifeStates', 'lifeEvents', 'contactMemories', 'internalTasks']) for (const row of rows(name)) add(row.contactId)
  for (const row of rows('contactExperiences')) for (const id of row.contactIds ?? []) add(id)
  for (const row of rows('socialEvents')) { add(row.actorId); add(row.targetId); for (const id of row.relatedContactIds ?? []) add(id) }
  for (const row of rows('mediaAssets')) for (const id of row.ownerContactIds ?? []) add(id)
  return ids
}

/** Convert v1 complete-world snapshots without allowing their contact identity
 * or worldview copies to participate in normal restore. */
export function normalizeWorldSnapshotData(data: WorldSnapshotData): WorldSnapshotData {
  const tables = clone(data.tables ?? {})
  delete tables.contacts
  // Creation provenance is audit metadata, not rewindable world story.
  delete tables.personaCreationRecords
  delete tables.contactGenerationTasks
  const contacts = snapshotContacts(data)
  const contactIds = contacts.length ? contacts.map((contact) => contact.id) : snapshotContactIds(data).filter((id) => !isAiTestId(id))
  const allowedIds = new Set(contactIds)
  return {
    schemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    contacts,
    contactIds,
    contactStates: Object.fromEntries(Object.entries(snapshotContactStates(data)).filter(([id]) => allowedIds.has(id))),
    tables,
    economySettings: data.economySettings ? clone(data.economySettings) : undefined,
  }
}

async function buildContactIdentityIndex() {
  const [liveContacts, snapshots, contactSnapshots] = await Promise.all([
    db.contacts.toArray(),
    db.worldSnapshots.toArray(),
    db.contactSaveSnapshots.toArray(),
  ])
  const index = new Map<string, Contact>()
  const add = (contact?: Contact) => {
    if (contact?.id && !isAiTestId(contact.id) && !index.has(contact.id)) index.set(contact.id, contactBase(contact))
  }
  for (const contact of liveContacts) add(contact)
  for (const snapshot of snapshots) for (const contact of snapshotContacts(snapshot.snapshot)) add(contact)
  for (const snapshot of contactSnapshots) add(snapshot.snapshot?.contact)
  return index
}

/** Rebuild complete contact records for transitional backups that retained
 * membership IDs but not identity/persona payloads. */
export async function hydrateWorldSnapshotContacts(data: WorldSnapshotData, identityIndex?: Map<string, Contact>) {
  const normalized = normalizeWorldSnapshotData(data)
  const embedded = new Map((normalized.contacts ?? []).map((contact) => [contact.id, contact]))
  const ids = normalized.contactIds ?? []
  if (ids.every((id) => embedded.has(id))) return normalized
  const index = identityIndex ?? await buildContactIdentityIndex()
  normalized.contacts = ids.flatMap((id) => {
    const contact = embedded.get(id) ?? index.get(id)
    return contact ? [clone(contact)] : []
  })
  return normalized
}

async function syncWorldContactStates(worldId: string, states: Record<string, Partial<Contact>>) {
  const now = Date.now()
  const rows: WorldContactState[] = Object.entries(states).map(([contactId, state]) => ({
    id: `${worldId}:${contactId}`, worldId, contactId,
    schemaVersion: WORLD_CONTACT_STATE_SCHEMA_VERSION, state: clone(state), updatedAt: now,
  }))
  await db.transaction('rw', db.worldContactStates, async () => {
    await db.worldContactStates.where('worldId').equals(worldId).delete()
    if (rows.length) await db.worldContactStates.bulkPut(rows)
  })
}

export async function captureWorldData(worldId: string, settings = useSettingsStore.getState()): Promise<WorldSnapshotData> {
  const world = await db.worldbookCollections.get(worldId)
  if (!world) throw new Error('世界不存在')
  const [allContacts, tables] = await Promise.all([
    db.contacts.filter((contact) => !isAiTestId(contact.id)).toArray(),
    readTables(settings.worldEconomyIsolated ? [...WORLD_STORY_TABLES, ...ECONOMY_TABLES] : WORLD_STORY_TABLES),
  ])
  const referencedIds = storyContactIds(tables)
  const contacts = referencedIds.size > 0
    ? allContacts.filter((contact) => referencedIds.has(contact.id))
    : allContacts.filter((contact) => !contact.worldviewId || contact.worldviewId === worldId)
  if (settings.worldEconomyIsolated) {
    const contactIds = new Set(contacts.map((contact) => contact.id))
    contactIds.add(USER_WALLET_ID)
    tables.walletAccounts = (tables.walletAccounts as Array<{ ownerId: string }> ?? []).filter((row) => contactIds.has(row.ownerId))
    tables.walletTransactions = (tables.walletTransactions as Array<{ fromOwnerId?: string; toOwnerId?: string }> ?? []).filter((row) => (row.fromOwnerId && contactIds.has(row.fromOwnerId)) || (row.toOwnerId && contactIds.has(row.toOwnerId)))
    tables.loans = (tables.loans as Array<{ lenderId: string; borrowerId: string }> ?? []).filter((row) => contactIds.has(row.lenderId) || contactIds.has(row.borrowerId))
  }
  const contactStates = Object.fromEntries(contacts.map((contact) => [contact.id, extractContactStoryState(contact, settings.worldEconomyIsolated === true)]))
  await syncWorldContactStates(worldId, contactStates)
  return {
    schemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    contacts: contacts.map((contact) => ({ ...clone(contact), worldviewId: worldId })),
    contactIds: contacts.map((contact) => contact.id),
    contactStates,
    tables,
    economySettings: settings.worldEconomyIsolated ? economySettings(settings) : undefined,
  }
}

async function currentWorldviewTokenEstimate(worldId: string) {
  const entries = await db.worldbookEntries.where('collectionId').equals(worldId).toArray()
  return estimateWorldbookTokens(entries)
}

async function storeSnapshot(worldId: string, name: string, kind: WorldSnapshotKind, source: WorldSnapshotData) {
  const data = normalizeWorldSnapshotData(source)
  const now = Date.now()
  const contentHash = await hashSnapshot(data)
  if (kind === 'automatic') {
    const identical = (await db.worldSnapshots.where('worldId').equals(worldId).toArray())
      .filter((item) => item.kind === 'automatic' && item.contentHash === contentHash)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (identical) {
      await db.worldSnapshots.update(identical.id, { updatedAt: now })
      await db.worldbookCollections.update(worldId, { updatedAt: now })
      return { id: identical.id, created: false }
    }
  }
  const row: WorldSnapshot = {
    id: uuid(), worldId, name: name.trim() || '未命名备份', kind,
    createdAt: now, updatedAt: now, contentHash,
    contactCount: data.contactIds?.length ?? 0,
    estimatedWorldviewTokens: await currentWorldviewTokenEstimate(worldId),
    snapshotVersion: WORLD_SNAPSHOT_SCHEMA_VERSION, snapshot: data,
  }
  await db.worldSnapshots.add(row)
  await db.worldbookCollections.update(worldId, { updatedAt: now })
  return { id: row.id, created: true }
}

export async function createWorldSnapshot(worldId: string, name: string, kind: WorldSnapshotKind = 'manual') {
  const settings = useSettingsStore.getState()
  const activeWorldId = settings.activeWorldId || settings.defaultWorldviewId
  if (!activeWorldId || activeWorldId === worldId) return storeSnapshot(worldId, name, kind, await captureWorldData(worldId))
  const latest = (await db.worldSnapshots.where('worldId').equals(worldId).toArray()).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (!latest) throw new Error('这个世界还没有可复制的状态')
  return storeSnapshot(worldId, name, kind, latest.snapshot)
}

async function blankWorldData(contactTemplates: Contact[] = []): Promise<WorldSnapshotData> {
  const contacts = contactTemplates.filter((contact) => !isAiTestId(contact.id)).map((contact) => applyContactStoryState(contactBase(contact)))
  return {
    schemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    contacts,
    contactIds: contacts.map((contact) => contact.id),
    contactStates: Object.fromEntries(contacts.map((contact) => [contact.id, blankContactStoryState()])),
    tables: Object.fromEntries(
      [...WORLD_STORY_TABLES, ...(useSettingsStore.getState().worldEconomyIsolated ? ECONOMY_TABLES : [])]
        .map((name) => [name, [] as unknown[]]),
    ),
    economySettings: useSettingsStore.getState().worldEconomyIsolated ? { userOccupation: '', userMonthlySalary: 0 } : undefined,
  }
}

async function createInitialBlankSnapshot(worldId: string, contacts: Contact[] = []) {
  return storeSnapshot(worldId, '初始自动备份', 'automatic', await blankWorldData(contacts))
}

export async function createEmptyWorld(name: string) {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('请输入世界名称')
  const existing = await db.worldbookCollections.toArray()
  if (existing.some((world) => world.name.trim() === trimmed)) throw new Error('已经有同名世界，请换一个名称')
  const now = Date.now()
  const world: WorldbookCollection = { id: uuid(), name: trimmed, enabled: true, sourceType: 'manual', createdAt: now, updatedAt: now }
  await db.worldbookCollections.add(world)
  try { await createInitialBlankSnapshot(world.id) }
  catch (error) { await db.worldbookCollections.delete(world.id); throw error }
  return world
}

function sanitizeStoryTables(tables: Record<string, unknown[]>, currentContactIds: Set<string>) {
  const next = clone(tables)
  const groups: Array<Record<string, any>> = ((next.groups ?? []) as Array<Record<string, any>>)
    .map((row): Record<string, any> => ({ ...row, memberContactIds: (row.memberContactIds ?? []).filter((id: string) => currentContactIds.has(id)) }))
    .filter((row) => row.memberContactIds.length >= 2)
  const groupIds = new Set(groups.map((row) => row.id))
  const conversations = ((next.conversations ?? []) as Array<Record<string, any>>)
    .filter((row) => (row.contactId && currentContactIds.has(row.contactId)) || (row.groupId && groupIds.has(row.groupId)))
  const conversationIds = new Set(conversations.map((row) => row.id))
  const moments = ((next.moments ?? []) as Array<Record<string, any>>)
    .filter((row) => row.contactId === 'user' || currentContactIds.has(row.contactId))
  const momentIds = new Set(moments.map((row) => row.id))
  next.groups = groups
  next.conversations = conversations
  next.messages = ((next.messages ?? []) as Array<Record<string, any>>).filter((row) => conversationIds.has(row.conversationId))
  next.moments = moments
  next.momentComments = ((next.momentComments ?? []) as Array<Record<string, any>>).filter((row) => momentIds.has(row.momentId) && (row.authorContactId === 'user' || currentContactIds.has(row.authorContactId)))
  next.momentLikes = ((next.momentLikes ?? []) as Array<Record<string, any>>).filter((row) => momentIds.has(row.momentId) && (row.likerId === 'user' || currentContactIds.has(row.likerId)))
  next.contactRelations = ((next.contactRelations ?? []) as Array<Record<string, any>>).filter((row) => currentContactIds.has(row.fromContactId) && currentContactIds.has(row.toContactId))
  next.contactLifeStates = ((next.contactLifeStates ?? []) as Array<Record<string, any>>).filter((row) => currentContactIds.has(row.contactId))
  next.lifeEvents = ((next.lifeEvents ?? []) as Array<Record<string, any>>).filter((row) => currentContactIds.has(row.contactId)).map((row) => ({ ...row, participantContactIds: (row.participantContactIds ?? []).filter((id: string) => currentContactIds.has(id)) }))
  next.contactExperiences = ((next.contactExperiences ?? []) as Array<Record<string, any>>).map((row) => ({ ...row, contactIds: (row.contactIds ?? []).filter((id: string) => currentContactIds.has(id)) })).filter((row) => row.contactIds.length > 0)
  next.socialEvents = ((next.socialEvents ?? []) as Array<Record<string, any>>).filter((row) => currentContactIds.has(row.actorId) || currentContactIds.has(row.targetId) || (row.relatedContactIds ?? []).some((id: string) => currentContactIds.has(id))).map((row) => ({ ...row, relatedContactIds: (row.relatedContactIds ?? []).filter((id: string) => currentContactIds.has(id)) }))
  next.contactMemories = ((next.contactMemories ?? []) as Array<Record<string, any>>).filter((row) => currentContactIds.has(row.contactId))
  next.groupPlans = ((next.groupPlans ?? []) as Array<Record<string, any>>).filter((row) => groupIds.has(row.groupId))
  next.mediaAssets = ((next.mediaAssets ?? []) as Array<Record<string, any>>).filter((row) => conversationIds.has(row.conversationId) || (row.ownerContactIds ?? []).some((id: string) => currentContactIds.has(id)) || (row.origin === 'moment' && momentIds.has(row.originId)))
  next.internalTasks = ((next.internalTasks ?? []) as Array<Record<string, any>>).filter((row) => currentContactIds.has(row.contactId) || conversationIds.has(row.conversationId))
  return next
}

async function restoreStoryData(worldId: string, source: WorldSnapshotData, isolateEconomy: boolean) {
  const data = normalizeWorldSnapshotData(source)
  const currentContacts = (await db.contacts.toArray()).filter((contact) => !isAiTestId(contact.id))
  const currentById = new Map(currentContacts.map((contact) => [contact.id, contact]))
  const contactRecords = (data.contacts?.length ? data.contacts : (data.contactIds ?? []).flatMap((id) => currentById.get(id) ? [currentById.get(id)!] : []))
    .filter((contact) => !isAiTestId(contact.id))
  const contactIds = new Set(contactRecords.map((contact) => contact.id))
  const sanitized = sanitizeStoryTables(data.tables, contactIds)
  const snapshotHasEconomy = ECONOMY_TABLES.some((name) => Array.isArray(sanitized[name]))
  const names: StoryTableName[] = isolateEconomy && snapshotHasEconomy ? [...WORLD_STORY_TABLES, ...ECONOMY_TABLES] : [...WORLD_STORY_TABLES]
  const storedIds = new Set(data.contactIds ?? [])
  const states = data.contactStates ?? {}
  const projected = contactRecords.map((contact) => ({
    ...applyContactStoryState(contact, storedIds.has(contact.id) ? states[contact.id] : undefined, isolateEconomy),
    worldviewId: worldId,
  }))
  const stateRows: WorldContactState[] = projected.map((contact) => ({
    id: `${worldId}:${contact.id}`, worldId, contactId: contact.id,
    schemaVersion: WORLD_CONTACT_STATE_SCHEMA_VERSION,
    state: extractContactStoryState(contact, isolateEconomy), updatedAt: Date.now(),
  }))
  await db.transaction('rw', [...names.map(table), db.contacts, db.worldContactStates], async () => {
    for (const name of names) await table(name).clear()
    for (const name of names) {
      const rows = sanitized[name] ?? []
      if (rows.length) await table(name).bulkPut(rows)
    }
    await db.contacts.clear()
    if (projected.length) await db.contacts.bulkPut(projected)
    await db.worldContactStates.where('worldId').equals(worldId).delete()
    if (stateRows.length) await db.worldContactStates.bulkPut(stateRows)
  })
  return data
}

export interface RestoreWorldSnapshotOptions { backupCurrent?: boolean }

export async function restoreWorldSnapshot(snapshotId: string, options: RestoreWorldSnapshotOptions = {}) {
  const target = await db.worldSnapshots.get(snapshotId)
  if (!target) throw new Error('该备份不存在')
  const hydrated = await hydrateWorldSnapshotContacts(target.snapshot)
  const missingContactCount = (hydrated.contactIds?.length ?? 0) - (hydrated.contacts?.length ?? 0)
  if (missingContactCount > 0) throw new Error(`这个旧备份有 ${missingContactCount} 位联系人只剩 ID，完整资料无法恢复。已阻止读取，当前数据没有改变。`)
  if ((target.snapshot.contacts?.length ?? 0) !== (hydrated.contacts?.length ?? 0)) {
    await db.worldSnapshots.update(target.id, { snapshot: hydrated, snapshotVersion: WORLD_SNAPSHOT_SCHEMA_VERSION })
  }
  const settings = useSettingsStore.getState()
  const currentWorldId = settings.activeWorldId || settings.defaultWorldviewId
  const backupCurrent = options.backupCurrent !== false
  if (backupCurrent && currentWorldId) await createWorldSnapshot(currentWorldId, `自动备份 · ${new Date().toLocaleString()}`, 'automatic')
  resetAllChatTurns()
  resetAllGroupChatTurns()
  const data = await restoreStoryData(target.worldId, hydrated, settings.worldEconomyIsolated === true)
  const patch: Partial<AppSettings> = { activeWorldId: target.worldId, defaultWorldviewId: target.worldId }
  if (settings.worldEconomyIsolated && data.economySettings) Object.assign(patch, data.economySettings)
  settings.setSettings(patch)
  await ensureWallets()
  await resumeMediaAssets()
}

export async function switchWorld(worldId: string) {
  const settings = useSettingsStore.getState()
  const currentWorldId = settings.activeWorldId || settings.defaultWorldviewId
  if (currentWorldId === worldId) return { changed: false }
  const world = await db.worldbookCollections.get(worldId)
  if (!world) throw new Error('目标世界不存在')
  if (currentWorldId) await createWorldSnapshot(currentWorldId, `自动备份 · ${new Date().toLocaleString()}`, 'automatic')
  let latest = (await db.worldSnapshots.where('worldId').equals(worldId).toArray()).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (!latest) {
    const result = await createInitialBlankSnapshot(worldId)
    const created = await db.worldSnapshots.get(result.id)
    if (created) latest = created
  }
  if (!latest) throw new Error('无法创建目标世界的初始备份')
  await restoreWorldSnapshot(latest.id, { backupCurrent: false })
  return { changed: true, snapshotId: latest.id }
}

function remapEntryReferences(data: WorldSnapshotData, entryIds: Map<string, string>, targetWorldId: string) {
  const next = normalizeWorldSnapshotData(data)
  for (const state of Object.values(next.contactStates ?? {})) {
    if (Array.isArray(state.worldbookEntryIds)) state.worldbookEntryIds = state.worldbookEntryIds.map((id) => entryIds.get(id) ?? id)
  }
  next.tables.contactExperiences = ((next.tables.contactExperiences ?? []) as Array<Record<string, any>>).map((row) => ({
    ...row,
    sourceRefIds: Array.isArray(row.sourceRefIds) ? row.sourceRefIds.map((id: string) => entryIds.get(id) ?? id) : row.sourceRefIds,
  }))
  next.tables.groups = ((next.tables.groups ?? []) as Array<Record<string, any>>).map((row) => ({ ...row, worldviewId: targetWorldId }))
  return next
}

export async function createWorldBranch(name: string, blank = false) {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('请输入分支名称')
  const settings = useSettingsStore.getState()
  const sourceWorldId = settings.activeWorldId || settings.defaultWorldviewId
  if (!sourceWorldId) throw new Error('当前没有可复制的世界')
  const existing = await db.worldbookCollections.toArray()
  if (existing.some((world) => world.name.trim() === trimmed)) throw new Error('已经有同名世界或分支')
  const sourceWorld = await db.worldbookCollections.get(sourceWorldId)
  if (!sourceWorld) throw new Error('当前世界不存在')
  await createWorldSnapshot(sourceWorldId, `自动备份 · ${new Date().toLocaleString()}`, 'automatic')
  const [sourceEntries, sourceData] = await Promise.all([
    db.worldbookEntries.where('collectionId').equals(sourceWorldId).sortBy('sourceOrder'),
    blank ? db.contacts.filter((contact) => !isAiTestId(contact.id)).toArray().then((contacts) => blankWorldData(contacts)) : captureWorldData(sourceWorldId),
  ])
  const now = Date.now()
  const world: WorldbookCollection = { ...clone(sourceWorld), id: uuid(), name: trimmed, enabled: true, sourceFileName: undefined, sourceLabel: `分支自 ${sourceWorld.name}`, createdAt: now, updatedAt: now }
  const entryIds = new Map(sourceEntries.map((entry) => [entry.id, uuid()]))
  const entries: WorldbookEntry[] = sourceEntries.map((entry) => ({
    ...clone(entry), id: entryIds.get(entry.id)!, collectionId: world.id,
    sourceEntryId: entry.sourceEntryId && entryIds.has(entry.sourceEntryId) ? entryIds.get(entry.sourceEntryId) : entry.sourceEntryId,
    createdAt: now, updatedAt: now,
  }))
  await db.transaction('rw', db.worldbookCollections, db.worldbookEntries, async () => {
    await db.worldbookCollections.add(world)
    if (entries.length) await db.worldbookEntries.bulkAdd(entries)
  })
  try {
    const data = blank ? sourceData : remapEntryReferences(sourceData, entryIds, world.id)
    const initial = await storeSnapshot(world.id, blank ? '空白分支初始备份' : '分支初始备份', 'automatic', data)
    await restoreWorldSnapshot(initial.id, { backupCurrent: false })
    return world
  } catch (error) {
    await deleteWorld(world.id)
    throw error
  }
}

export async function renameWorldSnapshot(snapshotId: string, name: string) {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('备份名称不能为空')
  await db.worldSnapshots.update(snapshotId, { name: trimmed, updatedAt: Date.now() })
}

export async function deleteWorldSnapshots(ids: string[]) {
  if (ids.length) await db.worldSnapshots.bulkDelete([...new Set(ids)])
}

export async function getWorldDeletionImpact(worldId: string) {
  const [entries, snapshots, stateRows] = await Promise.all([
    db.worldbookEntries.where('collectionId').equals(worldId).count(),
    db.worldSnapshots.where('worldId').equals(worldId).toArray(),
    db.worldContactStates.where('worldId').equals(worldId).count(),
  ])
  const latest = [...snapshots].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const data = latest ? normalizeWorldSnapshotData(latest.snapshot) : undefined
  return {
    worldbookEntries: entries, backups: snapshots.length,
    contactsAffected: data?.contactIds?.length ?? stateRows,
    conversations: data?.tables.conversations?.length ?? 0,
    messages: data?.tables.messages?.length ?? 0,
    moments: data?.tables.moments?.length ?? 0,
    groups: data?.tables.groups?.length ?? 0,
    experiences: data?.tables.contactExperiences?.length ?? 0,
  }
}

export async function deleteWorld(worldId: string) {
  const active = useSettingsStore.getState().activeWorldId || useSettingsStore.getState().defaultWorldviewId
  if (active === worldId) throw new Error('当前世界不能删除，请先切换到其他世界')
  await db.transaction('rw', [db.worldbookCollections, db.worldbookEntries, db.worldSnapshots, db.worldContactStates, db.contactStorylines, db.globalSaveSnapshots], async () => {
    await db.worldbookEntries.where('collectionId').equals(worldId).delete()
    await db.worldSnapshots.where('worldId').equals(worldId).delete()
    await db.worldContactStates.where('worldId').equals(worldId).delete()
    await db.contactStorylines.where('worldviewId').equals(worldId).delete()
    const legacyGlobal = await db.globalSaveSnapshots.filter((row) => row.resourceId === worldId).primaryKeys()
    if (legacyGlobal.length) await db.globalSaveSnapshots.bulkDelete(legacyGlobal as string[])
    await db.worldbookCollections.delete(worldId)
  })
}

/** Legacy pre-world-snapshot partitioning used only by migration. */
function legacyWorldTables(all: Record<string, any[]>, worldId: string, fallbackWorldId: string) {
  const contacts = all.contacts.filter((row) => (row.worldviewId || fallbackWorldId) === worldId)
  const contactIds = new Set(contacts.map((row) => row.id))
  const groups = all.groups.filter((row) => (row.worldviewId || fallbackWorldId) === worldId || row.memberContactIds?.some((id: string) => contactIds.has(id)))
    .map((row) => ({ ...row, memberContactIds: row.memberContactIds.filter((id: string) => contactIds.has(id)) }))
    .filter((row) => row.memberContactIds.length > 1)
  const groupIds = new Set(groups.map((row) => row.id))
  const conversations = all.conversations.filter((row) => contactIds.has(row.contactId) || groupIds.has(row.groupId))
  const conversationIds = new Set(conversations.map((row) => row.id))
  const moments = all.moments.filter((row) => row.contactId === 'user' || contactIds.has(row.contactId))
  const momentIds = new Set(moments.map((row) => row.id))
  return {
    contacts,
    groups, conversations,
    messages: all.messages.filter((row) => conversationIds.has(row.conversationId)),
    moments,
    momentComments: all.momentComments.filter((row) => momentIds.has(row.momentId) && (row.authorContactId === 'user' || contactIds.has(row.authorContactId))),
    momentLikes: all.momentLikes.filter((row) => momentIds.has(row.momentId) && (row.likerId === 'user' || contactIds.has(row.likerId))),
    contactRelations: all.contactRelations.filter((row) => contactIds.has(row.fromContactId) && contactIds.has(row.toContactId)),
    contactLifeStates: all.contactLifeStates.filter((row) => contactIds.has(row.contactId)),
    lifeEvents: all.lifeEvents.filter((row) => contactIds.has(row.contactId)),
    contactExperiences: all.contactExperiences.filter((row) => row.contactIds?.some((id: string) => contactIds.has(id))),
    socialEvents: all.socialEvents.filter((row) => contactIds.has(row.actorId) || contactIds.has(row.targetId) || row.relatedContactIds?.some((id: string) => contactIds.has(id))),
    contactMemories: all.contactMemories.filter((row) => contactIds.has(row.contactId)),
    groupPlans: all.groupPlans.filter((row) => groupIds.has(row.groupId)),
    mediaAssets: all.mediaAssets.filter((row) => conversationIds.has(row.conversationId) || row.ownerContactIds?.some((id: string) => contactIds.has(id)) || (row.origin === 'moment' && momentIds.has(row.originId))),
    internalTasks: all.internalTasks.filter((row) => contactIds.has(row.contactId) || conversationIds.has(row.conversationId)),
    simulationState: clone(all.simulationState), locations: clone(all.locations), worldMaps: clone(all.worldMaps),
    locationModuleState: clone(all.locationModuleState), acousticEdges: clone(all.acousticEdges),
  } as Record<string, unknown[]>
}

let migrationPromise: Promise<void> | undefined

async function runWorldSnapshotsMigration() {
  const settings = useSettingsStore.getState()
  const startingMigrationVersion = settings.worldSnapshotMigrationVersion ?? 0
  if (startingMigrationVersion >= WORLD_SNAPSHOT_MIGRATION_VERSION) return
  const worlds = await db.worldbookCollections.toArray()
  if (!worlds.length) return
  const fallbackWorldId = settings.defaultWorldviewId || worlds.find((world) => world.enabled)?.id || worlds[0].id
  const activeId = settings.activeWorldId || fallbackWorldId
  const currentContacts = await db.contacts.toArray()
  const currentById = new Map(currentContacts.map((contact) => [contact.id, clone(contact)]))
  const allForLegacy = {
    contacts: currentContacts,
    ...await readTables(WORLD_STORY_TABLES) as Record<string, any[]>,
  } as Record<string, any[]>
  let repairedActiveSnapshotId: string | undefined
  if (startingMigrationVersion >= 4 && worlds.some((world) => world.id === activeId)) {
    const repaired = await storeSnapshot(activeId, '联系人归属修复备份', 'automatic', await captureWorldData(activeId, settings))
    repairedActiveSnapshotId = repaired.id
  }

  // Ensure every legacy world has at least one source backup before identity
  // rows are merged globally.
  for (const world of worlds) {
    if (await db.worldSnapshots.where('worldId').equals(world.id).count()) continue
    const legacy = legacyWorldTables(allForLegacy, world.id, fallbackWorldId)
    await storeSnapshot(world.id, '升级自动备份', 'automatic', {
      schemaVersion: 1,
      world: world,
      worldbookEntries: await db.worldbookEntries.where('collectionId').equals(world.id).toArray(),
      tables: legacy,
    })
  }

  // A pre-v1 database may still have several worlds mixed in the live tables.
  // Capture the selected partition explicitly so materializing it below cannot
  // accidentally choose an older backup.
  let legacyActiveSnapshotId: string | undefined
  if (startingMigrationVersion < 1) {
    const activeWorld = worlds.find((world) => world.id === activeId)
    if (activeWorld) {
      const result = await storeSnapshot(activeId, '升级当前世界备份', 'automatic', {
        schemaVersion: 1,
        world: activeWorld,
        worldbookEntries: await db.worldbookEntries.where('collectionId').equals(activeId).toArray(),
        tables: legacyWorldTables(allForLegacy, activeId, fallbackWorldId),
      })
      legacyActiveSnapshotId = result.id
    }
  }

  const snapshots = (await db.worldSnapshots.toArray()).sort((a, b) => b.updatedAt - a.updatedAt)
  const globalById = await buildContactIdentityIndex()
  // Current live rows are always the most reliable global identity source.
  for (const contact of currentContacts) globalById.set(contact.id, contactBase(contact))
  for (const snapshot of snapshots) {
    const legacyContacts = Array.isArray(snapshot.snapshot.tables?.contacts) ? snapshot.snapshot.tables.contacts as Contact[] : []
    for (const contact of legacyContacts) if (!globalById.has(contact.id)) globalById.set(contact.id, contactBase(contact))
  }

  // Project the current active state for live contacts; contacts discovered
  // only in inactive backups join this world with a blank story.
  const activeLegacyIds = new Set(currentContacts.filter((contact) => (contact.worldviewId || fallbackWorldId) === activeId).map((contact) => contact.id))
  const merged = [...globalById.values()].map((base) => {
    const live = currentById.get(base.id)
    return live && activeLegacyIds.has(base.id)
      ? applyContactStoryState(base, extractContactStoryState(live, settings.worldEconomyIsolated === true), settings.worldEconomyIsolated === true)
      : applyContactStoryState(base)
  })
  await db.transaction('rw', db.contacts, async () => {
    await db.contacts.clear()
    if (merged.length) await db.contacts.bulkPut(merged)
  })

  // Persist global identities before stripping legacy contact rows from any
  // snapshot. If migration is interrupted, a retry can still rebuild from the
  // contacts table and remains idempotent.
  for (const snapshot of snapshots) {
    const existingContacts = snapshotContacts(snapshot.snapshot)
    // V2 retained each backup's membership IDs even though identities were
    // global. Materialize independent copies from those IDs so no historical
    // world loses contacts during the split.
    const recordedIds = snapshotContactIds(snapshot.snapshot)
    const referencedIds = storyContactIds(snapshot.snapshot.tables ?? {})
    const memberIds = referencedIds.size > 0 ? recordedIds.filter((id) => referencedIds.has(id)) : recordedIds
    const migratedContacts = memberIds
      .flatMap((id) => globalById.get(id) ? [globalById.get(id)!] : [])
    const contacts = (existingContacts.length
      ? existingContacts.filter((contact) => memberIds.includes(contact.id))
      : migratedContacts)
      .filter((contact) => !isAiTestId(contact.id))
      .map((contact) => ({ ...clone(contact), worldviewId: snapshot.worldId }))
    const normalized = await hydrateWorldSnapshotContacts({ ...snapshot.snapshot, contacts }, globalById)
    await db.worldSnapshots.update(snapshot.id, {
      snapshot: normalized,
      snapshotVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
      contactCount: normalized.contactIds?.length ?? 0,
      contentHash: await hashSnapshot(normalized),
    })
  }

  if (legacyActiveSnapshotId) {
    const selected = await db.worldSnapshots.get(legacyActiveSnapshotId)
    if (selected) await restoreStoryData(activeId, selected.snapshot, false)
  }
  if (repairedActiveSnapshotId) {
    const repaired = await db.worldSnapshots.get(repairedActiveSnapshotId)
    if (repaired) await restoreStoryData(activeId, repaired.snapshot, settings.worldEconomyIsolated === true)
  }

  // Keep a materialized latest-state index for every world. It is not used to
  // overwrite identity; it makes deletion/migration auditing explicit.
  const latestByWorld = new Map<string, WorldSnapshot>()
  for (const snapshot of await db.worldSnapshots.toArray()) {
    const current = latestByWorld.get(snapshot.worldId)
    if (!current || snapshot.updatedAt > current.updatedAt) latestByWorld.set(snapshot.worldId, snapshot)
  }
  for (const [worldId, snapshot] of latestByWorld) {
    const normalized = normalizeWorldSnapshotData(snapshot.snapshot)
    await syncWorldContactStates(worldId, normalized.contactStates ?? {})
  }
  const activeContacts = await db.contacts.toArray()
  await syncWorldContactStates(activeId, Object.fromEntries(activeContacts.map((contact) => [contact.id, extractContactStoryState(contact, settings.worldEconomyIsolated === true)])))
  settings.setSettings({ activeWorldId: activeId, defaultWorldviewId: activeId, worldSnapshotMigrationVersion: WORLD_SNAPSHOT_MIGRATION_VERSION })
}

export function ensureWorldSnapshotsMigrated() {
  if ((useSettingsStore.getState().worldSnapshotMigrationVersion ?? 0) >= WORLD_SNAPSHOT_MIGRATION_VERSION) return Promise.resolve()
  migrationPromise ??= runWorldSnapshotsMigration().finally(() => { migrationPromise = undefined })
  return migrationPromise
}
