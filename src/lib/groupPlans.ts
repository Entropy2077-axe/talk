import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { recordSocialEvent } from './socialEvents'
import { chatCompletion } from './deepseek'
import type { AppSettings, Group, GroupPlan, GroupPlanStatus, Message } from '../types'
import { getPromptTemplate, promptModuleEnabled } from './promptModules'

export async function createGroupPlan(opts: {
  group: Group
  conversationId: string
  sourceMessageId?: string
  title: string
  summary: string
  participantContactIds: string[]
  scheduledAt?: number
  location?: string
}): Promise<GroupPlan | null> {
  const participants = Array.from(new Set(opts.participantContactIds.filter((id) => opts.group.memberContactIds.includes(id))))
  if (!opts.title.trim() || participants.length < 2) return null
  const duplicate = await db.groupPlans
    .where('groupId').equals(opts.group.id)
    .filter((plan) => plan.status !== 'cancelled' && plan.status !== 'completed' && plan.title.trim() === opts.title.trim())
    .first()
  if (duplicate) return duplicate
  const plan: GroupPlan = {
    id: uuid(), groupId: opts.group.id, sourceConversationId: opts.conversationId, sourceMessageId: opts.sourceMessageId,
    title: opts.title.trim().slice(0, 80), summary: opts.summary.trim().slice(0, 180), scheduledAt: opts.scheduledAt,
    location: opts.location?.trim().slice(0, 80), participantContactIds: participants, status: 'pending', createdAt: Date.now(),
  }
  await db.groupPlans.add(plan)
  await recordSocialEvent({ type: 'group_plan_created', actorId: 'user', relatedContactIds: participants, groupId: plan.groupId, conversationId: plan.sourceConversationId, messageId: plan.sourceMessageId, summary: `群聊“${opts.group.name}”形成待确认计划：${plan.title}`, importance: 2 })
  return plan
}

export async function setGroupPlanStatus(plan: GroupPlan, group: Group, status: GroupPlanStatus, settings?: AppSettings): Promise<GroupPlan> {
  const resolvedAt = status === 'completed' || status === 'cancelled' ? Date.now() : undefined
  const next = { ...plan, status, resolvedAt }
  await db.groupPlans.update(plan.id, { status, resolvedAt })
  const labels: Record<GroupPlanStatus, string> = { pending: '待确认', confirmed: '已确认', completed: '已成行', cancelled: '已取消' }
  const eventType = status === 'confirmed' ? 'group_plan_confirmed' : status === 'completed' ? 'group_plan_completed' : status === 'cancelled' ? 'group_plan_cancelled' : 'group_plan_created'
  await recordSocialEvent({ type: eventType, actorId: 'user', relatedContactIds: plan.participantContactIds, groupId: group.id, conversationId: plan.sourceConversationId, summary: `群聊“${group.name}”的计划“${plan.title}”${labels[status]}`, importance: status === 'completed' ? 3 : 2 })
  if (status === 'completed') {
    await recordSocialEvent({ type: 'group_plan_aftermath', actorId: 'user', relatedContactIds: plan.participantContactIds, groupId: group.id, conversationId: plan.sourceConversationId, summary: `“${plan.title}”已经成行，成员可以在后续群聊和朋友圈自然分享这段共同经历`, importance: 3 })
    if (settings?.apiKey) await generatePlanAftermath(plan, group, settings)
  }
  return next
}

async function generatePlanAftermath(plan: GroupPlan, group: Group, settings: AppSettings): Promise<void> {
  try {
    if (!promptModuleEnabled(settings, 'moments')) return
    const contacts = (await db.contacts.bulkGet(plan.participantContactIds)).filter((contact): contact is NonNullable<typeof contact> => !!contact)
    const editable = getPromptTemplate(settings, 'moments', 'planAftermath', {
      planContext: `${plan.title}；${plan.summary}`,
      participants: JSON.stringify(contacts.map((contact) => ({ id: contact.id, name: contact.name, persona: contact.systemPrompt }))),
    }) ?? ''
    const raw = await chatCompletion({
      apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel, jsonMode: true, maxTokens: 600, purpose: 'moments',
      messages: [{ role: 'system', content: `${editable}\n\n固定输出协议：只输出JSON {"groupMessage":"...","moments":[{"contactId":"participant id","content":"public moment"}]}` }, { role: 'user', content: 'Generate aftermath.' }],
    })
    const parsed = JSON.parse(raw) as { groupMessage?: unknown; moments?: Array<{ contactId?: unknown; content?: unknown }> }
    if (typeof parsed.groupMessage === 'string' && parsed.groupMessage.trim()) {
      await db.messages.add({ id: uuid(), conversationId: plan.sourceConversationId, role: 'assistant', type: 'text', content: parsed.groupMessage.trim().slice(0, 240), speakerContactId: plan.participantContactIds[0], createdAt: Date.now() })
    }
    for (const moment of (parsed.moments ?? []).slice(0, 2)) {
      const contactId = typeof moment.contactId === 'string' ? moment.contactId : ''
      const content = typeof moment.content === 'string' ? moment.content.trim().slice(0, 220) : ''
      if (!plan.participantContactIds.includes(contactId) || !content) continue
      const momentId = uuid()
      await db.moments.add({ id: momentId, contactId, content, createdAt: Date.now() })
      await recordSocialEvent({ type: 'moment_posted', actorId: contactId, relatedContactIds: plan.participantContactIds, groupId: group.id, conversationId: plan.sourceConversationId, momentId, summary: `${contacts.find((contact) => contact.id === contactId)?.name || '成员'}分享了“${plan.title}”后的动态`, importance: 2 })
    }
  } catch {
    // Completion itself remains valid if the optional creative aftermath fails.
  }
}

export function planCardMessage(plan: GroupPlan): Message {
  return { id: uuid(), conversationId: plan.sourceConversationId, role: 'assistant', type: 'groupPlan', content: plan.title, groupPlanId: plan.id, createdAt: Date.now() }
}
