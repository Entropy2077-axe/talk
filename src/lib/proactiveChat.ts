import { db } from '../db/db'
import { triggerAiTurn } from './chatEngine'
import { weightedSampleWithoutReplacement } from './groupChat'
import { describeCurrentSchedule, isPhoneAvailable } from './schedule'
import { useSettingsStore } from '../store/useSettingsStore'
import { toDateKey } from './time'
import type { AppSettings, Contact, ProactiveTopicRecord } from '../types'

export const AUTONOMOUS_TICK_INTERVAL_MS = 5 * 60 * 1000

function canSendToday() {
  const { proactiveMessageLog, proactiveDailyCap } = useSettingsStore.getState()
  const today = toDateKey(new Date())
  return !proactiveMessageLog || proactiveMessageLog.date !== today || proactiveMessageLog.count < proactiveDailyCap
}

function recordSent() {
  const { proactiveMessageLog, setSettings } = useSettingsStore.getState()
  const date = toDateKey(new Date())
  setSettings({ proactiveMessageLog: { date, count: proactiveMessageLog?.date === date ? proactiveMessageLog.count + 1 : 1 } })
}

async function chooseTopic(contact: Contact): Promise<ProactiveTopicRecord | undefined> {
  const used = new Set((contact.proactiveTopicHistory ?? []).filter((x) => Date.now() - x.createdAt < 7 * 86400000).map((x) => x.topic))
  const candidates: Omit<ProactiveTopicRecord, 'createdAt'>[] = []
  for (const event of contact.pendingEvents ?? []) candidates.push({ topic: event, source: 'event' })
  const memories = await db.contactMemories.where('contactId').equals(contact.id).reverse().sortBy('createdAt')
  for (const memory of memories.slice(0, 20)) {
    if (memory.kind === 'open_thread') candidates.push({ topic: memory.content, source: 'open_thread' })
    else if (memory.importance >= 0.65) candidates.push({ topic: memory.content, source: 'memory' })
  }
  for (const plan of contact.upcomingPlans ?? []) candidates.push({ topic: plan.text, source: 'plan' })
  const schedule = describeCurrentSchedule(contact, new Date())
  if (schedule) candidates.push({ topic: schedule, source: 'schedule' })
  if (contact.occupation) candidates.push({ topic: `${contact.occupation}相关的真实日常`, source: 'career' })
  candidates.push({ topic: '结合当前时间和自己的生活状态，发一句符合性格的轻量日常消息', source: 'casual' })
  const chosen = candidates.find((item) => !used.has(item.topic))
  return chosen ? { ...chosen, createdAt: Date.now() } : undefined
}

export async function maybeTriggerProactiveMessage(settings: AppSettings): Promise<void> {
  try {
    if (!settings.apiKey || !canSendToday() || Math.random() > settings.proactiveProbability) return
    const now = Date.now()
    const contacts = await db.contacts.toArray()
    const conversations = await db.conversations.toArray()
    const byContact = new Map(conversations.filter((c) => c.contactId).map((c) => [c.contactId!, c]))
    const eligible = contacts.filter((c) => {
      const conv = byContact.get(c.id)
      return !!conv && now - conv.updatedAt >= settings.proactiveSilenceThresholdMs && (!c.lastProactiveMessageAt || now - c.lastProactiveMessageAt >= settings.proactiveCooldownMs) && isPhoneAvailable(c, new Date(now))
    })
    const [contact] = weightedSampleWithoutReplacement(eligible, 1)
    if (!contact) return
    const topic = await chooseTopic(contact)
    const conv = byContact.get(contact.id)
    if (!topic || !conv) return
    const context = `【本轮类型：主动开启对话】\n自然切入这个素材：${topic.topic}\n来源：${topic.source}。用户此刻没有发新消息，不要写成回复口吻，不要说“你刚才”。不要编造素材之外的突发事件、共同经历或线下见面。开场服从你的人设、关系和当前时间，通常一两条短消息即可。如果这个素材不足以形成自然开场，只输出空回复。最近主动聊过：${(contact.proactiveTopicHistory ?? []).slice(-4).map((x) => x.topic).join('；') || '无'}。`
    const before = await db.aiTurns.where('conversationId').equals(conv.id).count()
    await triggerAiTurn(conv.id, contact, settings, await db.stickers.toArray(), context)
    const after = await db.aiTurns.where('conversationId').equals(conv.id).count()
    if (after <= before) return
    const history = [...(contact.proactiveTopicHistory ?? []), topic].slice(-12)
    await db.contacts.update(contact.id, { lastProactiveMessageAt: now, proactiveTopicHistory: history })
    recordSent()
  } catch (error) {
    console.warn('[proactive] 主动聊天跳过:', error)
  }
}
