export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function formatListTime(ts: number): string {
  const now = new Date()
  const d = new Date(ts)
  const sameDay =
    now.getFullYear() === d.getFullYear() &&
    now.getMonth() === d.getMonth() &&
    now.getDate() === d.getDate()
  if (sameDay) {
    return d.toTimeString().slice(0, 5)
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday =
    yesterday.getFullYear() === d.getFullYear() &&
    yesterday.getMonth() === d.getMonth() &&
    yesterday.getDate() === d.getDate()
  if (isYesterday) return '昨天'

  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diffDays < 7) return WEEKDAYS[d.getDay()]

  if (now.getFullYear() === d.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export function formatBubbleTime(ts: number): string {
  const d = new Date(ts)
  return d.toTimeString().slice(0, 5)
}

export function ageFromBirthday(birthday: string): number | null {
  if (!birthday) return null
  const b = new Date(birthday)
  if (Number.isNaN(b.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - b.getFullYear()
  const hasHadBirthdayThisYear =
    now.getMonth() > b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() >= b.getDate())
  if (!hasHadBirthdayThisYear) age -= 1
  return age
}

/** Local (not UTC) "YYYY-MM-DD" key, used to compare against PlanItem.date for expiry. */
export function toDateKey(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Full, model-facing description of "right now" — recomputed fresh for every request. */
export function describeCurrentTime(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  const dateStr = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
  const weekday = WEEKDAYS[date.getDay()]
  const timeStr = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${dateStr} ${weekday} ${timeStr}`
}
