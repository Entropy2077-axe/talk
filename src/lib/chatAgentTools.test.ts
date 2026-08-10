import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateGroupAgentTurn, generatePrivateAgentTurn, parseGroupToolCalls, parsePrivateToolCalls, privateChatTools } from './chatAgentTools'
import type { ChatToolCall } from './deepseek'

const call = (name: string, args: Record<string, unknown>, id = name): ChatToolCall => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
})

const agentOptions = {
  apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', model: 'test-model', utilityModel: 'test-model',
  messages: [{ role: 'user' as const, content: '我们明天下午去咖啡馆吧' }], purpose: 'chat' as const,
  trace: { turnId: 'turn-1', stage: 'original_generation' as const, conversationId: 'conversation-1' },
  stickerNames: [], stickerSearchEnabled: false, imageEnabled: true, knowledgeEnabled: false,
  scheduleEnabled: true, locationIds: ['cafe-1'],
}

const completion = (calls: ChatToolCall[]) => new Response(JSON.stringify({
  choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: calls } }],
}), { status: 200 })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('native chat agent tools', () => {
  it('keeps ordered bubbles plus textual mood and private thought', () => {
    const parsed = parsePrivateToolCalls([
      call('send_text', { content: '那就这么定啦', thought: '我很期待见面', mood: '期待' }),
      call('send_sticker', { name: 'happy cat', thought: '想让气氛轻松一点', mood: '开心' }),
    ])
    expect(parsed.bubbles).toEqual([
      { type: 'text', content: '那就这么定啦' },
      { type: 'sticker', name: 'happy cat' },
    ])
    expect(parsed.thought).toBe('我很期待见面；想让气氛轻松一点')
    expect(parsed.mood).toBe('开心')
  })

  it('maps legacy emoji moods to readable text', () => {
    expect(parsePrivateToolCalls([call('send_text', { content: '好呀', thought: '答应他', mood: '😊' })]).mood).toBe('开心')
  })

  it('accepts a complete schedule with locationId and rejects incomplete calls', () => {
    const parsed = parsePrivateToolCalls([
      call('create_schedule', { date: '2026-08-12', startHour: 14, endHour: 16, locationId: 'cafe-1', activity: '见面', phoneAccess: 'available', summary: '下午见面', thought: '愿意赴约', mood: '期待' }),
      call('create_schedule', { date: '2026-08-12', startHour: 14 }),
    ])
    expect(parsed.bubbles).toHaveLength(1)
    expect(parsed.bubbles[0]).toMatchObject({ type: 'scheduleChange', location: 'cafe-1', locationId: 'cafe-1' })
  })

  it('only exposes tools that are currently available', () => {
    const names = privateChatTools({ stickerNames: [], stickerSearchEnabled: false, imageEnabled: false, knowledgeEnabled: false, scheduleEnabled: false, locationIds: [] }).map((tool) => tool.function.name)
    expect(names).not.toContain('send_sticker')
    expect(names).not.toContain('send_image')
    expect(names).not.toContain('search_knowledge')
    expect(names).not.toContain('create_schedule')
  })

  it('keeps group speaker identity and textual per-message mood', () => {
    const parsed = parseGroupToolCalls([call('send_text', { speakerIndex: 2, content: '我也去', thought: '不想错过', mood: '兴奋' })], 3)
    expect(parsed.bubbles).toEqual([{ speakerIndex: 2, type: 'text', content: '我也去', thought: '不想错过', mood: '兴奋' }])
  })

  it('adds a natural text bubble before an action-only schedule without duplicating the action', async () => {
    const schedule = call('create_schedule', { date: '2026-08-12', startHour: 14, endHour: 16, locationId: 'cafe-1', activity: '见面', phoneAccess: 'available', summary: '下午见面', thought: '愿意赴约', mood: '期待' }, 'schedule-1')
    const reply = call('send_text', { content: '好呀，明天下午两点咖啡馆见。', thought: '我很期待', mood: '期待' }, 'text-1')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion([schedule]))
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['send_text'])
        expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'send_text' } })
        expect(body.messages.at(-1).content).toContain('不要重复调用')
        return completion([reply])
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generatePrivateAgentTurn(agentOptions)

    expect(result.parsed.bubbles.map((bubble) => bubble.type)).toEqual(['text', 'scheduleChange'])
    expect(result.parsed.bubbles.filter((bubble) => bubble.type === 'scheduleChange')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not add a second request when text and action were already returned together', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => completion([
      call('send_text', { content: '那就这么定啦。', thought: '已经决定了', mood: '期待' }),
      call('transfer_money', { amount: 20, note: '买杯咖啡', thought: '想请客', mood: '开心' }),
    ])))

    const result = await generatePrivateAgentTurn(agentOptions)

    expect(result.parsed.bubbles.map((bubble) => bubble.type)).toEqual(['text', 'transfer'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('also adds text to an action-only finance tool call', async () => {
    const transfer = call('transfer_money', { amount: 20, note: '买杯咖啡', thought: '想请客', mood: '开心' }, 'transfer-1')
    const reply = call('send_text', { content: '这杯我请你。', thought: '想让对方开心', mood: '开心' }, 'transfer-text')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion([transfer]))
      .mockResolvedValueOnce(completion([reply]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generatePrivateAgentTurn(agentOptions)

    expect(result.parsed.bubbles.map((bubble) => bubble.type)).toEqual(['text', 'transfer'])
    expect(result.parsed.bubbles.filter((bubble) => bubble.type === 'transfer')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps image-only replies on the existing image plus caption path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => completion([call('send_image', {
      query: 'a warm cafe interior', caption: '就是这家～', kind: 'scene', participants: [], thought: '想给对方看看', mood: '开心',
    })])))

    const result = await generatePrivateAgentTurn(agentOptions)

    expect(result.parsed.bubbles).toEqual([{ type: 'image', query: 'a warm cafe interior', caption: '就是这家～', kind: 'scene', participants: [] }])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('adds group schedule text from the same speaker and creates one card', async () => {
    const schedule = call('create_schedule', { speakerIndex: 2, date: '2026-08-12', startHour: 14, endHour: 16, locationId: 'cafe-1', activity: '见面', phoneAccess: 'available', summary: '下午见面', thought: '愿意赴约', mood: '期待' }, 'group-schedule')
    const reply = call('send_text', { speakerIndex: 2, content: '我来定吧，下午两点见。', thought: '想把时间定下来', mood: '期待' }, 'group-text')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion([schedule]))
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        expect(body.messages.at(-1).content).toContain('speakerIndex 必须为 2')
        return completion([reply])
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateGroupAgentTurn({ ...agentOptions, speakerNames: ['小林', '阿青'], memberNames: ['小林', '阿青'] })

    expect(result.parsed.bubbles.map((bubble) => [bubble.speakerIndex, bubble.type])).toEqual([[2, 'text'], [2, 'scheduleChange']])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
