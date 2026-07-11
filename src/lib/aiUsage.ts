import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'
import { toDateKey } from './time'
import type { AiUsagePurpose } from '../types'

export class AiBudgetExceededError extends Error {
  constructor() { super('自动 AI 调用已达到今日预算上限') }
}

export async function assertAutomaticAiBudget(): Promise<void> {
  const cap = useSettingsStore.getState().automaticAiDailyCap
  if (!cap || cap < 1) return
  const today = toDateKey(new Date())
  const records = await db.aiUsageRecords.filter((r) => r.automatic && r.success && toDateKey(new Date(r.createdAt)) === today).count()
  if (records >= cap) throw new AiBudgetExceededError()
}

export async function recordAiUsage(opts: {
  purpose: AiUsagePurpose; model: string; automatic: boolean; success: boolean
  inputTokens: number; outputTokens: number; estimated: boolean; error?: string
}) {
  await db.aiUsageRecords.add({ id: uuid(), createdAt: Date.now(), ...opts })
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3))
}
