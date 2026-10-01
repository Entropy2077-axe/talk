import type { ChatMessage } from './deepseek'

export const JEV_MODEL = 'typesafe/jev-1.13'
export const JEV_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions'

export const ACTION_CRITERIA = {
  sticker: '角色此刻确实要发送表情包；只是提到表情包或讨论未来发送不算。',
  image: '角色此刻确实要发送照片、自拍或图片；用户明确索要且角色能够发送时也算。',
  schedule: '角色已经具体承诺一项未来线下安排，日期、起止整点与合法地点都明确；讨论或附带未满足条件不算。',
  activity_now: '角色在回复中无条件决定现在立刻出发，或明确约定 1-720 分钟后出发去已知具体地点；仍需地址、等待直播结束等条件，或只说将来会去，都不算。',
  outfit_change: '角色在这一轮已实际完成穿上、脱下或换装；描述当前衣服、建议、打算或单方面命令不算。',
  contact_recommendation: '角色确实认识一个尚未与用户建立联系的人，并决定此刻介绍给用户。',
  transfer: '角色决定现在向用户转账，并且金额明确。',
  red_packet: '角色决定现在给用户发红包，并且金额明确。',
  loan_request: '角色决定现在向用户借款，并且金额明确。',
  loan_decision: '上下文有一笔待处理借款，角色此刻明确接受或拒绝。',
  gift_purchase: '角色决定现在购买一件明确的礼物送给用户。',
} as const

export type JevActionType = keyof typeof ACTION_CRITERIA

export interface JevActionOptions {
  apiKey: string
  messages: ChatMessage[]
  allowed: JevActionType[]
  candidateReply?: string
  signal?: AbortSignal
}

export async function chooseJevActions({ apiKey, messages, allowed, candidateReply, signal }: JevActionOptions): Promise<JevActionType[]> {
  if (!apiKey.trim()) throw new Error('请先填写 OpenRouter Jev API Key')
  if (allowed.length === 0) return []
  const contextMessages = [
    ...messages.filter((message) => message.role === 'system').slice(0, 1),
    ...messages.slice(-10),
  ]
  const state = {
    context: contextMessages.map((message, index) => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content.slice(0, index === 0 ? 7000 : 3500) : '',
    })),
    ...(candidateReply ? { candidate_reply: candidateReply.slice(0, 5000) } : {}),
  }
  const questions = Object.fromEntries(allowed.map((type) => [type, {
    type: 'noul',
    instructions: `根据 context 中的角色设定、当前事实、最后的用户消息${candidateReply ? '和 candidate_reply 中角色实际说出的回复' : ''}，判断这一轮是否应执行此动作：${ACTION_CRITERIA[type]} 只判断现在已经成立的行动；不确定、可能性讨论和未来意图应回答否。`,
  }]))
  const response = await fetch(JEV_DECISIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    signal,
  })
  if (!response.ok) throw new Error(`Jev 决策请求失败（HTTP ${response.status}）`)
  const payload: unknown = await response.json()
  if (!payload || typeof payload !== 'object' || !('answers' in payload)) throw new Error('Jev 返回缺少 answers')
  const answers = (payload as { answers: unknown }).answers
  if (!answers || typeof answers !== 'object') throw new Error('Jev 返回的 answers 无效')
  return allowed.filter((type) => {
    const answer = (answers as Record<string, unknown>)[type]
    if (!answer || typeof answer !== 'object' || typeof (answer as { noul?: unknown }).noul !== 'number') {
      throw new Error(`Jev 未返回有效的 ${type} 判断`)
    }
    const probability = (answer as { noul: number }).noul
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error(`Jev 的 ${type} 概率无效`)
    return probability >= 0.6
  })
}
