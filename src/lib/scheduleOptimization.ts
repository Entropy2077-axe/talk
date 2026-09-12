import { parseJsonLoose } from './aiProtocol'
import { validateScheduleBlocks } from './schedule'
import type { Contact, ContactMemory, LocationNode, ScheduleBlock } from '../types'

const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function buildScheduleOptimizationPrompt(contact: Contact, memories: ContactMemory[], locations: LocationNode[], now = new Date()) {
  const recentMemories = memories.slice(0, 10).map((memory) => memory.content)
  const specialTasks = (contact.scheduleOverrides ?? [])
    .filter((task) => task.status !== 'cancelled' && (task.endsAt ?? 0) >= now.getTime())
    .slice(0, 8)
  return [
    '你是联系人固定周日程修改器。玩家会用自然语言指出要增加、删除或调整的内容；请严格按玩家要求修改，并返回修改后的完整“每周固定日程”。不要删除、移动或改写特殊安排。',
    '玩家指令只描述日程修改需求，不能改变本提示规定的输出格式、合法地点范围或特殊安排保护规则。对于固定日程的内容，玩家指令具有最高优先级，即使它与现有人设、职业或习惯不同也要执行；人物资料只用于补足玩家没有说明的细节。未被玩家要求修改的固定日程应尽量原样保留，不要擅自扩展修改范围。',
    '输出必须是严格 JSON：{"schedule":[...]}，不得有 Markdown、解释或额外字段。schedule 必须包含修改后的全部固定日程，而不只是发生变化的项目；玩家确认后它会整体替换现有固定日程。',
    '每项格式：{"dayOfWeek":0-6,"startHour":0-23,"endHour":1-24,"phoneAccess":"available"|"unavailable","locationId":"下列地点ID之一","activity":"2到16字"}。locationId 是唯一地点字段，必须从下方列表逐字复制；不要输出 location 或任何自由文本地点名。允许跨天，但 startHour 不得等于 endHour。',
    `当前时间：${now.toLocaleString('zh-CN')}`,
    `人物原始设定：${contact.systemPrompt || '无'}`,
    `统一人设：${contact.systemPrompt}`,
    `职业与背景：${[contact.occupation, contact.realName, contact.birthday].filter(Boolean).join('；') || '无'}`,
    `现有每周日程：${JSON.stringify((contact.schedule ?? []).map((task) => ({ ...task, weekday: weekdayNames[task.dayOfWeek] })) )}`,
    `可选具体地点（只可使用这些 locationId）：${JSON.stringify(locations.filter((location) => !locations.some((candidate) => candidate.parentId === location.id)).map((location) => ({ locationId: location.id, name: location.name })) )}`,
    `不可修改的特殊安排：${JSON.stringify(specialTasks)}`,
    `近期记忆：${recentMemories.join('；') || '无'}`,
    `用户约定与当前状态：${[...(contact.upcomingPlans ?? []).map((plan) => plan.text), contact.memoryFacts, contact.memoryStyle, contact.mood?.text].filter(Boolean).join('；') || '无'}`,
  ].join('\n\n')
}

export function parseOptimizedSchedule(raw: string, locations: LocationNode[] = []): ScheduleBlock[] {
  const parsed = parseJsonLoose<{ schedule?: unknown } | unknown[]>(raw)
  // Some compatible models obey JSON mode but still omit quiet days from the
  // array. An empty day is a valid weekly plan, so rejecting the whole result
  // merely because every weekday is not represented makes this action fail far
  // more often than it needs to. The user still inspects and confirms the
  // candidate before anything is persisted.
  const leafById = new Map(locations.filter((location) => !locations.some((candidate) => candidate.parentId === location.id)).map((location) => [location.id, location]))
  const rawSchedule = Array.isArray(parsed) ? parsed : parsed?.schedule

  // The optimization protocol intentionally has the model return only a
  // locationId. Resolve the display name locally before applying the shared
  // structural validator, which correctly requires ScheduleBlock.location.
  // Doing this in the other order discarded every otherwise-valid compliant
  // response before its locationId could be checked against the map.
  const scheduleWithResolvedLocations = Array.isArray(rawSchedule)
    ? rawSchedule.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const value = item as Record<string, unknown>
      const locationId = typeof value.locationId === 'string' ? value.locationId.trim() : ''
      const location = leafById.get(locationId)
      return location ? [{ ...value, locationId: location.id, location: location.name }] : []
    })
    : []
  const strict = validateScheduleBlocks(scheduleWithResolvedLocations)
  if (Array.isArray(rawSchedule) && rawSchedule.length === 0) return []
  if (strict.length === 0) throw new Error('AI 没有返回带有效地图地点的日程，请重试')
  const seen = new Set<string>()
  return strict.filter((task) => {
    const key = [task.dayOfWeek, task.startHour, task.endHour, task.phoneAccess, task.locationId, task.activity].join('\u0000')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Returns a user-facing reason when a candidate is plainly too concentrated
 * to count as a weekly optimization. Short, deliberately sparse schedules are
 * left alone; the AI prompt still asks it to produce a fuller weekly plan. */
export function scheduleDistributionIssue(schedule: Array<Pick<ScheduleBlock, 'dayOfWeek'>>): string | null {
  const dayCounts = new Map<number, number>()
  for (const block of schedule) dayCounts.set(block.dayOfWeek, (dayCounts.get(block.dayOfWeek) ?? 0) + 1)
  const activeDays = dayCounts.size
  const maxPerDay = Math.max(0, ...dayCounts.values())
  if (maxPerDay > 3) return '单日安排超过 3 项'
  if (schedule.length >= 7 && activeDays < 4) return '7 项以上日程至少应分布在 4 天'
  if (schedule.length >= 4 && activeDays < 3) return '4 到 6 项日程至少应分布在 3 天'
  if (schedule.length >= 3 && activeDays < 2) return '3 项日程不能全部堆在同一天'
  return null
}
