import { v4 as uuid } from 'uuid'
import { WEEKDAYS, toDateKey } from './time'
import type { Contact, ScheduleBlock, ScheduleOverride } from '../types'

type ScheduleSource = Pick<Contact, 'schedule' | 'scheduleOverrides'>

function localDateAt(dateKey: string, hour: number) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
}

export function specialTaskRange(task: ScheduleOverride): { startsAt: number; endsAt: number } {
  const startsAt = Number.isFinite(task.startsAt) ? task.startsAt! : localDateAt(task.date, task.startHour)
  let endsAt = Number.isFinite(task.endsAt) ? task.endsAt! : localDateAt(task.date, task.endHour)
  if (endsAt <= startsAt) endsAt += 24 * 60 * 60 * 1000
  return { startsAt, endsAt }
}

function findSpecialTaskForNow(overrides: ScheduleOverride[], now: Date): ScheduleOverride | undefined {
  const at = now.getTime()
  return overrides
    .filter((task) => task.status !== 'cancelled')
    .filter((task) => {
      const range = specialTaskRange(task)
      return at >= range.startsAt && at < range.endsAt
    })
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

function blockCoversNow(b: ScheduleBlock, day: number, hour: number): boolean {
  if (b.startHour < b.endHour) {
    return b.dayOfWeek === day && hour >= b.startHour && hour < b.endHour
  }
  // Overnight block (e.g. startHour 23, endHour 7): covers the tail end of
  // its own dayOfWeek and the head of the following day.
  const isTailOfOwnDay = b.dayOfWeek === day && hour >= b.startHour
  const isHeadOfNextDay = b.dayOfWeek === (day + 6) % 7 && hour < b.endHour
  return isTailOfOwnDay || isHeadOfNextDay
}

function findBlockForNow(schedule: ScheduleBlock[], now: Date): ScheduleBlock | undefined {
  const day = now.getDay()
  const hour = now.getHours()
  return schedule.find((b) => blockCoversNow(b, day, hour))
}

function defaultTaskRangeForNow(block: ScheduleBlock, now: Date): { startsAt: number; endsAt: number } {
  const start = new Date(now)
  if (block.startHour > block.endHour && now.getHours() < block.endHour) start.setDate(start.getDate() - 1)
  start.setHours(block.startHour, 0, 0, 0)
  const end = new Date(start)
  end.setHours(block.endHour, 0, 0, 0)
  if (block.startHour > block.endHour) end.setDate(end.getDate() + 1)
  return { startsAt: start.getTime(), endsAt: end.getTime() }
}

function rangesOverlap(a: { startsAt: number; endsAt: number }, b: { startsAt: number; endsAt: number }) {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt
}

export function defaultTasksOverlappingRange(contact: ScheduleSource, startsAt: number, endsAt: number): ScheduleBlock[] {
  const matches = new Map<string, ScheduleBlock>()
  const firstDay = new Date(startsAt); firstDay.setDate(firstDay.getDate() - 1); firstDay.setHours(0, 0, 0, 0)
  const lastDay = new Date(endsAt); lastDay.setHours(23, 59, 59, 999)
  for (const cursor = new Date(firstDay); cursor.getTime() <= lastDay.getTime(); cursor.setDate(cursor.getDate() + 1)) {
    for (const block of contact.schedule ?? []) {
      if (block.dayOfWeek !== cursor.getDay()) continue
      const start = new Date(cursor); start.setHours(block.startHour, 0, 0, 0)
      const end = new Date(start); end.setHours(block.endHour, 0, 0, 0); if (block.startHour > block.endHour) end.setDate(end.getDate() + 1)
      if (rangesOverlap({ startsAt, endsAt }, { startsAt: start.getTime(), endsAt: end.getTime() })) matches.set(block.id, block)
    }
  }
  return [...matches.values()]
}

export interface ResolvedContactTask {
  task: ScheduleBlock | ScheduleOverride
  kind: 'default' | 'special'
  startsAt: number
  endsAt: number
}

/** A visible slice of one task inside one local calendar day. Default blocks
 * are expanded from the weekly routine; special tasks are preserved at their
 * minute-precision range. A default occurrence disappears entirely whenever a
 * special task overlaps it, matching the runtime scheduling rule. */
export interface ScheduleDayOccurrence {
  id: string
  kind: 'default' | 'special'
  task: ScheduleBlock | ScheduleOverride
  startsAt: number
  endsAt: number
  continuesFromPreviousDay: boolean
  continuesIntoNextDay: boolean
}

function localDayRange(date: Date) {
  const startsAt = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  return { startsAt, endsAt: startsAt + 24 * 60 * 60 * 1000 }
}

function defaultOccurrenceRange(block: ScheduleBlock, date: Date) {
  const start = new Date(date)
  start.setHours(block.startHour, 0, 0, 0)
  const end = new Date(start)
  end.setHours(block.endHour, 0, 0, 0)
  if (block.startHour > block.endHour) end.setDate(end.getDate() + 1)
  return { startsAt: start.getTime(), endsAt: end.getTime() }
}

/** Expands the effective schedule for one local calendar day. This is the
 * canonical source for calendar presentation, including overnight blocks. */
export function scheduleOccurrencesForDate(contact: ScheduleSource, date: Date): ScheduleDayOccurrence[] {
  const day = localDayRange(date)
  const overrides = (contact.scheduleOverrides ?? []).filter((task) => task.status !== 'cancelled')
  const result: ScheduleDayOccurrence[] = []
  const starts = [new Date(day.startsAt - 24 * 60 * 60 * 1000), new Date(day.startsAt)]

  for (const startDate of starts) {
    for (const block of contact.schedule ?? []) {
      if (block.dayOfWeek !== startDate.getDay()) continue
      const range = defaultOccurrenceRange(block, startDate)
      if (!rangesOverlap(range, day)) continue
      if (overrides.some((task) => rangesOverlap(range, specialTaskRange(task)))) continue
      result.push({
        id: `${block.id}:${range.startsAt}`,
        kind: 'default',
        task: block,
        startsAt: Math.max(range.startsAt, day.startsAt),
        endsAt: Math.min(range.endsAt, day.endsAt),
        continuesFromPreviousDay: range.startsAt < day.startsAt,
        continuesIntoNextDay: range.endsAt > day.endsAt,
      })
    }
  }

  for (const task of overrides) {
    const range = specialTaskRange(task)
    if (!rangesOverlap(range, day)) continue
    result.push({
      id: `${task.id}:${day.startsAt}`,
      kind: 'special',
      task,
      startsAt: Math.max(range.startsAt, day.startsAt),
      endsAt: Math.min(range.endsAt, day.endsAt),
      continuesFromPreviousDay: range.startsAt < day.startsAt,
      continuesIntoNextDay: range.endsAt > day.endsAt,
    })
  }

  return result.sort((a, b) => a.startsAt - b.startsAt || (a.kind === 'special' ? -1 : 1))
}

/** A special task wins. If it overlaps a default task occurrence, that whole
 * default occurrence is cancelled, including the time before and after it. */
export function resolveActiveTask(contact: ScheduleSource, now: Date): ResolvedContactTask | undefined {
  const overrides = contact.scheduleOverrides ?? []
  const special = findSpecialTaskForNow(overrides, now)
  if (special) return { task: special, kind: 'special', ...specialTaskRange(special) }
  const block = findBlockForNow(contact.schedule ?? [], now)
  if (!block) return undefined
  const range = defaultTaskRangeForNow(block, now)
  const cancelled = overrides
    .filter((task) => task.status !== 'cancelled')
    .some((task) => rangesOverlap(range, specialTaskRange(task)))
  return cancelled ? undefined : { task: block, kind: 'default', ...range }
}

/** A one-off override for the current moment always wins over the recurring weekly pattern; if neither covers this hour, default to reachable rather than silently locking a contact out of ever responding. */
export function isPhoneAvailable(contact: ScheduleSource, now: Date): boolean {
  return resolveActiveTask(contact, now)?.task.phoneAccess !== 'unavailable'
}

/** Model-facing "what are you doing right now" text for prompt injection — empty string if there's no schedule info to say anything with. */
export function describeCurrentSchedule(contact: ScheduleSource, now: Date): string {
  const active = resolveActiveTask(contact, now)
  return active ? `现在在${active.task.activity}${active.kind === 'special' ? '（特殊任务）' : ''}` : ''
}

function formatClock(timestamp: number) {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Future digest of recurring and special tasks. A weekly routine only needs
 * one seven-day cycle; repeating it for a second week wastes prompt space and
 * looks like duplicated data. One-off special tasks remain visible for the
 * full requested horizon (up to fourteen days). */
export function describeUpcomingScheduleText(contact: ScheduleSource, now: Date, dayCount = 14): string {
  const schedule = contact.schedule ?? []
  const overrides = contact.scheduleOverrides ?? []
  if (schedule.length === 0 && overrides.length === 0) return ''

  const lines: string[] = []
  const horizon = Math.max(1, Math.min(14, Math.round(dayCount)))
  for (let dayOffset = 0; dayOffset < horizon; dayOffset++) {
    const d = new Date(now)
    d.setDate(now.getDate() + dayOffset)
    const day = d.getDay()
    const dateKey = toDateKey(d)
    const labelPrefix = dayOffset === 0 ? '今天' : dayOffset === 1 ? '明天' : WEEKDAYS[day]
    const label = `${labelPrefix}(${dateKey})`

    const relevantOverrides = overrides.filter((task) => task.status !== 'cancelled' && task.date === dateKey)
    const dayBlocks = (dayOffset < 7 ? schedule : [])
      .filter((b) => b.dayOfWeek === day)
      .sort((a, b) => a.startHour - b.startHour)
      .map((b) => {
        const start = new Date(d); start.setHours(b.startHour, 0, 0, 0)
        const end = new Date(start); end.setHours(b.endHour, 0, 0, 0); if (b.startHour > b.endHour) end.setDate(end.getDate() + 1)
        const cancelled = relevantOverrides.some((task) => rangesOverlap({ startsAt: start.getTime(), endsAt: end.getTime() }, specialTaskRange(task)))
        return `${b.startHour}-${b.endHour}点:${b.activity}${cancelled ? '（被特殊任务整项取消）' : ''}`
      })

    for (const task of relevantOverrides.sort((a, b) => specialTaskRange(a).startsAt - specialTaskRange(b).startsAt)) {
      const range = specialTaskRange(task)
      dayBlocks.push(`[特殊任务]${formatClock(range.startsAt)}-${formatClock(range.endsAt)} ${task.activity} — ${task.summary}`)
    }

    if (dayBlocks.length > 0) lines.push(`${label}: ${dayBlocks.join('、')}`)
  }
  return lines.join('\n')
}

/** Drops overrides whose date has already passed — called whenever a new one is added, so the list doesn't grow forever. */
export function pruneExpiredOverrides(overrides: ScheduleOverride[], now: Date): ScheduleOverride[] {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000
  return overrides.filter((task) => specialTaskRange(task).endsAt >= cutoff)
}

/** Cleans up the schedule the model generates alongside a new persona — drops any block that doesn't make structural sense rather than rejecting the whole batch. */
export function normalizeScheduleBlock(raw: unknown, id = uuid()): ScheduleBlock | null {
    if (!raw || typeof raw !== 'object') return null
    const b = raw as Record<string, unknown>
    const dayOfWeek = Number(b.dayOfWeek)
    const startHour = Number(b.startHour)
    const endHour = Number(b.endHour)
    const phoneAccess = b.phoneAccess
    const location = typeof b.location === 'string' ? b.location.trim().slice(0, 20) : ''
    const activity = typeof b.activity === 'string' ? b.activity.trim().slice(0, 16) : ''

    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return null
    if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) return null
    // startHour > endHour is a valid overnight block (e.g. 23 -> 7); only a
    // zero-length or out-of-range block is actually invalid.
    if (startHour < 0 || startHour > 23 || endHour < 1 || endHour > 24 || startHour === endHour) return null
    if (phoneAccess !== 'available' && phoneAccess !== 'unavailable') return null
    if (!location || !activity) return null

    const locationId = typeof b.locationId === 'string' && b.locationId.trim() ? b.locationId.trim() : undefined
    return { id, dayOfWeek, startHour, endHour, phoneAccess, location, locationId, activity }
}

export function validateScheduleBlocks(raw: unknown): ScheduleBlock[] {
  if (!Array.isArray(raw)) return []
  const result: ScheduleBlock[] = []
  for (const item of raw) {
    const normalized = normalizeScheduleBlock(item)
    if (normalized) result.push(normalized)
  }
  return result
}

/**
 * Compact weekly schedule table for the system prompt.
 * Each cell shows activity + availability icon, e.g. "💼上班" or "🛏️睡觉".
 * Hours are grouped into 4 buckets: 0-6 (深夜), 7-12 (上午), 13-18 (下午), 19-23 (晚上).
 */
export function describeWeeklySchedule(contact: ScheduleSource, now: Date): string {
  const schedule = contact.schedule ?? []
  const overrides = contact.scheduleOverrides ?? []
  if (schedule.length === 0) return ''

  const HOUR_BUCKETS = [
    { label: '深夜 0-6', start: 0, end: 7 },
    { label: '上午 7-12', start: 7, end: 13 },
    { label: '下午 13-18', start: 13, end: 19 },
    { label: '晚上 19-23', start: 19, end: 24 },
  ]

  const header = `         | ${WEEKDAYS.join(' | ')}`
  const sep = `---------|${WEEKDAYS.map(() => '-----').join('|')}`

  const rows: string[] = [header, sep]
  for (const bucket of HOUR_BUCKETS) {
    const cells: string[] = [bucket.label.padEnd(8)]
    for (let day = 0; day < 7; day++) {
      const block = schedule.find(
        (b) =>
          b.dayOfWeek === day &&
          b.startHour < bucket.end &&
          b.endHour > bucket.start,
      )
      const main = block
        ? `${block.phoneAccess === 'unavailable' ? '📵' : '📱'}${block.activity}`
        : '—'
      cells.push(main.padEnd(4))
    }
    rows.push(cells.join('|'))
  }

  if (overrides.length > 0) {
    const todayKey = toDateKey(now)
    const active = overrides.filter((o) => o.date >= todayKey)
    if (active.length > 0) {
      rows.push('')
      rows.push('⚠️ = 特殊任务；与其重叠的默认任务会整项取消')
      rows.push(active.map((task) => { const range = specialTaskRange(task); return `${task.date} ${formatClock(range.startsAt)}-${formatClock(range.endsAt)}: ${task.activity} — ${task.summary}` }).join('\n'))
    }
  }

  rows.push('')
  rows.push('📵 = 不方便看手机(上班/睡觉等) 不要发朋友圈或主动聊天')
  rows.push('📱 = 可以正常聊天')

  return rows.join('\n')
}
