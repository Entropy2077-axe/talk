import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'
import type { Contact, WorldSnapshotData } from '../types'
import {
  addContactToWorldSnapshots, captureWorldData, createEmptyWorld, createWorldBranch, createWorldSnapshot, deleteWorld,
  ensureWorldSnapshotsMigrated, hydrateWorldSnapshotContacts, normalizeWorldSnapshotData, restoreWorldSnapshot, switchWorld,
  WORLD_SNAPSHOT_MIGRATION_VERSION,
} from './worldSnapshots'
import { retrieveWorldbookContext } from './worldbook'

async function clearDatabase() {
  await db.open()
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear()
  })
}

async function addWorld(id: string, name: string) {
  await db.worldbookCollections.put({ id, name, enabled: true, sourceType: 'manual', createdAt: 1, updatedAt: 1 })
}

function contact(id: string, name: string, story: Partial<Contact> = {}): Contact {
  return {
    id, name, avatar: `${name}-avatar`, avatarColor: '#ffffff', systemPrompt: `${name}-persona`,
    createdAt: 1, relationshipBase: '朋友', relationshipDynamic: '',
    memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0,
    ...story,
  }
}

beforeEach(async () => {
  vi.restoreAllMocks()
  localStorage.clear()
  await clearDatabase()
  useSettingsStore.setState({
    activeWorldId: 'world-a', defaultWorldviewId: 'world-a', worldEconomyIsolated: false,
    worldSnapshotMigrationVersion: WORLD_SNAPSHOT_MIGRATION_VERSION,
    userOccupation: '', userMonthlySalary: 0,
  })
})

describe('world story backups', () => {
  it('keeps contacts shared when restoring an older save in the same world', async () => {
    await addWorld('world-a', '世界 A')
    await db.contacts.put(contact('red', '小红', { memoryFacts: 'A里的旧记忆', warmth: 66, sharedHistory: 'A里的共同经历' }))
    await db.conversations.put({ id: 'conv-red', contactId: 'red', pinned: false, createdAt: 1, updatedAt: 1 })
    await db.messages.put({ id: 'msg-red', conversationId: 'conv-red', role: 'assistant', type: 'text', content: '旧消息', createdAt: 2 } as any)
    await db.moments.put({ id: 'moment-red', contactId: 'red', content: '旧朋友圈', createdAt: 2 })
    await db.contactExperiences.put({ id: 'exp-red', contactIds: ['red'], kind: 'past', memoryTier: 'long', title: '旧经历', summary: '旧经历', startedAt: 1, endedAt: 2, importance: 80, createdAt: 2 } as any)
    await createWorldSnapshot('world-a', '只有小红时', 'manual')
    const old = (await db.worldSnapshots.where('worldId').equals('world-a').toArray()).find((item) => item.name === '只有小红时')!

    await db.contacts.put(contact('blue', '小明', { memoryFacts: '后来积累的记忆', warmth: 40 }))
    await db.conversations.put({ id: 'conv-blue', contactId: 'blue', pinned: false, createdAt: 3, updatedAt: 3 })
    await db.messages.put({ id: 'msg-blue', conversationId: 'conv-blue', role: 'assistant', type: 'text', content: '后来消息', createdAt: 4 } as any)

    await db.contacts.update('red', { name: '小红新名字', avatar: 'new-avatar', systemPrompt: 'new-persona', memoryFacts: '新记忆' })
    await restoreWorldSnapshot(old.id)

    const contacts = await db.contacts.toArray()
    expect(contacts.map((item) => item.id).sort()).toEqual(['blue', 'red'])
    expect(await db.contacts.get('red')).toMatchObject({ name: '小红新名字', avatar: 'new-avatar', systemPrompt: 'new-persona', memoryFacts: 'A里的旧记忆', warmth: 66 })
    expect(await db.contacts.get('blue')).toMatchObject({ name: '小明', memoryFacts: '' })
    expect(await db.conversations.get('conv-blue')).toBeUndefined()
    expect((await db.moments.toArray()).map((item) => item.id)).toEqual(['moment-red'])
    expect((await db.contactExperiences.toArray()).map((item) => item.id)).toEqual(['exp-red'])
  })

  it('restores a contact that existed when the backup was created', async () => {
    await addWorld('world-a', '世界 A')
    await db.contacts.put(contact('red', '小红', { memoryFacts: '旧记忆' }))
    await createWorldSnapshot('world-a', '删除前', 'manual')
    const backup = (await db.worldSnapshots.where('worldId').equals('world-a').first())!
    await db.contacts.delete('red')
    await restoreWorldSnapshot(backup.id)
    expect(await db.contacts.get('red')).toMatchObject({ name: '小红', memoryFacts: '旧记忆' })
  })

  it('adds a new contact to every existing save in its world', async () => {
    await addWorld('world-a', '世界 A')
    await db.contacts.put(contact('red', '小红', { worldviewId: 'world-a' }))
    await createWorldSnapshot('world-a', '早期手动存档', 'manual')
    const blue = contact('blue', '小蓝', { worldviewId: 'world-a', memoryFacts: '刚创建后的当前状态' })
    await db.contacts.put(blue)
    await addContactToWorldSnapshots(blue)

    const snapshots = await db.worldSnapshots.where('worldId').equals('world-a').toArray()
    expect(snapshots).not.toHaveLength(0)
    for (const snapshot of snapshots) {
      const data = normalizeWorldSnapshotData(snapshot.snapshot)
      expect(data.contactIds).toContain('blue')
      expect(data.contactStates?.blue).toMatchObject({ memoryFacts: '' })
    }
  })

  it("repairs old saves from the world's full historic contact roster", async () => {
    await addWorld('world-a', '世界 A')
    const red = contact('red', '小红', { worldviewId: 'world-a' })
    const blue = contact('blue', '小蓝', { worldviewId: 'world-a' })
    const green = contact('green', '小绿', { worldviewId: 'world-a' })
    // Simulate the old restore behavior: the newest live state lost 小绿,
    // while an earlier save still has the complete roster.
    await db.contacts.bulkPut([red, blue])
    const compact: WorldSnapshotData = { schemaVersion: 3, contacts: [red, blue], contactIds: ['red', 'blue'], contactStates: { red: {}, blue: {} }, tables: {} }
    const complete: WorldSnapshotData = { schemaVersion: 3, contacts: [red, blue, green], contactIds: ['red', 'blue', 'green'], contactStates: { red: {}, blue: {}, green: {} }, tables: {} }
    await db.worldSnapshots.bulkPut([
      { id: 'compact', worldId: 'world-a', name: '较新的两人存档', kind: 'automatic', createdAt: 2, updatedAt: 2, contentHash: 'compact', contactCount: 2, estimatedWorldviewTokens: 0, snapshotVersion: 3, snapshot: compact },
      { id: 'complete', worldId: 'world-a', name: '较早的三人存档', kind: 'manual', createdAt: 1, updatedAt: 1, contentHash: 'complete', contactCount: 3, estimatedWorldviewTokens: 0, snapshotVersion: 3, snapshot: complete },
    ])
    useSettingsStore.setState({ worldSnapshotMigrationVersion: 5 })

    await ensureWorldSnapshotsMigrated()
    expect(normalizeWorldSnapshotData((await db.worldSnapshots.get('compact'))!.snapshot).contactIds?.sort()).toEqual(['blue', 'green', 'red'])
    expect((await db.worldSnapshots.get('compact'))?.contactCount).toBe(3)
  })

  it('copies complete story state and independently cloned worldview entries into a normal branch', async () => {
    await addWorld('world-a', '世界 A')
    await db.worldbookEntries.put({ id: 'entry-a', collectionId: 'world-a', title: '校规', content: '夜间宵禁', keywords: [], enabled: true, priority: 50, createdAt: 1, updatedAt: 1 })
    await db.contacts.bulkPut([
      contact('red', '小红', { memoryFacts: '分支记忆', warmth: 70, worldbookEntryIds: ['entry-a'] }),
      contact('blue', '小明', { memoryFacts: '共同记忆' }),
    ])
    await db.groups.put({ id: 'group-a', name: '群', avatar: '群', avatarColor: '#fff', memberContactIds: ['red', 'blue'], worldviewId: 'world-a', createdAt: 1 })
    await db.conversations.bulkPut([
      { id: 'conv-red', contactId: 'red', pinned: false, createdAt: 1, updatedAt: 2 },
      { id: 'conv-group', groupId: 'group-a', pinned: false, createdAt: 1, updatedAt: 2 },
    ])
    await db.messages.put({ id: 'message-a', conversationId: 'conv-red', role: 'assistant', type: 'text', content: '分支消息', createdAt: 2 } as any)
    await db.moments.put({ id: 'moment-a', contactId: 'red', content: '分支朋友圈', createdAt: 2 })
    await db.contactExperiences.put({ id: 'exp-a', contactIds: ['red', 'blue'], kind: 'past', memoryTier: 'long', title: '共同经历', summary: '共同经历', startedAt: 1, endedAt: 2, importance: 80, sources: ['worldbook'], sourceRefIds: ['entry-a'], createdAt: 2 } as any)

    const branch = await createWorldBranch('世界 A · 分支', false)
    const clonedEntries = await db.worldbookEntries.where('collectionId').equals(branch.id).toArray()
    expect(clonedEntries).toHaveLength(1)
    expect(clonedEntries[0].id).not.toBe('entry-a')
    expect(clonedEntries[0].content).toBe('夜间宵禁')
    expect((await db.contacts.get('red'))?.memoryFacts).toBe('分支记忆')
    expect((await db.contacts.get('red'))?.worldbookEntryIds).toEqual([clonedEntries[0].id])
    expect(await db.messages.get('message-a')).toBeTruthy()
    expect(await db.moments.get('moment-a')).toBeTruthy()
    expect(await db.groups.get('group-a')).toMatchObject({ worldviewId: branch.id, memberContactIds: ['red', 'blue'] })
    expect((await db.contactExperiences.get('exp-a'))?.sourceRefIds).toEqual([clonedEntries[0].id])
  })

  it('copies only worldview into a blank branch while retaining global contacts', async () => {
    await addWorld('world-a', '世界 A')
    await db.worldbookEntries.put({ id: 'entry-a', collectionId: 'world-a', title: '世界规则', content: '规则正文', keywords: [], enabled: true, priority: 50, createdAt: 1, updatedAt: 1 })
    const baseSchedule = [{ id: 'base', dayOfWeek: 1, startHour: 9, endHour: 17, phoneAccess: 'unavailable' as const, location: '学校', activity: '上课' }]
    const changedSchedule = [{ id: 'changed', dayOfWeek: 1, startHour: 10, endHour: 18, phoneAccess: 'available' as const, location: '公司', activity: '工作' }]
    await db.contacts.put(contact('red', '小红', { memoryFacts: '不应复制', warmth: 88, initialRelationshipBase: '朋友', relationshipBase: '恋人', initialSchedule: baseSchedule, schedule: changedSchedule }))
    await db.conversations.put({ id: 'conv-red', contactId: 'red', pinned: false, createdAt: 1, updatedAt: 1 })
    await db.messages.put({ id: 'message-a', conversationId: 'conv-red', role: 'assistant', type: 'text', content: '不应复制', createdAt: 2 } as any)
    await db.moments.put({ id: 'moment-a', contactId: 'red', content: '不应复制', createdAt: 2 })

    const branch = await createWorldBranch('世界 A · 空白', true)
    expect((await db.worldbookEntries.where('collectionId').equals(branch.id).toArray()).map((entry) => entry.content)).toEqual(['规则正文'])
    expect((await db.contacts.toArray()).map((item) => item.id)).toEqual(['red'])
    expect(await db.contacts.get('red')).toMatchObject({ name: '小红', memoryFacts: '', relationshipBase: '朋友', schedule: baseSchedule })
    expect((await db.contacts.get('red'))?.warmth).toBeUndefined()
    expect(await db.conversations.count()).toBe(0)
    expect(await db.messages.count()).toBe(0)
    expect(await db.moments.count()).toBe(0)
  })

  it('switches through the latest backup and automatically backs up the current world', async () => {
    await addWorld('world-a', '世界 A')
    await db.contacts.put(contact('red', '小红', { memoryFacts: 'A记忆' }))
    await db.conversations.put({ id: 'conv-a', contactId: 'red', pinned: false, createdAt: 1, updatedAt: 1 })
    await db.messages.put({ id: 'message-a', conversationId: 'conv-a', role: 'assistant', type: 'text', content: 'A消息', createdAt: 2 } as any)
    const worldB = await createEmptyWorld('世界 B')

    await switchWorld(worldB.id)
    expect(await db.contacts.count()).toBe(0)
    expect(await db.messages.count()).toBe(0)
    expect((await db.worldSnapshots.where('worldId').equals('world-a').toArray()).some((item) => item.kind === 'automatic')).toBe(true)

    await db.contacts.put(contact('blue', '小蓝', { memoryFacts: 'B最新记忆' }))
    await createWorldSnapshot(worldB.id, 'B最新', 'manual')
    await switchWorld('world-a')
    expect(await db.messages.get('message-a')).toBeTruthy()
    await switchWorld(worldB.id)
    expect(await db.contacts.get('red')).toBeUndefined()
    expect((await db.contacts.get('blue'))?.memoryFacts).toBe('B最新记忆')
  })

  it('rolls back live story tables and active world when target restore fails', async () => {
    await addWorld('world-a', '世界 A')
    await db.contacts.put(contact('red', '小红'))
    await db.conversations.put({ id: 'conv-a', contactId: 'red', pinned: false, createdAt: 1, updatedAt: 1 })
    await db.messages.put({ id: 'message-a', conversationId: 'conv-a', role: 'assistant', type: 'text', content: '当前消息', createdAt: 2 } as any)
    const worldB = await createEmptyWorld('世界 B')
    const backupB = (await db.worldSnapshots.where('worldId').equals(worldB.id).first())!
    const data = normalizeWorldSnapshotData(backupB.snapshot)
    data.contacts = [contact('blue', '小蓝')]
    data.contactIds = ['blue']
    data.contactStates = { blue: {} }
    data.tables.conversations = [{ id: 'target-conv', contactId: 'blue', pinned: false, createdAt: 1, updatedAt: 1 }]
    data.tables.messages = [{ id: 'target-message', conversationId: 'target-conv', role: 'assistant', type: 'text', content: '目标', createdAt: 1 }]
    await db.worldSnapshots.update(backupB.id, { snapshot: data })
    const spy = vi.spyOn(db.contacts, 'bulkPut').mockRejectedValue(new Error('模拟恢复失败'))

    await expect(switchWorld(worldB.id)).rejects.toThrow('模拟恢复失败')
    expect(useSettingsStore.getState().activeWorldId).toBe('world-a')
    expect(await db.messages.get('message-a')).toBeTruthy()
    spy.mockRestore()
  })

  it('deletes world data without deleting global contacts', async () => {
    await addWorld('world-a', '世界 A')
    await db.contacts.put(contact('red', '小红'))
    const worldB = await createEmptyWorld('世界 B')
    await deleteWorld(worldB.id)
    expect(await db.worldbookCollections.get(worldB.id)).toBeUndefined()
    expect(await db.worldSnapshots.where('worldId').equals(worldB.id).count()).toBe(0)
    expect(await db.contacts.get('red')).toBeTruthy()
  })

  it('copies employment data into a normal branch and resets it in an isolated blank branch', async () => {
    await addWorld('world-a', '世界 A')
    await db.contacts.put(contact('red', '小红', { occupation: '设计师', monthlySalary: 9000, jobStartedDate: '2026-01-01', lastSalaryDate: '2026-08-01' }))
    await createWorldBranch('共享经济世界', false)
    expect(await db.contacts.get('red')).toMatchObject({ occupation: '设计师', monthlySalary: 9000, lastSalaryDate: '2026-08-01' })

    useSettingsStore.setState({ worldEconomyIsolated: true })
    await createWorldBranch('隔离经济世界', true)
    expect((await db.contacts.get('red'))?.occupation).toBe('设计师')
    expect((await db.contacts.get('red'))?.monthlySalary).toBeUndefined()
    expect((await db.contacts.get('red'))?.lastSalaryDate).toBeUndefined()
  })

  it('migrates a legacy complete snapshot without letting it overwrite global identity or current worldview', async () => {
    await addWorld('world-a', '世界 A')
    await db.worldbookEntries.put({ id: 'current-entry', collectionId: 'world-a', title: '当前设定', content: '当前最新世界观', keywords: [], enabled: true, priority: 50, createdAt: 1, updatedAt: 5 })
    await db.contacts.put(contact('same', '当前名字', { avatar: 'current-avatar', systemPrompt: 'current-persona', memoryFacts: '当前记忆' }))
    const oldSame = contact('same', '旧名字', { avatar: 'old-avatar', systemPrompt: 'old-persona', memoryFacts: '旧快照记忆', warmth: 77 })
    const oldOnly = contact('old-only', '旧世界联系人', { memoryFacts: '旧联系人记忆' })
    const legacyData: WorldSnapshotData = {
      schemaVersion: 1,
      world: { id: 'world-a', name: '旧世界名', enabled: true, sourceType: 'manual', createdAt: 1, updatedAt: 1 },
      worldbookEntries: [{ id: 'legacy-entry', collectionId: 'world-a', title: '旧设定', content: '不应覆盖', keywords: [], enabled: true, priority: 50, createdAt: 1, updatedAt: 1 }],
      tables: { contacts: [oldSame, oldOnly], conversations: [], messages: [] },
    }
    await db.worldSnapshots.put({ id: 'legacy-backup', worldId: 'world-a', name: '旧版完整快照', kind: 'manual', createdAt: 1, updatedAt: 1, contentHash: 'legacy', contactCount: 2, estimatedWorldviewTokens: 1, snapshotVersion: 1, snapshot: legacyData })
    useSettingsStore.setState({ worldSnapshotMigrationVersion: 1 })

    await ensureWorldSnapshotsMigrated()
    expect(await db.contacts.get('same')).toMatchObject({ name: '当前名字', avatar: 'current-avatar', systemPrompt: 'current-persona' })
    expect(await db.contacts.get('old-only')).toMatchObject({ name: '旧世界联系人', memoryFacts: '' })
    const migrated = (await db.worldSnapshots.get('legacy-backup'))!
    expect(migrated.snapshotVersion).toBe(3)
    expect(migrated.snapshot.tables.contacts).toBeUndefined()

    await restoreWorldSnapshot('legacy-backup')
    expect(await db.contacts.get('same')).toMatchObject({ name: '当前名字', avatar: 'current-avatar', systemPrompt: 'current-persona', memoryFacts: '旧快照记忆', warmth: 77 })
    expect((await db.worldbookEntries.where('collectionId').equals('world-a').toArray()).map((entry) => entry.content)).toEqual(['当前最新世界观'])
  })

  it('splits v2 global identities into each backup\'s recorded world membership', async () => {
    await addWorld('world-a', '世界 A')
    await addWorld('world-b', '世界 B')
    await db.contacts.bulkPut([contact('red', '小红'), contact('blue', '小蓝')])
    const v2 = (contactId: string, worldId: string): WorldSnapshotData => ({
      schemaVersion: 2,
      contactIds: [contactId],
      contactStates: { [contactId]: { memoryFacts: `${worldId}记忆` } },
      tables: {},
    })
    await db.worldSnapshots.bulkPut([
      { id: 'v2-a', worldId: 'world-a', name: 'A', kind: 'automatic', createdAt: 1, updatedAt: 1, contentHash: 'a', contactCount: 1, estimatedWorldviewTokens: 0, snapshotVersion: 2, snapshot: v2('red', 'world-a') },
      { id: 'v2-b', worldId: 'world-b', name: 'B', kind: 'automatic', createdAt: 1, updatedAt: 1, contentHash: 'b', contactCount: 1, estimatedWorldviewTokens: 0, snapshotVersion: 2, snapshot: v2('blue', 'world-b') },
    ])
    useSettingsStore.setState({ worldSnapshotMigrationVersion: 2 })

    await ensureWorldSnapshotsMigrated()
    expect(normalizeWorldSnapshotData((await db.worldSnapshots.get('v2-a'))!.snapshot).contacts?.map((item) => item.id)).toEqual(['red'])
    expect(normalizeWorldSnapshotData((await db.worldSnapshots.get('v2-b'))!.snapshot).contacts?.map((item) => item.id)).toEqual(['blue'])
  })

  it('repairs an id-only backup from complete contact data in another world backup', async () => {
    await addWorld('world-a', '世界 A')
    await addWorld('world-b', '世界 B')
    const red = contact('red', '小红')
    const idOnly: WorldSnapshotData = { schemaVersion: 3, contacts: [], contactIds: ['red'], contactStates: { red: { memoryFacts: '旧记忆' } }, tables: {} }
    const complete: WorldSnapshotData = { schemaVersion: 3, contacts: [red], contactIds: ['red'], contactStates: { red: {} }, tables: {} }
    await db.worldSnapshots.bulkPut([
      { id: 'id-only', worldId: 'world-a', name: '升级自动存档', kind: 'automatic', createdAt: 1, updatedAt: 1, contentHash: 'a', contactCount: 1, estimatedWorldviewTokens: 0, snapshotVersion: 3, snapshot: idOnly },
      { id: 'complete', worldId: 'world-b', name: '完整', kind: 'manual', createdAt: 2, updatedAt: 2, contentHash: 'b', contactCount: 1, estimatedWorldviewTokens: 0, snapshotVersion: 3, snapshot: complete },
    ])
    useSettingsStore.setState({ worldSnapshotMigrationVersion: 3 })

    await ensureWorldSnapshotsMigrated()
    const repaired = await hydrateWorldSnapshotContacts((await db.worldSnapshots.get('id-only'))!.snapshot)
    expect(repaired.contacts).toHaveLength(1)
    expect(repaired.contacts?.[0]).toMatchObject({ id: 'red', name: '小红' })
  })

  it('blocks restore when an old backup contact identity cannot be recovered', async () => {
    await addWorld('world-a', '世界 A')
    await db.contacts.put(contact('safe', '当前联系人'))
    await db.worldSnapshots.put({
      id: 'broken', worldId: 'world-a', name: '损坏旧备份', kind: 'manual', createdAt: 1, updatedAt: 1,
      contentHash: 'broken', contactCount: 1, estimatedWorldviewTokens: 0, snapshotVersion: 3,
      snapshot: { schemaVersion: 3, contacts: [], contactIds: ['missing'], contactStates: { missing: {} }, tables: {} },
    })

    await expect(restoreWorldSnapshot('broken', { backupCurrent: false })).rejects.toThrow('只剩 ID')
    expect(await db.contacts.get('safe')).toBeTruthy()
  })

  it('captures only contacts referenced by the active world story when the live table is polluted', async () => {
    await addWorld('world-a', '世界 A')
    await addWorld('world-b', '世界 B')
    await db.contacts.bulkPut([
      contact('a-one', 'A一号', { worldviewId: 'world-a' }),
      contact('a-two', 'A二号', { worldviewId: 'world-a' }),
      contact('b-one', 'B一号', { worldviewId: 'world-b' }),
      contact('b-two', 'B二号', { worldviewId: 'world-b' }),
    ])
    await db.conversations.bulkPut([
      { id: 'conv-a1', contactId: 'a-one', pinned: false, createdAt: 1, updatedAt: 1 },
      { id: 'conv-a2', contactId: 'a-two', pinned: false, createdAt: 1, updatedAt: 1 },
    ])

    const data = await captureWorldData('world-a')
    expect(data.contacts?.map((item) => item.id).sort()).toEqual(['a-one', 'a-two'])
    expect(data.contactIds?.sort()).toEqual(['a-one', 'a-two'])
  })

  it('removes contacts from a polluted old backup using that world\'s story references', async () => {
    await addWorld('world-a', '世界 A')
    const contacts = [contact('a-one', 'A一号'), contact('a-two', 'A二号'), contact('b-one', 'B一号'), contact('b-two', 'B二号')]
    await db.contacts.bulkPut(contacts)
    await db.conversations.bulkPut([
      { id: 'conv-a1', contactId: 'a-one', pinned: false, createdAt: 1, updatedAt: 1 },
      { id: 'conv-a2', contactId: 'a-two', pinned: false, createdAt: 1, updatedAt: 1 },
    ])
    await db.worldSnapshots.put({
      id: 'polluted', worldId: 'world-a', name: '升级自动存档', kind: 'automatic', createdAt: 1, updatedAt: 1,
      contentHash: 'polluted', contactCount: 4, estimatedWorldviewTokens: 0, snapshotVersion: 3,
      snapshot: {
        schemaVersion: 3, contacts, contactIds: contacts.map((item) => item.id),
        contactStates: Object.fromEntries(contacts.map((item) => [item.id, {}])),
        tables: { conversations: await db.conversations.toArray() },
      },
    })
    useSettingsStore.setState({ worldSnapshotMigrationVersion: 4 })

    await ensureWorldSnapshotsMigrated()
    const repaired = normalizeWorldSnapshotData((await db.worldSnapshots.get('polluted'))!.snapshot)
    expect(repaired.contacts?.map((item) => item.id).sort()).toEqual(['a-one', 'a-two'])
    expect((await db.worldSnapshots.get('polluted'))?.contactCount).toBe(2)
    expect((await db.contacts.toArray()).map((item) => item.id).sort()).toEqual(['a-one', 'a-two'])
  })

  it('uses live edited worldbook rows immediately instead of worldview copies in backups', async () => {
    await addWorld('world-a', '世界 A')
    await db.worldbookEntries.put({ id: 'entry-a', collectionId: 'world-a', title: '规则', content: '旧规则', keywords: [], enabled: true, priority: 50, createdAt: 1, updatedAt: 1 })
    await createWorldSnapshot('world-a', '备份', 'manual')
    await db.worldbookEntries.update('entry-a', { content: '资料库编辑后的新规则', updatedAt: 2 })
    const text = await retrieveWorldbookContext('任意上下文', { worldviewId: 'world-a', includeHighPriorityFallback: true })
    expect(text).toContain('资料库编辑后的新规则')
    await restoreWorldSnapshot((await db.worldSnapshots.where('worldId').equals('world-a').first())!.id)
    expect((await db.worldbookEntries.get('entry-a'))?.content).toBe('资料库编辑后的新规则')
  })
})
