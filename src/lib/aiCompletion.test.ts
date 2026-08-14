import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatCompletion, chatCompletionProgress, separateSupplierThinking, traceableCompletionOutput } from './deepseek'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const base = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com/v1',
  provider: 'custom' as const,
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hello' }],
}

describe('structured chat completion result', () => {
  it('classifies HTTP success with an empty body separately and retries up to five times', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: 'thinking' } }], usage: { completion_tokens_details: { reasoning_tokens: 20 } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await chatCompletion(base)

    expect(result.status).toBe('empty')
    expect(result.retried).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('does not retry when a caller requires exactly one request', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await chatCompletion({ ...base, singleRequest: true })

    expect(result.status).toBe('empty')
    expect(result.retried).not.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps finish reason, reasoning and token diagnostics', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: 'visible', reasoning_content: 'hidden' } }],
      usage: { prompt_tokens: 10, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 18 } },
    }), { status: 200 })))

    const result = await chatCompletion(base)

    expect(result.status).toBe('length')
    expect(result.content).toBe('visible')
    expect(result.reasoning).toBe('hidden')
    expect(result.usage?.reasoningTokens).toBe(18)
  })

  it('preserves native tool calls even when assistant content is empty', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.tool_choice).toBe('required')
      expect(body.tools[0].function.name).toBe('send_text')
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'send_text', arguments: '{"content":"你好"}' } }] } }],
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await chatCompletion({
      ...base,
      tools: [{ type: 'function', function: { name: 'send_text', description: 'send', parameters: { type: 'object' } } }],
      toolChoice: 'required',
    })

    expect(result.status).toBe('ok')
    expect(result.toolCalls?.[0]).toMatchObject({ id: 'call-1', function: { name: 'send_text' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('streams incremental native tool arguments for live generation previews', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"submit_contact_draft","arguments":"{\\"name\\":\\"林"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"澄\\"}"}}]},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const snapshots: string[] = []

    const result = await chatCompletionProgress({
      ...base,
      tools: [{ type: 'function', function: { name: 'submit_contact_draft', description: 'submit', parameters: { type: 'object' } } }],
      toolChoice: 'required',
      onProgress: (snapshot) => { snapshots.push(snapshot.toolCalls[0]?.function.arguments ?? '') },
    })

    expect(result.toolCalls?.[0].function.arguments).toBe('{"name":"林澄"}')
    expect(snapshots).toEqual(expect.arrayContaining(['{"name":"林', '{"name":"林澄"}']))
  })

  it('formats tool-only replies for the AI trace instead of treating them as empty output', () => {
    const output = traceableCompletionOutput('', [{
      id: 'call-1', type: 'function', function: { name: 'send_text', arguments: '{"content":"你好"}' },
    }])

    expect(output).toContain('tool_calls')
    expect(output).toContain('send_text')
    expect(output).toContain('你好')
  })

  it('retries without tool fields when a compatible relay rejects them', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'unsupported field: tools and tool_choice' } }), { status: 400 }))
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBeUndefined()
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '普通文本回退' } }] }), { status: 200 })
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await chatCompletion({
      ...base,
      tools: [{ type: 'function', function: { name: 'send_text', description: 'send', parameters: { type: 'object' } } }],
      toolChoice: 'required',
    })

    expect(result.content).toBe('普通文本回退')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('classifies safety blocking and malformed successful payloads', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    expect((await chatCompletion(base)).status).toBe('blocked')
    expect((await chatCompletion(base)).status).toBe('malformed')
  })

  it('separates MiniMax think tags without removing Talk thought tags', () => {
    expect(separateSupplierThinking('<think>secret</think>\nhello', 'minimax')).toEqual({ content: 'hello', reasoning: 'secret' })
    expect(separateSupplierThinking('<thought>角色自己的想法</thought>你好', 'gemini').content).toContain('<thought>')
    expect(separateSupplierThinking('<thought>supplier summary</thought>\n```json\n{"valid":true}\n```', 'gemini')).toEqual({
      content: '```json\n{"valid":true}\n```',
      reasoning: 'supplier summary',
    })
    expect(separateSupplierThinking('<thought>supplier summary</thought>\nvisible reply', 'gemini')).toEqual({
      content: 'visible reply',
      reasoning: 'supplier summary',
    })
  })
})
