import { v4 as uuid } from 'uuid'
import { canPublishNovelMoment } from './moments'
import { db } from '../db/db'
import type { AppSettings, Contact, ContactExperience, ContactLifeState } from '../types'
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
    .join('\n') || '没有固定日程；请只依据人设、世界观和已有生活状态补全自然日常。'
}

async function interactionCandidates(contact: Contact, from: number, to: number) {
  const rows = uniqueRelationPairs(await db.contactRelations.filter((row) => row.fromContactId === contact.id || row.toContactId === contact.id).toArray())
  const otherIds = rows.map((row) => row.fromContactId === contact.id ? row.toContactId : row.fromContactId)
  const [others, states] = await Promise.all([db.contacts.bulkGet(otherIds), db.contactLifeStates.bulkGet(otherIds)])
  const ownState = await db.contactLifeStates.get(contact.id)
  const allowedPhysical = new Set<string>()
  const contacts = new Map<string, Contact>()
  const text = rows.map((row, index) => {
    const other = others[index]
    if (!other) return ''
    contacts.set(other.id, other)
    const state = states[index]
    const sameKnownLocation = !!ownState?.location && !!state?.location && ownState.location === state.location
    if (sameKnownLocation) allowedPhysical.add(other.id)
    return [
      `ID=${other.id}；姓名=${displayName(other)}；关系=${row.label}`,
      `人设摘要=${other.systemPrompt.slice(0, 260)}`,
      `当前状态=${state ? `${state.location}/${state.activity}` : '未知'}`,
      `区间日程=${scheduleSlice(other, from, to)}`,
      `线下互动=${sameKnownLocation ? '地点已知一致，但仍须检查日程' : '禁止；地点未确认一致'}；远程互动=仅在双方手机可用且有明确理由时允许`,
    ].join('\n')
  }).filter(Boolean).join('\n\n') || '没有可互动的已关联联系人。不得自行添加参与者。'
  return { text, allowedPhysical, contacts }
}

function desiredCount(gap: number) {
  if (gap < 3 * HOUR) return '0到1'
  if (gap < 8 * HOUR) return '1到2'
  if (gap < DAY) return '1到3'
  if (gap < 3 * DAY) return '2到4'
  return '2到5段阶段摘要'
}

async function createMomentFromExperience(contact: Contact, experience: ContactExperience, content: string) {
  const recent = await db.moments.where('contactId').equals(contact.id).reverse().sortBy('createdAt')
  if (recent[0] && (experience.endedAt ?? experience.createdAt) - recent[0].createdAt < 2 * HOUR) return
  const createdAt = Math.max(experience.startedAt ?? experience.createdAt, Math.min(experience.endedAt ?? experience.createdAt, experience.createdAt))
  if (!await canPublishNovelMoment(contact.id, content, createdAt)) return
  const id = uuid()
  await db.moments.add({ id, contactId: contact.id, content: content.trim().slice(0, 500), createdAt, sourceExperienceId: experience.id })
  await db.contacts.update(contact.id, { lastMomentAt: createdAt })
  await db.contactExperiences.update(experience.id, { surfacedAsMoment: true })
}

export interface OfflineExperienceResult {
  absenceContext: string
  generated: ContactExperience[]
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

  const [worldbook, candidatePlan, lifeState] = await Promise.all([
    Promise.all([
      retrieveWorldbookContext(`${contact.name}\n${contact.systemPrompt}\n${contact.schedule?.map((block) => `${block.location} ${block.activity}`).join('\n') || ''}`, { worldviewId: settings.activeWorldId || settings.defaultWorldviewId, maxEntries: 8, maxChars: 5000, includeHighPriorityFallback: true }),
      selectedWorldbookEntriesText(contact.worldbookEntryIds ?? []),
    ]).then((parts) => parts.filter(Boolean).join('\n\n')),
    interactionCandidates(contact, from, to),
    db.contactLifeStates.get(contact.id),
  ])
  const mapLocations = await db.locations.toArray()
  const leafLocationIds = new Set(mapLocations.filter((location) => isLeafLocation(location.id, mapLocations)).map((location) => location.id))
  const locationNameById = new Map(mapLocations.map((location) => [location.id, location.name]))
  const maxMinutes = Math.max(60, Math.floor(gap / 60000))
  const prompt = `你是角色离线经历补全器。根据自由人设、世界观、自然语言日程和时间区间，补全角色在用户没有回复时真实经历的生活。职业和活动完全开放，禁止套用固定的上班/上学模板。

【角色】${displayName(contact)}（ID=${contact.id}）
【人设】${contact.systemPrompt}
【关系】${contact.relationshipBase || '未说明'}；${contact.relationshipDynamic || ''}
【过去经历】${contact.sharedHistory || '无单独记录'}
【区间】${new Date(from).toLocaleString()} 至 ${new Date(to).toLocaleString()}，共${durationText(gap)}
【区间日程】\n${scheduleSlice(contact, from, to)}
【开始状态】${lifeState ? `${lifeState.location}；${lifeState.activity}；精力${lifeState.energy}；压力${lifeState.stress}；${lifeState.situation || ''}` : '暂无，谨慎补全'}
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
    purpose: 'lifeSimulation',
    automatic: true,
    temperature: 0.35,
    maxTokens: 1400,
  })
  const parsed = parseJsonLoose<{ experiences?: GeneratedExperience[] }>(raw)
  const allowedIds = new Set((await db.contactRelations.filter((row) => row.fromContactId === contact.id || row.toContactId === contact.id).toArray()).flatMap((row) => [row.fromContactId, row.toContactId]).filter((id) => id !== contact.id))
  const generated: ContactExperience[] = []
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
        if (interactionMode === 'physical') return !candidatePlan.allowedPhysical.has(id)
        return !isPhoneAvailable(contact, midpoint) || !isPhoneAvailable(other, midpoint)
      })
      if (invalidParticipant) continue
    }
    const importance = Math.max(0, Math.min(100, Math.round(Number(item.importance) || 30)))
    const endedAt = from + endOffset * 60000
    const experience: ContactExperience = {
      id: uuid(), contactIds: [contact.id, ...participantIds], kind: 'offline', memoryTier: importance >= 70 ? 'long' : 'short',
      title: String(item.title || '生活片段').trim().slice(0, 80), summary: item.summary.trim().slice(0, 500), details: String(item.details || '').trim().slice(0, 1200) || undefined,
      startedAt: from + startOffset * 60000, endedAt, location: resolvedLocation || undefined,
      importance, sources: ['simulation'], createdAt: endedAt, expiresAt: importance >= 70 ? undefined : endedAt + 3 * DAY,
    }
    await db.contactExperiences.add(experience)
    generated.push(experience)
    if (item.shareAsMoment && item.momentContent?.trim()) await createMomentFromExperience(contact, experience, item.momentContent)
  }
  const last = generated.at(-1)
  const statePatch: Partial<ContactLifeState> = last ? { location: last.location || lifeState?.location || '未知', activity: last.title, situation: last.summary, updatedAt: last.endedAt ?? to } : {}
  if (last) await db.contactLifeStates.put({ contactId: contact.id, energy: lifeState?.energy ?? 65, stress: lifeState?.stress ?? 25, socialNeed: lifeState?.socialNeed ?? 45, ...lifeState, ...statePatch } as ContactLifeState)
  await db.contacts.update(contact.id, { experienceCursorAt: to })
  return { absenceContext, generated }
}

/** Attribute -> prompt slice. Uses fixed tiers/participants/importance, never keyword matching. */
export async function buildExperiencePromptSlice(contactId: string, now: number): Promise<string> {
  const rows = await db.contactExperiences.where('contactIds').equals(contactId).toArray()
  const active = rows.filter((row) => !row.expiresAt || row.expiresAt > now)
  const past = active.filter((row) => row.kind === 'past').sort((a, b) => b.importance - a.importance).slice(0, 6)
  const long = active.filter((row) => row.kind === 'offline' && row.memoryTier === 'long').sort((a, b) => b.importance - a.importance).slice(0, 5)
  const recent = active.filter((row) => row.kind === 'offline' && row.memoryTier === 'short').sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt)).slice(0, 4)
  const render = (title: string, items: ContactExperience[]) => items.length ? `【${title}】\n${items.map((item) => `- ${item.periodLabel ? `${item.periodLabel}：` : ''}${item.summary}${item.location ? `（${item.location}）` : ''}`).join('\n')}` : ''
  return [render('过去的经历（正史）', past), render('重要人生经历', long), render('最近生活', recent)].filter(Boolean).join('\n\n').slice(0, 4200)
}
