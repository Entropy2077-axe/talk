import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion } from './deepseek'
import { useSettingsStore } from '../store/useSettingsStore'
import { retrieveWorldbookContext } from './worldbook'
import type { AppSettings, Contact, ContactLifeState, LifeEvent } from '../types'
import { getPromptTemplate, promptModuleEnabled } from './promptModules'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
let running: Promise<void> | null = null

function seeded(seed: string) {
  let n = 2166136261
  for (let i = 0; i < seed.length; i++) n = Math.imul(n ^ seed.charCodeAt(i), 16777619)
  return () => ((n = Math.imul(n ^ (n >>> 13), 1274126177)) >>> 0) / 4294967296
}

export function lifeWindows(from: number, to: number): number[] {
  const gap = Math.max(0, to - from)
  const step = gap < 6 * HOUR ? 2 * HOUR : gap < 2 * DAY ? 6 * HOUR : gap < 14 * DAY ? DAY : 3 * DAY
  const points: number[] = []
  for (let time = from + step; time <= to; time += step) points.push(time)
  return points.slice(-30)
}

function activityAt(contact: Contact, time: number) {
  const hour = new Date(time).getHours()
  if (hour < 7 || hour >= 23) return { activity: '休息', location: '家中', type: 'routine' as const, visibility: 'private' as const }
  if (contact.occupation && hour >= 9 && hour < 18) return { activity: '工作', location: '工作地点', type: 'work' as const, visibility: 'private' as const }
  if (hour >= 18 && hour < 22) return { activity: '处理自己的生活', location: '外出或家中', type: 'social' as const, visibility: 'related' as const }
  return { activity: '日常活动', location: '家中', type: 'routine' as const, visibility: 'private' as const }
}

function template(contact: Contact, activity: string, random: number) {
  if (activity === '工作') return random > .6 ? `${contact.name} 临时处理了一件工作上的小麻烦。` : `${contact.name} 按照日常节奏完成了工作安排。`
  if (activity === '休息') return `${contact.name} 留出了一段安静休息的时间。`
  return random > .65 ? `${contact.name} 给自己安排了一点不被打扰的个人时间。` : `${contact.name} 过了一段平静的日常。`
}

function nextState(contact: Contact, current: ContactLifeState | undefined, event: LifeEvent): ContactLifeState {
  const energy = Math.max(0, Math.min(100, (current?.energy ?? 65) + (event.type === 'routine' ? 8 : event.type === 'work' ? -12 : -3)))
  const stress = Math.max(0, Math.min(100, (current?.stress ?? 25) + (event.type === 'work' ? 9 : -4)))
  return { contactId: contact.id, location: event.type === 'work' ? '工作地点' : event.type === 'routine' ? '家中' : '日常活动地点', activity: event.type === 'work' ? '工作' : event.type === 'routine' ? '休息' : '日常活动', energy, stress, socialNeed: Math.max(0, Math.min(100, (current?.socialNeed ?? 45) + (event.type === 'social' ? -8 : 5))), currentGoal: current?.currentGoal || (contact.occupation ? '维持自己的生活节奏' : '处理好最近的日常'), situation: event.summary, updatedAt: event.occurredAt }
}

async function polishVisible(events: LifeEvent[], settings: AppSettings): Promise<Map<string, string>> {
  const fallback = new Map(events.map((e) => [e.id, e.summary]))
  if (!settings.apiKey || events.length === 0 || !promptModuleEnabled(settings, 'lifeSimulation')) return fallback
  try {
    const world = promptModuleEnabled(settings, 'worldview') ? await retrieveWorldbookContext(events.map((e) => e.summary).join('\n'), { maxEntries: 3, maxChars: 1600 }) : ''
    const worldPrompt = world ? getPromptTemplate(settings, 'worldview', 'lifeRuntime', { worldbookEntries: world }) : ''
    const lifeContext = `${worldPrompt || ''}\n事件：${JSON.stringify(events.map((e) => ({ id: e.id, summary: e.summary })))}`
    const editable = getPromptTemplate(settings, 'lifeSimulation', 'polish', { lifeContext })!
    const raw = await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel, purpose: 'lifeSimulation', automatic: true, jsonMode: true, messages: [{ role: 'system', content: `${editable}\n\n固定输出协议：只输出JSON {"items":[{"id":"事件id","text":"文案"}]}` }, { role: 'user', content: '请润色' }] })
    const parsed = JSON.parse(raw) as { items?: Array<{ id?: string; text?: string }> }
    for (const item of parsed.items ?? []) if (item.id && typeof item.text === 'string' && fallback.has(item.id)) fallback.set(item.id, item.text.trim().slice(0, 120))
  } catch {
    // A deterministic event is still better than losing the character's timeline.
  }
  return fallback
}

export async function runLifeSimulation(settings = useSettingsStore.getState()): Promise<void> {
  if (!settings.enabledModules.includes('lifeSimulation')) return
  if (running) return running.then(() => runLifeSimulation(settings))
  running = (async () => {
    const now = Date.now()
    const state = await db.simulationState.get('global')
    const seed = state?.seed || uuid()
    const from = state?.lastSimulatedAt || now
    if (now - from < 15 * 60 * 1000) return
    const contacts = await db.contacts.toArray()
    if (contacts.length === 0) return
    const windows = lifeWindows(from, now)
    const newEvents: LifeEvent[] = []
    const states = new Map((await db.contactLifeStates.toArray()).map((item) => [item.contactId, item]))
    for (const contact of contacts) {
      const random = seeded(`${seed}:${contact.id}:${from}:${now}`)
      let life = states.get(contact.id)
      let produced = false
      for (const occurredAt of windows) {
        const fact = activityAt(contact, occurredAt)
        if (random() > (fact.type === 'work' ? .46 : .24)) continue
        const visibility = fact.type === 'social' && random() > .72 ? 'public' : fact.visibility
        const importance = (fact.type === 'work' && random() > .75) || (fact.type === 'social' && random() > .55) ? 3 : 1
        const event: LifeEvent = { id: uuid(), contactId: contact.id, type: fact.type, summary: template(contact, fact.activity, random()), participantContactIds: [], visibility, importance, occurredAt, expiresAt: occurredAt + 14 * DAY }
        newEvents.push(event)
        produced = true
        life = nextState(contact, life, event)
      }
      if (!produced && windows.length > 0) {
        const occurredAt = windows.at(-1)!
        const fact = activityAt(contact, occurredAt)
        const event: LifeEvent = { id: uuid(), contactId: contact.id, type: fact.type, summary: template(contact, fact.activity, random()), participantContactIds: [], visibility: fact.visibility, importance: 1, occurredAt, expiresAt: occurredAt + 14 * DAY }
        newEvents.push(event)
        life = nextState(contact, life, event)
      }
      if (now - from > 14 * DAY) {
        newEvents.push({ id: uuid(), contactId: contact.id, type: 'summary', summary: `${contact.name} 这段时间逐渐回到了自己的生活节奏。`, participantContactIds: [], visibility: 'related', importance: 2, occurredAt: now - 1, expiresAt: now + 14 * DAY })
      }
      if (life) await db.contactLifeStates.put(life)
    }
    const ordinary = newEvents.filter((event) => event.importance < 3).slice(-20)
    const important = newEvents.filter((event) => event.importance >= 3).slice(-5)
    const kept = [...ordinary, ...important].sort((a, b) => a.occurredAt - b.occurredAt)
    if (kept.length) await db.lifeEvents.bulkAdd(kept)
    const publicEvents = kept.filter((event) => event.visibility === 'public').slice(-3)
    const messageEvent = kept.filter((event) => event.importance >= 3 && event.visibility !== 'private').at(-1)
    const visible = [...publicEvents, ...(messageEvent && !publicEvents.some((event) => event.id === messageEvent.id) ? [messageEvent] : [])]
    const polished = await polishVisible(visible, settings)
    for (const event of publicEvents) {
      const contact = contacts.find((item) => item.id === event.contactId)
      if (!contact) continue
      await db.moments.add({ id: uuid(), contactId: contact.id, content: polished.get(event.id) || event.summary, createdAt: event.occurredAt })
      await db.contacts.update(contact.id, { lastMomentAt: event.occurredAt })
      await db.lifeEvents.update(event.id, { surfacedAsMoment: true })
    }
    if (messageEvent) {
      const conversation = await db.conversations.where('contactId').equals(messageEvent.contactId).first()
      if (conversation) {
        await db.messages.add({ id: uuid(), conversationId: conversation.id, role: 'assistant', type: 'text', content: polished.get(messageEvent.id) || messageEvent.summary, createdAt: messageEvent.occurredAt })
        await db.conversations.update(conversation.id, { updatedAt: messageEvent.occurredAt })
        await db.lifeEvents.update(messageEvent.id, { surfacedAsMessage: true })
      }
    }
    await db.simulationState.put({ id: 'global', lastSimulatedAt: now, seed, version: 1, lastStatus: `补演 ${kept.length} 条事件` })
  })().finally(() => { running = null })
  return running
}
