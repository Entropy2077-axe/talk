export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
import { assertAutomaticAiBudget, estimateTokens, recordAiUsage } from './aiUsage'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { AdminAiTraceStage, AiUsagePurpose } from '../types'
import { friendlyConnectionError, httpFailureMessage, parseJsonText, requireApiKey, requireHttpUrl } from './connectionError'

/**
 * Merges consecutive same-role messages into one. Each AI turn is stored as
 * several separate assistant bubbles in the db (one per sentence/sticker),
 * so naively mapping history 1:1 produces long runs of back-to-back
 * "assistant" messages with no interleaved "user" turn — most chat APIs
 * (and the underlying chat template) expect strict user/assistant
 * alternation, and violating it visibly degrades reply quality from the
 * second turn onward. Coalescing restores one message per real turn.
 */
export function coalesceConsecutiveRoles(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  for (const m of messages) {
    const last = result[result.length - 1]
    if (last && last.role === m.role) {
      last.content = `${last.content}\n${m.content}`
    } else {
      result.push({ ...m })
    }
  }
  return result
}

function normalizeBaseUrl(baseUrl: string) {
  return requireHttpUrl(baseUrl, 'Base URL')
}

function supportsThinkingOption(model: string): boolean {
  return /^deepseek-v4(?:-|$)/i.test(model)
}

async function traceAiCall(opts: { purpose: AiUsagePurpose; model: string; messages: ChatMessage[]; output?: string; error?: string; inputTokens: number; outputTokens: number; turnId?: string; stage?: AdminAiTraceStage; conversationId?: string }) {
  try {
    await db.adminAiTraces.add({ id: uuid(), ...opts, createdAt: Date.now() })
    const count = await db.adminAiTraces.count()
    if (count > 500) {
      const staleIds = await db.adminAiTraces.orderBy('createdAt').limit(count - 500).primaryKeys()
      if (staleIds.length) await db.adminAiTraces.bulkDelete(staleIds)
    }
  } catch {}
}

export async function listModels(apiKey: string, baseUrl: string): Promise<string[]> {
  try {
    const key = requireApiKey(apiKey, 'AI')
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    const text = await res.text()
    const json = parseJsonText(text, 'AI 接口') as { data?: unknown }
    if (!res.ok) throw new Error(httpFailureMessage('AI 接口', res.status, json))
    if (!Array.isArray(json?.data)) throw new Error('AI 接口返回的数据中没有模型列表，请检查 Base URL 是否兼容 OpenAI 接口')
    const list = json.data
      .flatMap((item) => item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' ? [(item as { id: string }).id] : [])
      .sort()
    if (list.length === 0) throw new Error('AI 接口连接成功，但没有返回可用模型')
    return list
  } catch (error) {
    throw new Error(friendlyConnectionError(error, 'AI 接口'))
  }
}

export async function testConnection(
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const key = requireApiKey(apiKey, 'AI')
    if (!model.trim()) throw new Error('请先填写或选择模型')
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '你好' }],
        max_tokens: 8,
      }),
    })
    const text = await res.text()
    const json = parseJsonText(text, 'AI 接口') as { choices?: unknown; error?: unknown }
    if (!res.ok) return { ok: false, message: httpFailureMessage('AI 接口', res.status, json) }
    const first = Array.isArray(json?.choices) ? json.choices[0] : undefined
    const message = first && typeof first === 'object' ? (first as { message?: unknown }).message : undefined
    if (!message || typeof message !== 'object') {
      return { ok: false, message: '接口虽然返回成功状态，但内容不是兼容的 AI 回复，请检查 Base URL 和模型' }
    }
    return { ok: true, message: '连接成功，模型已正常返回回复' }
  } catch (err) {
    return { ok: false, message: friendlyConnectionError(err, 'AI 接口') }
  }
}

export async function chatCompletion(opts: {
  apiKey: string
  baseUrl: string
  model: string
  messages: ChatMessage[]
  signal?: AbortSignal
  /**
   * Only safe for genuinely single-turn calls (persona generation, memory
   * summarization) that never carry accumulated assistant history. On the
   * main multi-turn chat call, forcing json_object mode was measured to
   * make the model emit pure-whitespace/blank completions from the 2nd
   * turn onward — see coalesceConsecutiveRoles's neighbor note and project
   * memory. Leave this off there and rely on prompt instructions instead.
   */
  jsonMode?: boolean
  purpose?: AiUsagePurpose
  automatic?: boolean
  maxTokens?: number
  temperature?: number
  thinking?: 'enabled' | 'disabled'
  trace?: { turnId: string; stage: AdminAiTraceStage; conversationId?: string }
}): Promise<string> {
  const purpose = opts.purpose ?? 'other'
  const automatic = opts.automatic ?? false
  if (automatic) await assertAutomaticAiBudget()
  const inputTokens = opts.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  try {
  const key = requireApiKey(opts.apiKey, 'AI')
  const res = await fetch(`${normalizeBaseUrl(opts.baseUrl)}/v1/chat/completions`, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(supportsThinkingOption(opts.model)
        ? { thinking: { type: opts.thinking ?? 'disabled' } }
        : {}),
      temperature: opts.temperature ?? 1.1,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    }),
  })
  const text = await res.text()
  const json = parseJsonText(text, 'AI 接口') as Record<string, any>
  if (!res.ok) throw new Error(httpFailureMessage('AI 接口', res.status, json))
  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('AI 接口没有返回有效回复，请检查模型名称是否正确')
  }
  const promptTokens = Number(json?.usage?.prompt_tokens)
  const completionTokens = Number(json?.usage?.completion_tokens)
  const usageWrite = recordAiUsage({ purpose, model: opts.model, automatic, success: true, inputTokens: Number.isFinite(promptTokens) ? promptTokens : inputTokens, outputTokens: Number.isFinite(completionTokens) ? completionTokens : estimateTokens(content), estimated: !Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) })
  if (automatic) await usageWrite
  else void usageWrite.catch(() => undefined)
  void traceAiCall({ purpose, model: opts.model, messages: opts.messages, output: content, inputTokens: Number.isFinite(promptTokens) ? promptTokens : inputTokens, outputTokens: Number.isFinite(completionTokens) ? completionTokens : estimateTokens(content), ...opts.trace })
  return content
  } catch (error) {
    const usageWrite = recordAiUsage({ purpose, model: opts.model, automatic, success: false, inputTokens, outputTokens: 0, estimated: true, error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) })
    if (automatic) await usageWrite
    else void usageWrite.catch(() => undefined)
    void traceAiCall({ purpose, model: opts.model, messages: opts.messages, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), inputTokens, outputTokens: 0, ...opts.trace })
    throw new Error(friendlyConnectionError(error, 'AI 接口'))
  }
}

export async function chatCompletionStream(opts: Omit<Parameters<typeof chatCompletion>[0], 'jsonMode'> & { onDelta: (text: string) => void }): Promise<string> {
  const purpose = opts.purpose ?? 'other'
  const inputTokens = opts.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  const key = requireApiKey(opts.apiKey, 'AI')
  const res = await fetch(`${normalizeBaseUrl(opts.baseUrl)}/v1/chat/completions`, { method: 'POST', signal: opts.signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: true, temperature: 1.1, ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}) }) })
  if (!res.ok || !res.body) {
    const text = await res.text()
    let payload: unknown = text
    try { payload = parseJsonText(text, 'AI 接口') } catch {}
    throw new Error(httpFailureMessage('AI 接口', res.status, payload))
  }
  const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let output = ''
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim(); if (!data || data === '[DONE]') continue
      try { const delta = JSON.parse(data)?.choices?.[0]?.delta?.content; if (typeof delta === 'string') { output += delta; opts.onDelta(delta) } } catch {}
    }
  }
  await recordAiUsage({ purpose, model: opts.model, automatic: opts.automatic ?? false, success: true, inputTokens, outputTokens: estimateTokens(output), estimated: true })
  await traceAiCall({ purpose, model: opts.model, messages: opts.messages, output, inputTokens, outputTokens: estimateTokens(output), ...opts.trace })
  return output
}
