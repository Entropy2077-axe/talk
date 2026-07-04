export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '')
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
}): Promise<string> {
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
      response_format: { type: 'json_object' },
      temperature: 1.1,
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
  return content
}
