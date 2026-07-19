import { chatCompletion } from './deepseek'
import { extractJsonObject } from './aiProtocol'
import type { AdminAiTraceStage, AppSettings } from '../types'

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
  const prompt = `你是Talk的小型逻辑审查器。只判断可验证的客观逻辑，不续写、不润色、不按个人文风偏好挑错。
检查：是否回答最新话语；是否混淆人物身份、说话人、指代、时间、地点、因果；是否违反给出的人设硬事实；是否把未来安排当成已经发生；是否忽略用户明确纠正；是否完全忽略关系定位、共同过往或核心性格特质，尤其是首轮本应可辨认的行为锚点。
简短、冷淡、口语化、拒绝、不同意用户都不是错误。只有存在明确逻辑问题才valid=false，并用一句人能看懂的话说明主模型应修正什么。
只输出JSON：{"valid":true,"reason":""}

【最新用户话语】
${input.latestUserText || '后台事件'}

【主模型草稿】
${input.draftText}

【本轮相关硬事实】
${input.personaFacts || '无'}

【必要近期上下文】
${input.recentContext || '无'}`

  const raw = await chatCompletion({
    apiKey: input.settings.apiKey,
    baseUrl: input.settings.baseUrl,
    model: input.settings.utilityModel,
    jsonMode: true,
    thinking: 'disabled',
    temperature: 0,
    maxTokens: 180,
    purpose: 'quality',
    messages: [{ role: 'system', content: prompt }],
    signal: input.signal,
    trace: input.trace,
  })
  return parseTurnLogicReview(raw)
}
