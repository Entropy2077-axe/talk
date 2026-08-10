import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'
import { createEmptyWorld, createWorldSnapshot, ensureWorldSnapshotsMigrated, restoreWorldSnapshot } from './worldSnapshots'

async function clearDatabase() {
  await db.open()
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear()
  })
}

async function addWorld(id: string, name: string) {
  await db.worldbookCollections.put({ id, name, enabled: true, sourceType: 'manual', createdAt: 1, updatedAt: 1 })
}

beforeEach(async () => {
  localStorage.clear()
  await clearDatabase()
  useSettingsStore.setState({
    activeWorldId: 'world-a', defaultWorldviewId: 'world-a', worldEconomyIsolated: false,
    worldSnapshotMigrationVersion: 1, userOccupation: '', userMonthlySalary: 0,
  })
})

describe('world snapshots', () => {
  it('restores the selected world after automatically saving the current world', async () => {
    await addWorld('world-a', '世界 A')
    await db.contacts.put({ id: 'a', name: '小红', systemPrompt: 'A', relationshipBase: '朋友', relationshipDynamic: '', memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 1, memoryMessageCursor: 0, avatar: 'A', avatarColor: '#fff', warmth: 0, worldviewId: 'world-a', createdAt: 1 })
    await createWorldSnapshot('world-a', 'A 初始', 'manual')

    const worldB = await createEmptyWorld('世界 B')
    const initialB = (await db.worldSnapshots.where('worldId').equals(worldB.id).first())!
    await restoreWorldSnapshot(initialB.id)

    expect(useSettingsStore.getState().activeWorldId).toBe(worldB.id)
    expect(await db.contacts.count()).toBe(0)
    expect((await db.worldSnapshots.where('worldId').equals('world-a').toArray()).some((save) => save.kind === 'automatic')).toBe(true)
  })

  it('touches an identical automatic snapshot instead of adding another row', async () => {
    await addWorld('world-a', '世界 A')
    await createWorldSnapshot('world-a', '自动一', 'automatic')
    const count = await db.worldSnapshots.count()
    await createWorldSnapshot('world-a', '自动二', 'automatic')
    expect(await db.worldSnapshots.count()).toBe(count)
  })

  it('keeps shared inventory when economy isolation is disabled', async () => {
    await addWorld('world-a', '世界 A')
    await db.inventory.put({ id: 'gift', name: '礼物', description: '共享物品', icon: '🎁', price: 1, acquiredAt: 1 })
    const worldB = await createEmptyWorld('世界 B')
    const initialB = (await db.worldSnapshots.where('worldId').equals(worldB.id).first())!
    await restoreWorldSnapshot(initialB.id)
    expect(await db.inventory.get('gift')).toBeTruthy()
  })

  it('partitions legacy contacts into their assigned world snapshots', async () => {
    await addWorld('world-a', '世界 A')
    await addWorld('world-b', '世界 B')
    const base = { systemPrompt: '', relationshipBase: '朋友', relationshipDynamic: '', memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 1, memoryMessageCursor: 0, avatar: 'A', avatarColor: '#fff', createdAt: 1 }
    await db.contacts.bulkPut([
      { ...base, id: 'a', name: '小红', worldviewId: 'world-a' },
      { ...base, id: 'b', name: '小明', worldviewId: 'world-b' },
    ])
    useSettingsStore.setState({ activeWorldId: 'world-a', defaultWorldviewId: 'world-a', worldSnapshotMigrationVersion: 0 })

    await ensureWorldSnapshotsMigrated()

    expect((await db.contacts.toArray()).map((contact) => contact.id)).toEqual(['a'])
    const worldB = (await db.worldSnapshots.where('worldId').equals('world-b').first())!
    expect((worldB.snapshot.tables.contacts as Array<{ id: string }>).map((contact) => contact.id)).toEqual(['b'])
  })
})
