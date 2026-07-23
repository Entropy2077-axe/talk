import { chatCompletion } from './deepseek'
import { extractJsonObject } from './aiProtocol'
import type { AdminAiTraceStage, AppSettings } from '../types'
import { getPromptTemplate } from './promptModules'

export interface TurnLogicReviewInput {
  settings: AppSettings
  latestUserText: string
  draftText: string
  personaFacts: string
  recentContext?: string
  signal?: AbortSignal
  trace: { turnId: string; stage: AdminAiTraceStage; conversationId: string }
}

export function parseTurnLogicReview(raw: string): { valid: boolean; reason: string } {
  const json = extractJsonObject(raw)
  if (!json) return { valid: false, reason: '逻辑审查模型没有返回有效JSON' }
  try {
    const parsed = JSON.parse(json) as { valid?: unknown; reason?: unknown }
    return {
      valid: parsed.valid === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 240) : '',
    }
  } catch {
    return { valid: false, reason: '逻辑审查模型返回格式无效' }
  }
}

/**
 * A deliberately small self-check. It judges only objective logic and never
 * rewrites prose, keeping the common valid path short and predictable.
 */
export async function reviewTurnLogic(
  input: TurnLogicReviewInput,
): Promise<{ valid: boolean; reason: string }> {
  const editable = getPromptTemplate(input.settings, 'chat', 'logicReview', {
    latestUserText: input.latestUserText || '后台事件',
    draftText: input.draftText,
    personaFacts: input.personaFacts || '无',
    recentContext: input.recentContext || '无',
  })
  if (!editable) return { valid: true, reason: '' }
  const prompt = `${editable}\n\n固定输出协议：只输出JSON {"valid":true,"reason":""}`

  const raw = await chatCompletion({
    apiKey: input.settings.apiKey,
    baseUrl: input.settings.baseUrl,
    model: input.settings.utilityModel,
    jsonMode: true,
    thinking: 'disabled',
    temperature: 0,
    maxTokens: 180,
    purpose: 'quality',
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: '请审查上述回复，并严格按照指定的 JSON 格式输出结果。' },
    ],
    signal: input.signal,
    trace: input.trace,
  })
  return parseTurnLogicReview(raw)
}
