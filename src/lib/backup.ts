import type { Table } from 'dexie'
import { db } from '../db/db'
import type { AppSettings } from '../types'
import { ensureWalletsAfterRestore } from './finance'

const BACKUP_FORMAT = 'talk-backup'
const BACKUP_SCHEMA_VERSION = 9

export const BACKUP_TABLES = [
  'contacts',
  'conversations',
  'messages',
  'stickers',
  'inventory',
  'moments',
  'momentComments',
  'momentLikes',
  'contactRelations',
  'groups',
  'knowledgeEntries',
  'libraryItems',
  'savedWorldviews',
  'worldbookCollections',
  'worldbookEntries',
  'simulationState', 'contactLifeStates', 'lifeEvents', 'contactExperiences', 'aiUsageRecords',
  'aiTurns',
  'socialEvents',
  'contactMemories',
  'locations', 'worldMaps', 'locationModuleState', 'acousticEdges',
  'walletAccounts', 'walletTransactions', 'loans', 'jobListings', 'interviews', 'groupPlans', 'adminLogs', 'adminAiTraces', 'savedPersonas', 'shopPurchaseHistory',
  'contactGenerationTasks',
  'contactStorylines', 'contactSaveSnapshots', 'globalSaveSnapshots',
  'worldSnapshots',
  'mediaAssets',
] as const

export type BackupTableName = (typeof BACKUP_TABLES)[number]

export interface TalkBackup {
  format: typeof BACKUP_FORMAT
  schemaVersion: typeof BACKUP_SCHEMA_VERSION
  exportedAt: string
  appVersion?: string
  settings: Partial<AppSettings>
  tables: Record<BackupTableName, unknown[]>
}

function table(name: BackupTableName): Table {
  return db.table(name)
}

export function backupFileName(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return `talk-backup-${stamp}.json`
}

function settingsWithoutSecrets(value: unknown, key = ''): unknown {
  if (/api.?key|authorization|token|password|secret/i.test(key)) return ''
  if (Array.isArray(value)) return value.map((item) => settingsWithoutSecrets(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).flatMap(([childKey, childValue]) =>
      typeof childValue === 'function' ? [] : [[childKey, settingsWithoutSecrets(childValue, childKey)]],
    ))
  }
  return value
}

export function mergeSettingsPreservingSecrets(restored: Partial<AppSettings>, current: AppSettings): Partial<AppSettings> {
  const merge = (incoming: unknown, existing: unknown, key = ''): unknown => {
    if (/api.?key|authorization|token|password|secret/i.test(key)) return existing ?? ''
    if (Array.isArray(incoming)) return incoming
    if (incoming && typeof incoming === 'object') {
      const existingRecord = existing && typeof existing === 'object' ? existing as Record<string, unknown> : {}
      return Object.fromEntries(Object.entries(incoming).map(([childKey, childValue]) => [childKey, merge(childValue, existingRecord[childKey], childKey)]))
    }
    return incoming
  }
  return merge(restored, current) as Partial<AppSettings>
}

export async function createBackup(settings: Partial<AppSettings>): Promise<TalkBackup> {
  const entries = await Promise.all(BACKUP_TABLES.map(async (name) => [name, await table(name).toArray()] as const))
  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined,
    settings: settingsWithoutSecrets(settings) as Partial<AppSettings>,
    tables: Object.fromEntries(entries) as Record<BackupTableName, unknown[]>,
  }
}

export function assertTalkBackup(value: unknown): asserts value is TalkBackup {
  if (!value || typeof value !== 'object') throw new Error('备份文件格式不正确')
  const backup = value as Partial<TalkBackup>
  if (backup.format !== BACKUP_FORMAT) throw new Error('这不是 Talk 的备份文件')
  if (![1, 2, 3, 4, 5, 6, 7, 8, BACKUP_SCHEMA_VERSION].includes(backup.schemaVersion as number)) throw new Error('备份版本暂不支持')
  if (!backup.tables || typeof backup.tables !== 'object') throw new Error('备份文件缺少数据表')
  for (const name of BACKUP_TABLES) {
    if (['libraryItems','worldbookCollections','worldbookEntries','simulationState','contactLifeStates','lifeEvents','contactExperiences','aiUsageRecords','socialEvents','contactMemories','walletAccounts','walletTransactions','loans','jobListings','interviews','groupPlans','adminLogs','adminAiTraces','savedPersonas','shopPurchaseHistory','locations','worldMaps','locationModuleState','acousticEdges','contactGenerationTasks','contactStorylines','contactSaveSnapshots','globalSaveSnapshots','worldSnapshots','mediaAssets'].includes(name) && backup.tables[name] === undefined) continue
    if (!Array.isArray(backup.tables[name])) throw new Error(`备份文件缺少 ${name} 表`)
  }
}

export async function restoreBackup(backup: TalkBackup) {
  assertTalkBackup(backup)
  await db.transaction(
    'rw',
    BACKUP_TABLES.map((name) => table(name)),
    async () => {
      for (const name of BACKUP_TABLES) await table(name).clear()
      for (const name of BACKUP_TABLES) {
        const rows = backup.tables[name] ?? []
        if (rows.length > 0) await table(name).bulkPut(rows)
      }
      const restoredCollections = backup.tables.worldbookCollections ?? []
      const restoredEntries = backup.tables.worldbookEntries ?? []
      if (restoredCollections.length === 0 && restoredEntries.length > 0) {
        const now = Date.now()
        await db.worldbookCollections.put({ id: 'default-worldbook', name: '默认世界书', enabled: true, sourceType: 'manual', createdAt: now, updatedAt: now })
        const legacyEntries = await db.worldbookEntries.toArray()
        await db.worldbookEntries.bulkUpdate(legacyEntries.map((entry) => ({ key: entry.id, changes: { collectionId: 'default-worldbook', foundationalWorldview: entry.foundationalWorldview === true } })))
      }
      if ((backup.tables.libraryItems ?? []).length === 0) {
        const now = Date.now()
        const collections = await db.worldbookCollections.toArray()
        for (const entry of await db.worldbookEntries.toArray()) {
          const collection = collections.find((item) => item.id === entry.collectionId)
          await db.libraryItems.put({ id: `restored-worldbook:${entry.id}`, packageId: `restored-collection:${entry.collectionId}`, sourceType: 'worldbook', title: entry.title, content: entry.content, keywords: entry.keywords, sourceLabel: collection?.sourceLabel || collection?.name || '恢复的世界书', sourceFileName: collection?.sourceFileName, rawData: entry.rawData, createdAt: entry.createdAt || now, updatedAt: entry.updatedAt || now })
        }
        for (const item of await db.knowledgeEntries.toArray()) await db.libraryItems.put({ id: `restored-knowledge:${item.id}`, sourceType: 'web', title: item.topic, content: item.content, keywords: item.sourceQuery ? [item.sourceQuery] : [], sourceLabel: '恢复的旧知识库', fetchedAt: item.fetchedAt, createdAt: item.fetchedAt || now, updatedAt: item.fetchedAt || now })
      }
      const worlds = await db.worldbookCollections.toArray()
      const defaultWorldviewId = backup.settings.defaultWorldviewId || worlds.find((world) => world.enabled)?.id || worlds[0]?.id
      if (defaultWorldviewId) {
        const contacts = await db.contacts.toArray()
        for (const contact of contacts) if (!contact.worldviewId) await db.contacts.update(contact.id, { worldviewId: defaultWorldviewId })
        for (const group of await db.groups.toArray()) if (!group.worldviewId) {
          const first = contacts.find((contact) => group.memberContactIds.includes(contact.id))
          await db.groups.update(group.id, { worldviewId: first?.worldviewId || defaultWorldviewId })
        }
      }
    },
  )
  // Generated speech is a disposable derivative of message text and provider
  // settings. Never let cache rows from the pre-restore history attach to a
  // restored message that happens to reuse the same id.
  await db.speechCache.clear()
  await ensureWalletsAfterRestore(backup.settings)
}
