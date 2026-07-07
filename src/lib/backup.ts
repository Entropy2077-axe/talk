import type { Table } from 'dexie'
import { db } from '../db/db'
import type { AppSettings } from '../types'

const BACKUP_FORMAT = 'talk-backup'
const BACKUP_SCHEMA_VERSION = 1

export const BACKUP_TABLES = [
  'contacts',
  'conversations',
  'messages',
  'stickers',
  'todos',
  'inventory',
  'moments',
  'momentComments',
  'momentLikes',
  'contactRelations',
  'groups',
  'knowledgeEntries',
  'savedWorldviews',
  'aiTurns',
  'socialEvents',
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

export async function createBackup(settings: Partial<AppSettings>): Promise<TalkBackup> {
  const entries = await Promise.all(BACKUP_TABLES.map(async (name) => [name, await table(name).toArray()] as const))
  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined,
    settings,
    tables: Object.fromEntries(entries) as Record<BackupTableName, unknown[]>,
  }
}

export function assertTalkBackup(value: unknown): asserts value is TalkBackup {
  if (!value || typeof value !== 'object') throw new Error('备份文件格式不正确')
  const backup = value as Partial<TalkBackup>
  if (backup.format !== BACKUP_FORMAT) throw new Error('这不是 Talk 的备份文件')
  if (backup.schemaVersion !== BACKUP_SCHEMA_VERSION) throw new Error('备份版本暂不支持')
  if (!backup.tables || typeof backup.tables !== 'object') throw new Error('备份文件缺少数据表')
  for (const name of BACKUP_TABLES) {
    if (name === 'socialEvents' && backup.tables[name] === undefined) continue
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
    },
  )
}
