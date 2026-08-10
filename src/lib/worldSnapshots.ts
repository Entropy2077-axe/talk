import type { Table } from 'dexie'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'
import type { AppSettings, WorldSnapshot, WorldSnapshotData, WorldSnapshotKind, WorldbookCollection } from '../types'
import { resetAllChatTurns } from './chatEngine'
import { resetAllGroupChatTurns } from './groupChatEngine'
import { estimateWorldbookTokens } from './worldbookTokens'
import { ensureWallets, USER_WALLET_ID } from './finance'
import { resumeMediaAssets } from './imageAssets'
import { cancelAllContactGenerationTasks } from './contactGenerationTasks'

export const WORLD_SNAPSHOT_SCHEMA_VERSION = 1
export const WORLD_SNAPSHOT_MIGRATION_VERSION = 1

const WORLD_TABLES = [
  'contacts', 'conversations', 'messages', 'moments', 'momentComments', 'momentLikes',
  'contactRelations', 'groups', 'simulationState', 'contactLifeStates', 'lifeEvents',
  'contactExperiences', 'socialEvents', 'contactMemories', 'groupPlans',
  'contactGenerationTasks', 'personaCreationRecords', 'locations', 'worldMaps',
  'locationModuleState', 'acousticEdges', 'mediaAssets', 'internalTasks',
] as const

const ECONOMY_TABLES = [
  'inventory', 'walletAccounts', 'walletTransactions', 'loans', 'jobListings',
  'interviews', 'shopPurchaseHistory',
] as const

type SnapshotTableName = (typeof WORLD_TABLES)[number] | (typeof ECONOMY_TABLES)[number]

function table(name: SnapshotTableName): Table {
  return db.table(name)
}

function economySettings(settings: AppSettings): WorldSnapshotData['economySettings'] {
  return {
    userOccupation: settings.userOccupation,
    userMonthlySalary: settings.userMonthlySalary,
    userJobStartedDate: settings.userJobStartedDate,
    userLastSalaryDate: settings.userLastSalaryDate,
  }
}

async function readTables(names: readonly SnapshotTableName[]) {
  const rows = await Promise.all(names.map(async (name) => [name, structuredClone(await table(name).toArray())] as const))
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

export async function captureWorldData(worldId: string, settings = useSettingsStore.getState()): Promise<WorldSnapshotData> {
  const world = await db.worldbookCollections.get(worldId)
  if (!world) throw new Error('世界不存在')
  const [worldbookEntries, tables] = await Promise.all([
    db.worldbookEntries.where('collectionId').equals(worldId).sortBy('sourceOrder'),
    readTables(settings.worldEconomyIsolated ? [...WORLD_TABLES, ...ECONOMY_TABLES] : WORLD_TABLES),
  ])
  if (settings.worldEconomyIsolated) {
    const contactIds = new Set((tables.contacts as Array<{ id: string }> ?? []).map((contact) => contact.id))
    contactIds.add(USER_WALLET_ID)
    tables.walletAccounts = (tables.walletAccounts as Array<{ ownerId: string }> ?? []).filter((row) => contactIds.has(row.ownerId))
    tables.walletTransactions = (tables.walletTransactions as Array<{ fromOwnerId?: string; toOwnerId?: string }> ?? []).filter((row) => (row.fromOwnerId && contactIds.has(row.fromOwnerId)) || (row.toOwnerId && contactIds.has(row.toOwnerId)))
    tables.loans = (tables.loans as Array<{ lenderId: string; borrowerId: string }> ?? []).filter((row) => contactIds.has(row.lenderId) || contactIds.has(row.borrowerId))
  }
  return {
    schemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    world: structuredClone(world),
    worldbookEntries: structuredClone(worldbookEntries),
    tables,
    economySettings: settings.worldEconomyIsolated ? economySettings(settings) : undefined,
  }
}

async function storeSnapshot(worldId: string, name: string, kind: WorldSnapshotKind, data: WorldSnapshotData) {
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
  const contactCount = Array.isArray(data.tables.contacts) ? data.tables.contacts.length : 0
  const row: WorldSnapshot = {
    id: uuid(), worldId, name: name.trim() || '未命名存档', kind,
    createdAt: now, updatedAt: now, contentHash, contactCount,
    estimatedWorldviewTokens: estimateWorldbookTokens(data.worldbookEntries),
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
  if (!latest) throw new Error('这个世界还没有可复制的状态，请先完成数据迁移')
  const [world, worldbookEntries] = await Promise.all([
    db.worldbookCollections.get(worldId),
    db.worldbookEntries.where('collectionId').equals(worldId).sortBy('sourceOrder'),
  ])
  if (!world) throw new Error('世界不存在')
  const data = structuredClone(latest.snapshot)
  data.world = structuredClone(world)
  data.worldbookEntries = structuredClone(worldbookEntries)
  return storeSnapshot(worldId, name, kind, data)
}

export async function createEmptyWorld(name: string) {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('请输入世界名称')
  const existing = await db.worldbookCollections.toArray()
  if (existing.some((world) => world.name.trim() === trimmed)) throw new Error('已经有同名世界，请换一个名称')
  const now = Date.now()
  const world: WorldbookCollection = { id: uuid(), name: trimmed, enabled: true, sourceType: 'manual', createdAt: now, updatedAt: now }
  await db.worldbookCollections.add(world)
  const emptyTables = Object.fromEntries(WORLD_TABLES.map((tableName) => [tableName, []])) as Record<string, unknown[]>
  if (useSettingsStore.getState().worldEconomyIsolated) for (const tableName of ECONOMY_TABLES) emptyTables[tableName] = []
  const data: WorldSnapshotData = {
    schemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    world: structuredClone(world), worldbookEntries: [], tables: emptyTables,
    economySettings: useSettingsStore.getState().worldEconomyIsolated ? { userOccupation: '', userMonthlySalary: 0 } : undefined,
  }
  await storeSnapshot(world.id, '初始自动存档', 'automatic', data)
  return world
}

async function clearAndRestoreTables(data: WorldSnapshotData, isolateEconomy: boolean) {
  const snapshotHasEconomy = ECONOMY_TABLES.some((name) => Array.isArray(data.tables[name]))
  const names: SnapshotTableName[] = isolateEconomy && snapshotHasEconomy ? [...WORLD_TABLES, ...ECONOMY_TABLES] : [...WORLD_TABLES]
  await db.transaction('rw', [...names.map(table), db.worldbookCollections, db.worldbookEntries], async () => {
    for (const name of names) await table(name).clear()
    for (const name of names) {
      const rows = data.tables[name] ?? []
      if (rows.length) await table(name).bulkPut(rows)
    }
    await db.worldbookCollections.put({ ...data.world, updatedAt: Date.now() })
    await db.worldbookEntries.where('collectionId').equals(data.world.id).delete()
    if (data.worldbookEntries.length) await db.worldbookEntries.bulkPut(data.worldbookEntries)
  })
}

export async function restoreWorldSnapshot(snapshotId: string) {
  const target = await db.worldSnapshots.get(snapshotId)
  if (!target) throw new Error('该存档不存在')
  const settings = useSettingsStore.getState()
  const currentWorldId = settings.activeWorldId || settings.defaultWorldviewId
  resetAllChatTurns()
  resetAllGroupChatTurns()
  await cancelAllContactGenerationTasks()
  if (currentWorldId) await createWorldSnapshot(currentWorldId, `自动存档 · ${new Date().toLocaleString()}`, 'automatic')
  await clearAndRestoreTables(target.snapshot, settings.worldEconomyIsolated === true)
  const patch: Partial<AppSettings> = { activeWorldId: target.worldId, defaultWorldviewId: target.worldId }
  if (settings.worldEconomyIsolated && target.snapshot.economySettings) Object.assign(patch, target.snapshot.economySettings)
  settings.setSettings(patch)
  await ensureWallets()
  await resumeMediaAssets()
}

export async function renameWorldSnapshot(snapshotId: string, name: string) {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('存档名称不能为空')
  await db.worldSnapshots.update(snapshotId, { name: trimmed, updatedAt: Date.now() })
}

export async function deleteWorldSnapshots(ids: string[]) {
  if (ids.length) await db.worldSnapshots.bulkDelete([...new Set(ids)])
}

function legacyWorldTables(all: Record<string, any[]>, worldId: string, fallbackWorldId: string) {
  const contacts = all.contacts.filter((row) => (row.worldviewId || fallbackWorldId) === worldId)
  const contactIds = new Set(contacts.map((row) => row.id))
  const groups = all.groups.filter((row) => (row.worldviewId || fallbackWorldId) === worldId || row.memberContactIds?.some((id: string) => contactIds.has(id)))
    .map((row) => ({ ...row, worldviewId: worldId, memberContactIds: row.memberContactIds.filter((id: string) => contactIds.has(id)) }))
    .filter((row) => row.memberContactIds.length > 1)
  const groupIds = new Set(groups.map((row) => row.id))
  const conversations = all.conversations.filter((row) => contactIds.has(row.contactId) || groupIds.has(row.groupId))
  const conversationIds = new Set(conversations.map((row) => row.id))
  const moments = all.moments.filter((row) => row.contactId === 'user' || contactIds.has(row.contactId))
  const momentIds = new Set(moments.map((row) => row.id))
  return {
    contacts: contacts.map((row) => ({ ...row, worldviewId: worldId })),
    groups, conversations,
    messages: all.messages.filter((row) => conversationIds.has(row.conversationId)),
    moments,
    momentComments: all.momentComments.filter((row) => momentIds.has(row.momentId) && (row.authorContactId === 'user' || contactIds.has(row.authorContactId))),
    momentLikes: all.momentLikes.filter((row) => momentIds.has(row.momentId) && (row.likerId === 'user' || contactIds.has(row.likerId))),
    contactRelations: all.contactRelations.filter((row) => contactIds.has(row.fromContactId) && contactIds.has(row.toContactId)),
    contactLifeStates: all.contactLifeStates.filter((row) => contactIds.has(row.contactId)),
    lifeEvents: all.lifeEvents.filter((row) => contactIds.has(row.contactId)).map((row) => ({ ...row, participantContactIds: row.participantContactIds.filter((id: string) => contactIds.has(id)) })),
    contactExperiences: all.contactExperiences.filter((row) => row.contactIds.some((id: string) => contactIds.has(id))).map((row) => ({ ...row, contactIds: row.contactIds.filter((id: string) => contactIds.has(id)) })),
    socialEvents: all.socialEvents.filter((row) => contactIds.has(row.actorId) || contactIds.has(row.targetId) || row.relatedContactIds.some((id: string) => contactIds.has(id))).map((row) => ({ ...row, relatedContactIds: row.relatedContactIds.filter((id: string) => contactIds.has(id)) })),
    contactMemories: all.contactMemories.filter((row) => contactIds.has(row.contactId)),
    groupPlans: all.groupPlans.filter((row) => groupIds.has(row.groupId)),
    contactGenerationTasks: all.contactGenerationTasks.filter((row) => (row.input?.worldviewId || fallbackWorldId) === worldId || contactIds.has(row.resultContactId)),
    personaCreationRecords: all.personaCreationRecords.filter((row) => contactIds.has(row.sourceContactId)),
    mediaAssets: all.mediaAssets.filter((row) => conversationIds.has(row.conversationId) || row.ownerContactIds?.some((id: string) => contactIds.has(id)) || (row.origin === 'moment' && momentIds.has(row.originId))),
    internalTasks: all.internalTasks.filter((row) => contactIds.has(row.contactId) || conversationIds.has(row.conversationId)),
    simulationState: structuredClone(all.simulationState),
    locations: structuredClone(all.locations), worldMaps: structuredClone(all.worldMaps),
    locationModuleState: structuredClone(all.locationModuleState), acousticEdges: structuredClone(all.acousticEdges),
  } as Record<string, unknown[]>
}

let migrationPromise: Promise<void> | undefined

async function runWorldSnapshotsMigration() {
  const settings = useSettingsStore.getState()
  if ((settings.worldSnapshotMigrationVersion ?? 0) >= WORLD_SNAPSHOT_MIGRATION_VERSION) return
  const worlds = await db.worldbookCollections.toArray()
  if (!worlds.length) return
  const fallbackWorldId = settings.defaultWorldviewId || worlds.find((world) => world.enabled)?.id || worlds[0].id
  const all = await readTables(WORLD_TABLES) as Record<string, any[]>
  for (const world of worlds) {
    const existing = await db.worldSnapshots.where('worldId').equals(world.id).count()
    if (existing) continue
    const worldbookEntries = await db.worldbookEntries.where('collectionId').equals(world.id).sortBy('sourceOrder')
    const data: WorldSnapshotData = {
      schemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
      world: structuredClone(world), worldbookEntries: structuredClone(worldbookEntries),
      tables: legacyWorldTables(all, world.id, fallbackWorldId),
    }
    await storeSnapshot(world.id, '升级自动存档', 'automatic', data)
  }
  const activeId = settings.activeWorldId || fallbackWorldId
  const activeSnapshot = (await db.worldSnapshots.where('worldId').equals(activeId).toArray()).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  // A fresh install can be seeded by tests/importers immediately after the
  // first page load. Do not let an empty migration captured a moment earlier
  // erase those newly inserted rows. Real legacy installs have contacts at
  // migration start and are materialized down to the selected world here.
  if (activeSnapshot && all.contacts.length > 0) await clearAndRestoreTables(activeSnapshot.snapshot, false)
  settings.setSettings({ activeWorldId: activeId, defaultWorldviewId: activeId, worldSnapshotMigrationVersion: WORLD_SNAPSHOT_MIGRATION_VERSION })
}

export function ensureWorldSnapshotsMigrated() {
  migrationPromise ??= runWorldSnapshotsMigration()
  return migrationPromise
}
