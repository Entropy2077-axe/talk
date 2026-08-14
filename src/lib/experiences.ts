import { v4 as uuid } from 'uuid'
import { canPublishNovelMoment } from './moments'
import { db } from '../db/db'
import type { AppSettings, Contact, ContactMemory } from '../types'
import { chatCompletionText as chatCompletion } from './deepseek'
import { parseJsonLoose } from './aiProtocol'
import { selectedWorldbookEntriesText, retrieveWorldbookContext } from './worldbook'
import { uniqueRelationPairs } from './contactRelations'
import { displayName } from './contact'
import { isPhoneAvailable } from './schedule'
import { isLeafLocation, resolveContactRuntimeAt } from './locations'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

interface GeneratedExperience {
  title?: string
  summary?: string
  details?: string
  offsetStartMinutes?: number
  offsetEndMinutes?: number
  location?: string
  activity?: string
  participantContactIds?: string[]
  interactionMode?: 'none' | 'remote' | 'physical'
  importance?: number
  visibility?: 'private' | 'related' | 'public'
  shareAsMoment?: boolean
  momentContent?: string
}

function durationText(ms: number) {
  const hours = ms / HOUR
  if (hours < 24) return `${Math.max(1, Math.round(hours * 10) / 10)}小时`
  return `${Math.round(hours / 24 * 10) / 10}天`
}

function scheduleSlice(contact: Contact, from: number, to: number) {
  const days = new Set<number>()
  for (let t = from; t <= to; t += DAY) days.add(new Date(t).getDay())
  return (contact.schedule ?? [])
    .filter((item) => days.has(item.dayOfWeek))
    .map((item) => `星期${item.dayOfWeek} ${item.startHour}:00-${item.endHour}:00｜${item.activity}｜${item.location}｜手机${item.phoneAccess === 'available' ? '可用' : '不可用'}`)
    .join('\n') || '没有固定日程；请只依据人设、世界观和常住地补全自然日常。'
}

async function interactionCandidates(contact: Contact, from: number, to: number, leafLocationIds: Set<string>) {
  const rows = uniqueRelationPairs(await db.contactRelations.filter((row) => row.fromContactId === contact.id || row.toContactId === contact.id).toArray())
  const otherIds = rows.map((row) => row.fromContactId === contact.id ? row.toContactId : row.fromContactId)
  const others = await db.contacts.bulkGet(otherIds)
  const midpoint = new Date(from + (to - from) / 2)
  const contacts = new Map<string, Contact>()
  const text = rows.map((row, index) => {
    const other = others[index]
    if (!other) return ''
    contacts.set(other.id, other)
    const otherRuntime = resolveContactRuntimeAt(other, midpoint, leafLocationIds)
    return [
      `ID=${other.id}；姓名=${displayName(other)}；关系=${row.label}`,
      `人设摘要=${other.systemPrompt.slice(0, 260)}`,
      `区间中点位置=${otherRuntime.locationId || '未知'}；活动=${otherRuntime.activity || '未明确'}`,
      `区间日程=${scheduleSlice(other, from, to)}`,
      '线下互动=必须在具体事件发生时重新检查双方日程地点一致；远程互动=仅在双方手机可用且有明确理由时允许',
    ].join('\n')
  }).filter(Boolean).join('\n\n') || '没有可互动的已关联联系人。不得自行添加参与者。'
  return { text, contacts }
}

function desiredCount(gap: number) {
  if (gap < 3 * HOUR) return '0到1'
  if (gap < 8 * HOUR) return '1到2'
  if (gap < DAY) return '1到3'
  if (gap < 3 * DAY) return '2到4'
  return '2到5段阶段摘要'
}

async function createMomentFromExperience(contact: Contact, memory: ContactMemory, occurredAt: number, content: string) {
  const recent = await db.moments.where('contactId').equals(contact.id).reverse().sortBy('createdAt')
  if (recent[0] && occurredAt - recent[0].createdAt < 2 * HOUR) return
  const createdAt = occurredAt
  if (!await canPublishNovelMoment(contact.id, content, createdAt)) return
  const id = uuid()
  await db.moments.add({ id, contactId: contact.id, content: content.trim().slice(0, 500), createdAt, sourceExperienceId: memory.id })
  await db.contacts.update(contact.id, { lastMomentAt: createdAt })
}

export interface OfflineExperienceResult {
  absenceContext: string
  generated: ContactMemory[]
}

/** Completes one contact's unobserved time. Content comes from the utility model; code only validates chronology and participants. */
export async function ensureOfflineExperiences(opts: {
  contact: Contact
  settings: AppSettings
  from: number
  to: number
}): Promise<OfflineExperienceResult> {
  const { contact, settings, to } = opts
  const from = Math.max(contact.experienceCursorAt ?? opts.from, opts.from)
  const gap = to - from
  const absenceContext = gap >= HOUR
    ? `【用户离线】对方距离上次回复约${durationText(gap)}。这只是你能感知到的聊天间隔，不等于故意忽视你。结合上次对话是否自然结束、你期间的生活、关系和性格决定是否自然提及；不要机械报出精确时长，也不必每次抱怨。`
    : ''
  if (gap < HOUR || !settings.apiKey) return { absenceContext, generated: [] }

  const mapLocations = await db.locations.toArray()
  const leafLocationIds = new Set(mapLocations.filter((location) => isLeafLocation(location.id, mapLocations)).map((location) => location.id))
  const locationNameById = new Map(mapLocations.map((location) => [location.id, location.name]))
  const [worldbook, candidatePlan] = await Promise.all([
    Promise.all([
      retrieveWorldbookContext(`${contact.name}\n${contact.systemPrompt}\n${contact.schedule?.map((block) => `${block.location} ${block.activity}`).join('\n') || ''}`, { worldviewId: settings.activeWorldId || settings.defaultWorldviewId, maxEntries: 8, maxChars: 5000, includeHighPriorityFallback: true }),
      selectedWorldbookEntriesText(contact.worldbookEntryIds ?? []),
    ]).then((parts) => parts.filter(Boolean).join('\n\n')),
    interactionCandidates(contact, from, to, leafLocationIds),
  ])
  const maxMinutes = Math.max(60, Math.floor(gap / 60000))
  const prompt = `你是角色离线经历补全器。根据自由人设、世界观、自然语言日程和时间区间，补全角色在用户没有回复时真实经历的生活。职业和活动完全开放，禁止套用固定的上班/上学模板。

【角色】${displayName(contact)}（ID=${contact.id}）
【人设】${contact.systemPrompt}
【关系】${contact.relationshipBase || '未说明'}；${contact.relationshipDynamic || ''}
【区间】${new Date(from).toLocaleString()} 至 ${new Date(to).toLocaleString()}，共${durationText(gap)}
【区间日程】\n${scheduleSlice(contact, from, to)}
【住所与地点硬规则】常住地=${locationNameById.get(resolveContactRuntimeAt(contact, new Date(from), leafLocationIds).locationId) ?? '未知'}。地点不是自由剧情：只可描述当时已生效的日程地点或角色常住地；没有明确日程、约会或用户邀请时，不得去商场、公园、咖啡馆、用户家或他人住处。非同住角色绝不能在用户家休息或过夜。
${worldbook ? `【所属世界正史与创建参考资料】\n${worldbook.slice(0, 5000)}` : ''}
【唯一允许考虑的互动对象】\n${candidatePlan.text}

规则：
- 生成${desiredCount(gap)}条；平静无事可以返回空数组，不要为了证明生活存在而制造事件。
- offsetStartMinutes/offsetEndMinutes 是相对区间起点的分钟数，必须在0到${maxMinutes}之间且前后有序。
- participantContactIds只能使用候选中的ID；没有充分理由必须为空。interactionMode必须为none、remote或physical。不能随机互动、不能每段都互动。
- 线下互动必须满足地点和日程；不同地点只可能远程联系，且双方手机可用。
- 不得制造死亡、重伤、结婚、分手、辞职等会改写正史的重大事件。
- importance为0到100。普通日常通常20到45；稳定改变未来、关系或目标的事件才可能70以上。
- shareAsMoment只在角色确实愿意分享、内容不私密且距离上次发布合理时为true；大多数经历不发朋友圈。momentContent要符合人设。
- 不要把用户的离线本身写成角色人生事件。

只输出JSON：{"experiences":[{"title":"","summary":"","details":"","offsetStartMinutes":0,"offsetEndMinutes":30,"location":"","activity":"","participantContactIds":[],"interactionMode":"none|remote|physical","importance":30,"visibility":"private|related|public","shareAsMoment":false,"momentContent":""}]}`
  const raw = await chatCompletion({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.utilityModel || settings.model,
    messages: [{ role: 'system', content: prompt }, { role: 'user', content: '补全这段时间，并只返回指定JSON。' }],
    jsonMode: true,
    thinking: 'disabled',
    purpose: 'offlineState',
    automatic: true,
    temperature: 0.35,
    maxTokens: 1400,
  })
  const parsed = parseJsonLoose<{ experiences?: GeneratedExperience[] }>(raw)
  const allowedIds = new Set((await db.contactRelations.filter((row) => row.fromContactId === contact.id || row.toContactId === contact.id).toArray()).flatMap((row) => [row.fromContactId, row.toContactId]).filter((id) => id !== contact.id))
  const generated: ContactMemory[] = []
  for (const item of Array.isArray(parsed?.experiences) ? parsed!.experiences!.slice(0, 5) : []) {
    if (!item || typeof item.summary !== 'string' || !item.summary.trim()) continue
    const startOffset = Math.max(0, Math.min(maxMinutes, Number(item.offsetStartMinutes) || 0))
    const endOffset = Math.max(startOffset, Math.min(maxMinutes, Number(item.offsetEndMinutes) || startOffset))
    const midpoint = new Date(from + ((startOffset + endOffset) / 2) * 60000)
    const runtime = resolveContactRuntimeAt(contact, midpoint, leafLocationIds)
    const resolvedLocation = locationNameById.get(runtime.locationId)
    // The model may narrate an activity but it cannot create a new physical
    // location. Persist the schedule/residence-derived location only.
    const claimedLocation = String(item.location || '').trim()
    if (claimedLocation && resolvedLocation && claimedLocation !== resolvedLocation && /我家|家里|商场|公园|咖啡|餐厅|酒店|住/.test(claimedLocation)) continue
    const participantIds = Array.isArray(item.participantContactIds) ? item.participantContactIds.filter((id) => allowedIds.has(id)) : []
    const interactionMode = item.interactionMode ?? 'none'
    if (participantIds.length > 0) {
      if (interactionMode === 'none') continue
      const midpoint = new Date(from + ((startOffset + endOffset) / 2) * 60000)
      const invalidParticipant = participantIds.some((id) => {
        const other = candidatePlan.contacts.get(id)
        if (!other) return true
        if (interactionMode === 'physical') {
          const ownRuntime = resolveContactRuntimeAt(contact, midpoint, leafLocationIds)
          const otherRuntime = resolveContactRuntimeAt(other, midpoint, leafLocationIds)
          return !ownRuntime.locationId || ownRuntime.locationId !== otherRuntime.locationId
        }
        return !isPhoneAvailable(contact, midpoint) || !isPhoneAvailable(other, midpoint)
      })
      if (invalidParticipant) continue
    }
    const importance = Math.max(0, Math.min(100, Math.round(Number(item.importance) || 30)))
    const endedAt = from + endOffset * 60000
    // Quiet filler is discarded. Only meaningful or interpersonal events
    // enter the unified memory source used by later prompts.
    if (importance >= 45 || participantIds.length > 0) {
      const content = [String(item.title || '生活片段').trim(), item.summary.trim(), String(item.details || '').trim()].filter(Boolean).join('：').slice(0, 900)
      const memory: ContactMemory = {
        id: uuid(), contactId: contact.id, scope: participantIds.length ? 'interpersonal' : 'private', relatedContactIds: participantIds,
        category: importance >= 70 ? '重要事件' : '四季日常', kind: participantIds.length ? 'relationship_event' : 'general', content,
        tags: ['离线生活', String(item.activity || '').trim(), resolvedLocation || ''].filter(Boolean), importance: importance / 100,
        emotionalWeight: Math.min(1, Math.max(0.2, importance / 100)), confidence: 0.85, sourceMessageIds: [], createdAt: endedAt, updatedAt: endedAt, usageCount: 0,
      }
      await db.contactMemories.add(memory)
      for (const participantId of participantIds) await db.contactMemories.add({ ...memory, id: uuid(), contactId: participantId, relatedContactIds: [contact.id, ...participantIds.filter((id) => id !== participantId)] })
      generated.push(memory)
      if (item.shareAsMoment && item.momentContent?.trim()) await createMomentFromExperience(contact, memory, endedAt, item.momentContent)
    }
  }
  await db.contacts.update(contact.id, { experienceCursorAt: to })
  return { absenceContext, generated }
}
