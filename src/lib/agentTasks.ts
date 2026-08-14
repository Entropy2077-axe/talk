import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { ScheduleOverride } from '../types'
import { defaultTasksOverlappingRange, pruneExpiredOverrides, specialTaskRange } from './schedule'
import { canUsePlayerHome, isLeafLocation, syncContactLocationAt } from './locations'
import { toDateKey } from './time'

export interface CreateSpecialTaskInput {
  startsAt: number
  endsAt: number
  locationId: string
  activity: string
  summary: string
  phoneAccess?: 'available' | 'unavailable'
  sourceConversationId?: string
  playerHomeVisit?: boolean
}

export type CreateSpecialTaskResult =
  | { success: true; task: ScheduleOverride; cancelledDefaultTasks: Array<{ id: string; activity: string }>; replacedSpecialTasks: ScheduleOverride[] }
  | { success: false; code: string; message: string }

export async function createSpecialTask(contactId: string, input: CreateSpecialTaskInput, now = Date.now()): Promise<CreateSpecialTaskResult> {
  const [contact, location, locations] = await Promise.all([
    db.contacts.get(contactId),
    db.locations.get(input.locationId),
    db.locations.toArray(),
  ])
  if (!contact) return { success: false, code: 'CONTACT_NOT_FOUND', message: '联系人不存在' }
  if (!location || !isLeafLocation(location.id, locations)) return { success: false, code: 'INVALID_LOCATION', message: '目标必须是一个已存在的具体地点' }
  if (!canUsePlayerHome(contact, location.id, input.playerHomeVisit)) return { success: false, code: 'PLAYER_HOME_NOT_AUTHORIZED', message: '该联系人没有在用户家停留的明确许可' }
  if (!Number.isFinite(input.startsAt) || !Number.isFinite(input.endsAt) || input.endsAt <= input.startsAt) return { success: false, code: 'INVALID_TIME', message: '特殊任务的起止时间无效' }
  if (input.startsAt < now - 5 * 60_000) return { success: false, code: 'START_IN_PAST', message: '特殊任务不能从已经过去的时间开始' }
  if (input.startsAt > now + 14 * 86_400_000) return { success: false, code: 'TOO_FAR_AHEAD', message: '特殊任务最多提前十四天安排' }
  if (input.endsAt - input.startsAt > 24 * 60 * 60_000) return { success: false, code: 'TOO_LONG', message: '单个特殊任务不能超过二十四小时' }
  const activity = input.activity.trim().slice(0, 16)
  const summary = input.summary.trim().slice(0, 40)
  if (!activity || !summary) return { success: false, code: 'MISSING_DESCRIPTION', message: '特殊任务需要活动和摘要' }

  const cancelledDefaults = defaultTasksOverlappingRange(contact, input.startsAt, input.endsAt)
  const start = new Date(input.startsAt)
  const end = new Date(input.endsAt)
  const task: ScheduleOverride = {
    id: uuid(),
    date: toDateKey(start),
    startHour: start.getHours(),
    endHour: end.getHours() || 24,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    phoneAccess: input.phoneAccess ?? 'available',
    location: location.name,
    locationId: location.id,
    activity,
    summary,
    priority: 'special',
    status: 'scheduled',
    sourceConversationId: input.sourceConversationId,
    playerHomeVisit: input.playerHomeVisit,
    cancelledDefaultTaskIds: cancelledDefaults.map((task) => task.id),
    createdAt: now,
  }

  let replacedSpecialTasks: ScheduleOverride[] = []
  await db.transaction('rw', db.contacts, async () => {
    const fresh = await db.contacts.get(contactId)
    if (!fresh) throw new Error('联系人不存在')
    const existing = pruneExpiredOverrides(fresh.scheduleOverrides ?? [], new Date(now))
    const nextRange = specialTaskRange(task)
    const kept = existing.filter((item) => {
      if (item.status === 'cancelled') return true
      const range = specialTaskRange(item)
      return !(range.startsAt < nextRange.endsAt && nextRange.startsAt < range.endsAt)
    })
    replacedSpecialTasks = existing.filter((item) => !kept.includes(item))
    await db.contacts.update(contactId, { scheduleOverrides: [...kept, task] })
  })

  if (input.startsAt <= now && now < input.endsAt) await syncContactLocationAt(contactId, new Date(now))
  return { success: true, task, cancelledDefaultTasks: cancelledDefaults.map((item) => ({ id: item.id, activity: item.activity })), replacedSpecialTasks }
}
