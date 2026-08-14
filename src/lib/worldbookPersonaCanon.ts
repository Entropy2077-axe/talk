import type { AppSettings } from '../types'
import { parseJsonLoose } from './aiProtocol'
import { chatCompletionText } from './deepseek'

export interface CanonicalInitialMemory {
  title: string
  period: string
  summary: string
  relatedContactNames: string[]
  importance: number
}

export interface WorldbookPersonaCanon {
  relationship: string
  sharedHistory: string
  facts: string[]
  boundaries: string[]
  initialMemories: CanonicalInitialMemory[]
}

export async function extractWorldbookPersonaCanon(opts: {
  settings: AppSettings
  worldbookText: string
  requestedCharacter: string
  existingContactNames: string[]
  /** Cancels the extraction together with its parent contact-generation job. */
  signal?: AbortSignal
}): Promise<WorldbookPersonaCanon> {
  if (!opts.worldbookText.trim()) return { relationship: '', sharedHistory: '', facts: [], boundaries: [], initialMemories: [] }
  const raw = await chatCompletionText({
    apiKey: opts.settings.apiKey,
    baseUrl: opts.settings.baseUrl,
    model: opts.settings.utilityModel || opts.settings.model,
    messages: [{ role: 'system', content: `你是世界书正史提取器。只提取原文明确存在或能直接推出的事实，不补写剧情。重点提取目标角色与用户、已有角色之间已经发生的关系和记忆。已有联系人姓名只能从给定名单中选择。只输出 JSON：{"relationship":"与用户的既有关系","sharedHistory":"与用户共同记忆摘要","facts":["身份事实"],"boundaries":["不可违背的边界"],"initialMemories":[{"title":"标题","period":"时期","summary":"已发生的具体事件及影响","relatedContactNames":["已有联系人姓名"],"importance":85}]}` }, { role: 'user', content: `目标角色线索：${opts.requestedCharacter || '从世界书中识别主要目标角色'}\n已有联系人：${opts.existingContactNames.join('、') || '无'}\n世界书：\n${opts.worldbookText.slice(0, 10000)}` }],
    jsonMode: true,
    thinking: 'disabled',
    purpose: 'worldbook',
    signal: opts.signal,
    temperature: 0,
    maxTokens: 1600,
  })
  const parsed = parseJsonLoose<Record<string, unknown>>(raw)
  if (!parsed) throw new Error('世界书正史提取失败，请检查模型输出后重试')
  const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : []
  const allowedNames = new Set(opts.existingContactNames.map((name) => name.toLocaleLowerCase()))
  const memories = Array.isArray(parsed.initialMemories) ? parsed.initialMemories : []
  return {
    relationship: typeof parsed.relationship === 'string' ? parsed.relationship.trim().slice(0, 80) : '',
    sharedHistory: typeof parsed.sharedHistory === 'string' ? parsed.sharedHistory.trim().slice(0, 1200) : '',
    facts: list(parsed.facts).slice(0, 12),
    boundaries: list(parsed.boundaries).slice(0, 12),
    initialMemories: memories.filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).summary === 'string').slice(0, 12).map((value) => ({
      title: typeof value.title === 'string' ? value.title.trim().slice(0, 80) : '世界书中的过去',
      period: typeof value.period === 'string' ? value.period.trim().slice(0, 80) : '',
      summary: String(value.summary).trim().slice(0, 800),
      relatedContactNames: list(value.relatedContactNames).filter((name) => allowedNames.has(name.toLocaleLowerCase())).slice(0, 8),
      importance: Math.max(70, Math.min(100, Math.round(Number(value.importance) || 85))),
    })),
  }
}
