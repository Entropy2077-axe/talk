import { v4 as uuid } from 'uuid'
import { WEEKDAYS, toDateKey } from './time'
import type { Contact, ScheduleBlock, ScheduleOverride } from '../types'

type ScheduleSource = Pick<Contact, 'schedule' | 'scheduleOverrides'>

function findOverrideForNow(overrides: ScheduleOverride[], now: Date): ScheduleOverride | undefined {
  const dateKey = toDateKey(now)
  const hour = now.getHours()
  return overrides.find((o) => o.date === dateKey && hour >= o.startHour && hour < o.endHour)
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

/** A one-off override for the current moment always wins over the recurring weekly pattern; if neither covers this hour, default to reachable rather than silently locking a contact out of ever responding. */
export function isPhoneAvailable(contact: ScheduleSource, now: Date): boolean {
  const override = findOverrideForNow(contact.scheduleOverrides ?? [], now)
  if (override) return override.phoneAccess === 'available'
  const block = findBlockForNow(contact.schedule ?? [], now)
  if (!block) return true
  return block.phoneAccess === 'available'
}

/** Model-facing "what are you doing right now" text for prompt injection — empty string if there's no schedule info to say anything with. */
export function describeCurrentSchedule(contact: ScheduleSource, now: Date): string {
  const override = findOverrideForNow(contact.scheduleOverrides ?? [], now)
  if (override) return `现在在${override.activity}`
  const block = findBlockForNow(contact.schedule ?? [], now)
  if (!block) return ''
  return `现在在${block.activity}`
}

/** Next-3-days digest of the recurring schedule + any overrides, for the model to reason against when negotiating a schedule change. */
export function describeUpcomingScheduleText(contact: ScheduleSource, now: Date): string {
  const schedule = contact.schedule ?? []
  const overrides = contact.scheduleOverrides ?? []
  if (schedule.length === 0) return ''

  const lines: string[] = []
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const d = new Date(now)
    d.setDate(now.getDate() + dayOffset)
    const day = d.getDay()
    const dateKey = toDateKey(d)
    const label = dayOffset === 0 ? '今天' : dayOffset === 1 ? '明天' : WEEKDAYS[day]

    const dayBlocks = schedule
      .filter((b) => b.dayOfWeek === day)
      .sort((a, b) => a.startHour - b.startHour)
      .map((b) => `${b.startHour}-${b.endHour}点:${b.activity}`)

    const override = overrides.find((o) => o.date === dateKey)
    if (override) {
      dayBlocks.push(`[例外安排]${override.startHour}-${override.endHour}点:${override.activity} — ${override.summary}`)
    }

    if (dayBlocks.length > 0) lines.push(`${label}: ${dayBlocks.join('、')}`)
  }
  return lines.join('\n')
}

/** Drops overrides whose date has already passed — called whenever a new one is added, so the list doesn't grow forever. */
export function pruneExpiredOverrides(overrides: ScheduleOverride[], now: Date): ScheduleOverride[] {
  const todayKey = toDateKey(now)
  return overrides.filter((o) => o.date >= todayKey)
}

/** Cleans up the schedule the model generates alongside a new persona — drops any block that doesn't make structural sense rather than rejecting the whole batch. */
export function validateScheduleBlocks(raw: unknown): ScheduleBlock[] {
  if (!Array.isArray(raw)) return []
  const result: ScheduleBlock[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const b = item as Record<string, unknown>
    const dayOfWeek = Number(b.dayOfWeek)
    const startHour = Number(b.startHour)
    const endHour = Number(b.endHour)
    const phoneAccess = b.phoneAccess
    const location = typeof b.location === 'string' ? b.location.trim() : ''
    const activity = typeof b.activity === 'string' ? b.activity.trim() : ''

    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) continue
    if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) continue
    // startHour > endHour is a valid overnight block (e.g. 23 -> 7); only a
    // zero-length or out-of-range block is actually invalid.
    if (startHour < 0 || startHour > 23 || endHour < 1 || endHour > 24 || startHour === endHour) continue
    if (phoneAccess !== 'available' && phoneAccess !== 'unavailable') continue
    if (!location || !activity) continue

    result.push({ id: uuid(), dayOfWeek, startHour, endHour, phoneAccess, location, activity })
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
      const d = new Date(now)
      const dayOffset = (day - now.getDay() + 7) % 7
      d.setDate(now.getDate() + dayOffset)

      // Check for override first
      const dateKey = toDateKey(d)
      const override = overrides.find((o) => o.date === dateKey)

      const block = schedule.find(
        (b) =>
          b.dayOfWeek === day &&
          b.startHour < bucket.end &&
          b.endHour > bucket.start,
      )
      const main = override
        ? `${override.activity}⚠️`
        : block
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
      rows.push('⚠️ = 临时例外安排，覆盖常规日程')
      rows.push(active.map((o) => `${o.date} ${o.startHour}-${o.endHour}点: ${o.activity} — ${o.summary}`).join('\n'))
    }
  }

  rows.push('')
  rows.push('📵 = 不方便看手机(上班/睡觉等) 不要发朋友圈或主动聊天')
  rows.push('📱 = 可以正常聊天')

  return rows.join('\n')
}
