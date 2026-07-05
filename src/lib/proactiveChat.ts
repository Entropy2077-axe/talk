import { db } from '../db/db'
import { triggerAiTurn } from './chatEngine'
import { weightedSampleWithoutReplacement } from './groupChat'
import { isPhoneAvailable } from './schedule'
import { useSettingsStore } from '../store/useSettingsStore'
import { toDateKey } from './time'
import type { AppSettings } from '../types'

/**
 * "Looks autonomous while the app is open" — see the design discussion in
 * conversation. There's no backend/push, so none of this can fire while the
 * tab is closed; App.tsx runs a foreground setInterval at this cadence that
 * calls maybeTriggerProactiveMessage() (and separately, refreshMoments()).
 */
export const AUTONOMOUS_TICK_INTERVAL_MS = 5 * 60 * 1000 // 5 min — just the background timer's own polling cadence, not user-facing

function canSendProactiveToday(): boolean {
  const { proactiveMessageLog, proactiveDailyCap } = useSettingsStore.getState()
  const today = toDateKey(new Date())
  if (!proactiveMessageLog || proactiveMessageLog.date !== today) return true
  return proactiveMessageLog.count < proactiveDailyCap
}

function recordProactiveSent(): void {
  const { proactiveMessageLog, setSettings } = useSettingsStore.getState()
  const today = toDateKey(new Date())
  const count = proactiveMessageLog && proactiveMessageLog.date === today ? proactiveMessageLog.count + 1 : 1
  setSettings({ proactiveMessageLog: { date: today, count } })
}

/**
 * Fire-and-forget: on each tick, maybe pick exactly one contact (never
 * more — several people all reaching out in the same tick would feel like
 * spam, not a slice-of-life ping) to proactively open a chat. Who gets
 * picked and whether anything happens at all is entirely code-driven, not
 * left to the model — same philosophy as moments.ts and groupChat.ts.
 */
export async function maybeTriggerProactiveMessage(settings: AppSettings): Promise<void> {
  try {
    if (!settings.apiKey) return
    if (!canSendProactiveToday()) return
    if (Math.random() > settings.proactiveProbability) return

    const now = Date.now()
    const contacts = await db.contacts.toArray()
    if (contacts.length === 0) return

    const conversations = await db.conversations.toArray()
    const conversationByContact = new Map(
      conversations.filter((c) => c.contactId).map((c) => [c.contactId!, c]),
    )

    const nowDate = new Date(now)
    const eligible = contacts.filter((c) => {
      const conv = conversationByContact.get(c.id)
      if (!conv) return false
      if (now - conv.updatedAt < settings.proactiveSilenceThresholdMs) return false
      if (c.lastProactiveMessageAt && now - c.lastProactiveMessageAt < settings.proactiveCooldownMs) return false
      if (!isPhoneAvailable(c, nowDate)) return false
      return true
    })
    if (eligible.length === 0) return

    const [chosen] = weightedSampleWithoutReplacement(eligible, 1)
    if (!chosen) return

    const conv = conversationByContact.get(chosen.id)
    if (!conv) return

    const events = chosen.pendingEvents ?? []
    const patch = {
      pendingEvents: [...events, '你已经有一阵子没主动找对方聊天了 可以自然地找个话题主动开启对话'],
      lastProactiveMessageAt: now,
    }
    await db.contacts.update(chosen.id, patch)
    recordProactiveSent()

    const stickers = await db.stickers.toArray()
    // Pass the merged-in patch, not the stale `chosen` object fetched before
    // the update above — runAiTurn reads contact.pendingEvents directly off
    // whatever object it's handed, so handing it the pre-update snapshot
    // would silently skip the very hint we just wrote (and never clear it).
    await triggerAiTurn(conv.id, { ...chosen, ...patch }, settings, stickers)
  } catch {
    // best-effort only, same as the memory/moments background jobs
  }
}
