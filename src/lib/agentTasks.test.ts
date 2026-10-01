import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import type { Contact } from '../types'
import { createSpecialTask } from './agentTasks'
import { ensureLocationsInitialized } from './locations'

const contact = (): Contact => ({
  id: 'agent', name: '小满', avatar: '🙂', avatarColor: '#ddd', systemPrompt: '自然', createdAt: 1,
  memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 0, memoryMessageCursor: 0,
  relationshipBase: '朋友', relationshipDynamic: '',
  schedule: [{ id: 'work', dayOfWeek: 1, startHour: 14, endHour: 16, phoneAccess: 'unavailable', location: '公司', locationId: 'office-floor', activity: '上班' }],
})

beforeEach(async () => {
  await db.open()
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear()
  })
  await ensureLocationsInitialized()
  await db.contacts.add(contact())
})

describe('special task tool', () => {
  it('persists a minute-precision task and records the fully cancelled default task', async () => {
    const now = new Date(2026, 7, 3, 14, 0).getTime()
    const result = await createSpecialTask('agent', {
      startsAt: new Date(2026, 7, 3, 15, 20).getTime(),
      endsAt: new Date(2026, 7, 3, 15, 50).getTime(),
      locationId: 'mall-cafe', activity: '喝咖啡', summary: '和玩家喝半小时咖啡', sourceConversationId: 'conversation',
    }, now)
    expect(result).toMatchObject({ success: true, cancelledDefaultTasks: [{ id: 'work', activity: '上班' }] })
    const stored = (await db.contacts.get('agent'))!.scheduleOverrides![0]
    expect(stored).toMatchObject({ locationId: 'mall-cafe', startsAt: new Date(2026, 7, 3, 15, 20).getTime(), endsAt: new Date(2026, 7, 3, 15, 50).getTime(), cancelledDefaultTaskIds: ['work'], sourceConversationId: 'conversation' })
  })

  it('keeps multiple non-overlapping tasks on the same day', async () => {
    const now = new Date(2026, 7, 3, 8, 0).getTime()
    await createSpecialTask('agent', { startsAt: new Date(2026, 7, 3, 10).getTime(), endsAt: new Date(2026, 7, 3, 10, 30).getTime(), locationId: 'park-lawn', activity: '散步', summary: '去公园散步' }, now)
    await createSpecialTask('agent', { startsAt: new Date(2026, 7, 3, 15).getTime(), endsAt: new Date(2026, 7, 3, 15, 30).getTime(), locationId: 'mall-cafe', activity: '喝咖啡', summary: '去喝咖啡' }, now)
    expect((await db.contacts.get('agent'))!.scheduleOverrides).toHaveLength(2)
  })

  it('immediately updates location and activity when a special task starts now', async () => {
    const now = new Date(2026, 7, 3, 15, 0).getTime()
    const result = await createSpecialTask('agent', { startsAt: now, endsAt: now + 30 * 60_000, locationId: 'mall-cafe', activity: '喝咖啡', summary: '去咖啡店喝咖啡' }, now)
    expect(result.success).toBe(true)
    expect(await db.contacts.get('agent')).toMatchObject({ currentLocationId: 'mall-cafe', locationSource: 'specialTask', currentTaskKind: 'special', currentActivity: '喝咖啡' })
  })

  it('moves a contact with unknown prior position into a custom room immediately', async () => {
    const now = new Date(2026, 7, 3, 22, 0).getTime()
    await db.locations.add({
      id: 'custom-bedroom', parentId: 'home', name: '我的卧室', kind: 'bedroom', description: '后来创建的卧室',
      sortOrder: 13, createdAt: now, updatedAt: now,
    })
    await db.contacts.update('agent', { currentLocationId: undefined, locationSource: 'unknown' })

    const result = await createSpecialTask('agent', {
      startsAt: now, endsAt: now + 60 * 60_000, locationId: 'custom-bedroom', activity: '回卧室休息', summary: '回卧室休息',
    }, now)

    expect(result.success).toBe(true)
    expect(await db.contacts.get('agent')).toMatchObject({
      currentLocationId: 'custom-bedroom', locationSource: 'specialTask', currentTaskKind: 'special', currentActivity: '回卧室休息',
    })
  })
})
