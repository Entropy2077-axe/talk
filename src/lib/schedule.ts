import type { ScheduleBlock, ScheduleDayType, ScheduleTask } from '../types'

export function formatDateStr(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function dayTypeFor(date: Date): Exclude<ScheduleDayType, 'daily'> {
  const day = date.getDay()
  return day === 0 || day === 6 ? 'weekend' : 'weekday'
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

function isWithinRange(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return true
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin
  // wraps past midnight, e.g. 23:00-07:00
  return nowMin >= startMin || nowMin < endMin
}

/** The recurring routine block that covers `date`'s time-of-day, if any. Day-specific blocks win over 'daily' fallbacks. */
export function findScheduleBlock(schedule: ScheduleBlock[], date: Date): ScheduleBlock | null {
  const dayType = dayTypeFor(date)
  const nowMin = date.getHours() * 60 + date.getMinutes()
  const inRange = (b: ScheduleBlock) => isWithinRange(nowMin, timeToMinutes(b.startTime), timeToMinutes(b.endTime))

  const specific = schedule.find((b) => b.dayType === dayType && inRange(b))
  if (specific) return specific
  return schedule.find((b) => b.dayType === 'daily' && inRange(b)) ?? null
}

/** A one-off task active right now, if any — takes priority over the daily routine. */
export function findActiveTask(tasks: ScheduleTask[], date: Date): ScheduleTask | null {
  const dateStr = formatDateStr(date)
  const nowMin = date.getHours() * 60 + date.getMinutes()
  return (
    tasks.find(
      (t) => t.date === dateStr && isWithinRange(nowMin, timeToMinutes(t.startTime), timeToMinutes(t.endTime)),
    ) ?? null
  )
}

export interface ExpectedLocation {
  locationId: string
  label?: string
  fromTask: boolean
}

export function resolveExpectedLocation(
  schedule: ScheduleBlock[],
  tasks: ScheduleTask[],
  date: Date,
): ExpectedLocation | null {
  const task = findActiveTask(tasks, date)
  if (task) return { locationId: task.locationId, label: task.label, fromTask: true }
  const block = findScheduleBlock(schedule, date)
  if (block) return { locationId: block.locationId, label: block.label, fromTask: false }
  return null
}

export function upcomingTasks(tasks: ScheduleTask[], date: Date, limit = 10): ScheduleTask[] {
  const todayStr = formatDateStr(date)
  const nowMin = date.getHours() * 60 + date.getMinutes()
  return tasks
    .filter((t) => t.date > todayStr || (t.date === todayStr && timeToMinutes(t.endTime) >= nowMin))
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
    .slice(0, limit)
}

export const DAY_TYPE_LABELS: Record<ScheduleDayType, string> = {
  weekday: '工作日',
  weekend: '周末',
  daily: '每天',
}

/** Builds the "【你的日程情况】" section fed to the model: what the routine/tasks say should be true right now, vs. what was last confirmed. */
export function buildScheduleContextText(opts: {
  expected: ExpectedLocation | null
  expectedLocationLabel: string
  currentLocationLabel: string
  upcoming: { text: string }[]
}): string {
  const lines: string[] = []
  if (opts.expected) {
    lines.push(
      opts.expected.fromTask
        ? `根据你和对方约好的安排 现在这个时间段你应该在: ${opts.expectedLocationLabel}${opts.expected.label ? `（${opts.expected.label}）` : ''}`
        : `根据你的日常routine 现在这个时间段你通常会在: ${opts.expectedLocationLabel}${opts.expected.label ? `（${opts.expected.label}）` : ''}`,
    )
  } else {
    lines.push('现在这个时间没有特别安排')
  }
  lines.push(`你上次告诉对方你在: ${opts.currentLocationLabel}`)
  if (opts.expected && opts.currentLocationLabel !== opts.expectedLocationLabel) {
    lines.push('如果你觉得该出发/该到了 可以自然地提一句 并用location消息更新位置 不用每次都换')
  }
  if (opts.upcoming.length > 0) {
    lines.push('接下来你们约好的安排:')
    opts.upcoming.forEach((u) => lines.push(`- ${u.text}`))
  }
  return lines.join('\n')
}
