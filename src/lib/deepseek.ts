export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
import { assertAutomaticAiBudget, estimateTokens, recordAiUsage } from './aiUsage'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { AiUsagePurpose } from '../types'

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
  return baseUrl.replace(/\/+$/, '')
}

async function traceAiCall(opts: { purpose: AiUsagePurpose; model: string; messages: ChatMessage[]; output?: string; error?: string; inputTokens: number; outputTokens: number }) {
  try {
    await db.adminAiTraces.add({ id: uuid(), ...opts, createdAt: Date.now() })
    const overflow = (await db.adminAiTraces.orderBy('createdAt').toArray()).slice(0, -500)
    if (overflow.length) await db.adminAiTraces.bulkDelete(overflow.map((item) => item.id))
  } catch {}
}

export async function listModels(apiKey: string, baseUrl: string): Promise<string[]> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    throw new Error(`拉取模型失败: HTTP ${res.status}`)
  }
  const json = await res.json()
  const list = (json?.data ?? []) as { id: string }[]
  return list.map((m) => m.id).sort()
}

export async function testConnection(
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '你好' }],
        max_tokens: 8,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      return { ok: false, message: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    }
    return { ok: true, message: '连接成功' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
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
}): Promise<string> {
  const purpose = opts.purpose ?? 'other'
  const automatic = opts.automatic ?? false
  if (automatic) await assertAutomaticAiBudget()
  const inputTokens = opts.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  try {
  const res = await fetch(`${normalizeBaseUrl(opts.baseUrl)}/v1/chat/completions`, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      temperature: 1.1,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API请求失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  const json = await res.json()
  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('API返回内容为空或格式异常')
  }
  const promptTokens = Number(json?.usage?.prompt_tokens)
  const completionTokens = Number(json?.usage?.completion_tokens)
  await recordAiUsage({ purpose, model: opts.model, automatic, success: true, inputTokens: Number.isFinite(promptTokens) ? promptTokens : inputTokens, outputTokens: Number.isFinite(completionTokens) ? completionTokens : estimateTokens(content), estimated: !Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) })
  await traceAiCall({ purpose, model: opts.model, messages: opts.messages, output: content, inputTokens: Number.isFinite(promptTokens) ? promptTokens : inputTokens, outputTokens: Number.isFinite(completionTokens) ? completionTokens : estimateTokens(content) })
  return content
  } catch (error) {
  await recordAiUsage({ purpose, model: opts.model, automatic, success: false, inputTokens, outputTokens: 0, estimated: true, error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) })
    await traceAiCall({ purpose, model: opts.model, messages: opts.messages, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), inputTokens, outputTokens: 0 })
    throw error
  }
}

export async function chatCompletionStream(opts: Omit<Parameters<typeof chatCompletion>[0], 'jsonMode'> & { onDelta: (text: string) => void }): Promise<string> {
  const purpose = opts.purpose ?? 'other'
  const inputTokens = opts.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  const res = await fetch(`${normalizeBaseUrl(opts.baseUrl)}/v1/chat/completions`, { method: 'POST', signal: opts.signal, headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: true, temperature: 1.1, ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}) }) })
  if (!res.ok || !res.body) throw new Error(`API请求失败 HTTP ${res.status}`)
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
  await traceAiCall({ purpose, model: opts.model, messages: opts.messages, output, inputTokens, outputTokens: estimateTokens(output) })
  return output
}
