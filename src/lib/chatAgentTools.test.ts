import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateGroupAgentTurn, generatePrivateAgentTurn, parseGroupToolCalls, parsePrivateToolCalls, privateChatTools } from './chatAgentTools'
import type { ChatToolCall } from './deepseek'

const call = (name: string, args: Record<string, unknown>, id = name): ChatToolCall => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
})

const turnCall = (events: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}, id = 'turn') => call('submit_turn', {
  events, thought: '想自然地回应对方', mood: '期待', ...extra,
}, id)

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

  it('turns a contact recommendation tool call into a structured card', () => {
    const parsed = parsePrivateToolCalls([call('recommend_contact', {
      candidateName: '林晚', relationToRecommender: '大学室友', recommendationReason: '你们都喜欢街头摄影',
      shortDescription: '她是个做事很细致的摄影师。', gender: '女', ageRange: '25岁', occupation: '摄影师',
      hobbies: ['摄影', '徒步'], personalityClues: ['慢热', '细心'], thought: '他们应该聊得来', mood: '期待',
    })])
    expect(parsed.bubbles).toEqual([expect.objectContaining({
      type: 'link', app: 'contact_recommendation', label: '林晚',
      data: expect.objectContaining({ relationToRecommender: '大学室友', status: 'pending' }),
    })])
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

  it('submits text and a schedule through one forced native turn call', async () => {
    const response = turnCall([
      { type: 'text', content: '好呀，明天下午两点咖啡馆见。' },
      { type: 'schedule', date: '2026-08-12', startHour: 14, endHour: 16, locationId: 'cafe-1', activity: '见面', phoneAccess: 'available', summary: '下午见面' },
    ])
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['submit_turn'])
      expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'submit_turn' } })
      return completion([response])
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generatePrivateAgentTurn(agentOptions)

    expect(result.parsed.bubbles.map((bubble) => bubble.type)).toEqual(['text', 'scheduleChange'])
    expect(result.parsed.bubbles.filter((bubble) => bubble.type === 'scheduleChange')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps multiple natural text bubbles around an action in one request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => completion([turnCall([
      { type: 'text', content: '拿着。' },
      { type: 'transfer', amount: 20, note: '买杯咖啡' },
      { type: 'text', content: '下次换你请我。' },
    ])])))

    const result = await generatePrivateAgentTurn(agentOptions)

    expect(result.parsed.bubbles.map((bubble) => bubble.type)).toEqual(['text', 'transfer', 'text'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('submits a recommendation card with natural introduction text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => completion([turnCall([
      { type: 'text', content: '我想到一个也许和你聊得来的人。' },
      { type: 'contact_recommendation', candidateName: '林晚', relationToRecommender: '大学室友', recommendationReason: '你们都喜欢摄影', shortDescription: '她是摄影师，性格慢热但很细心。', gender: '女', ageRange: '25岁', occupation: '摄影师', hobbies: ['摄影'], personalityClues: ['慢热'] },
    ])])))
    const result = await generatePrivateAgentTurn(agentOptions)
    expect(result.parsed.bubbles.map((bubble) => bubble.type)).toEqual(['text', 'link'])
    expect(result.parsed.bubbles[1]).toMatchObject({ app: 'contact_recommendation', label: '林晚' })
  })

  it('retries an invalid action-only turn as a complete turn instead of requesting one fixed text', async () => {
    const invalid = turnCall([{ type: 'transfer', amount: 20, note: '买杯咖啡' }], {}, 'invalid-turn')
    const repaired = turnCall([
      { type: 'text', content: '这杯我请你。' },
      { type: 'transfer', amount: 20, note: '买杯咖啡' },
    ], {}, 'repaired-turn')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion([invalid]))
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        expect(body.messages.at(-1).content).toContain('一次性重新提交完整 submit_turn')
        return completion([repaired])
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generatePrivateAgentTurn(agentOptions)

    expect(result.parsed.bubbles.map((bubble) => bubble.type)).toEqual(['text', 'transfer'])
    expect(result.parsed.bubbles.filter((bubble) => bubble.type === 'transfer')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('supports multiple text bubbles around images in one native call', async () => {
    const response = turnCall([
      { type: 'text', content: '等一下，我找个光线好点的地方。' },
      { type: 'image', query: 'a casual selfie in warm window light', kind: 'selfie', participants: ['self'] },
      { type: 'text', content: '不许笑我。' },
    ])
    const fetchMock = vi.fn().mockResolvedValueOnce(completion([response]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generatePrivateAgentTurn(agentOptions)

    expect(result.parsed.bubbles).toEqual([
      { type: 'text', content: '等一下，我找个光线好点的地方。' },
      { type: 'image', query: 'a casual selfie in warm window light', kind: 'selfie', participants: ['self'] },
      { type: 'text', content: '不许笑我。' },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('submits an immediate activity and natural text in one native call', async () => {
    const response = turnCall([
      { type: 'text', content: '好，我现在去厨房做饭。' },
      { type: 'activity_now', locationId: 'cafe-1', activity: '做饭', durationMinutes: 60, phoneAccess: 'available' },
    ])
    const fetchMock = vi.fn().mockResolvedValueOnce(completion([response]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generatePrivateAgentTurn(agentOptions)

    expect(result.parsed.bubbles).toEqual([{ type: 'text', content: '好，我现在去厨房做饭。' }])
    expect(result.parsed.immediateActivities).toEqual([{ locationId: 'cafe-1', activity: '做饭', durationMinutes: 60, phoneAccess: 'available' }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
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

    const result = await generateGroupAgentTurn({ ...agentOptions, speakerNames: ['小林', '阿青'], memberNames: ['小林', '阿青'], messageBounds: { min: 1, max: 4 } })

    expect(result.parsed.bubbles.map((bubble) => [bubble.speakerIndex, bubble.type])).toEqual([[2, 'text'], [2, 'scheduleChange']])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('adds image text from the same group speaker', async () => {
    const image = call('send_image', { speakerIndex: 2, query: 'a plate of fresh pasta', kind: 'object', participantIndexes: [], includeUser: false, thought: '想分享晚饭', mood: '开心' }, 'group-image')
    const reply = call('send_text', { speakerIndex: 2, content: '刚做好的，给你们看看。', thought: '想听听大家评价', mood: '开心' }, 'group-image-text')
    const fetchMock = vi.fn().mockResolvedValueOnce(completion([image])).mockResolvedValueOnce(completion([reply]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateGroupAgentTurn({ ...agentOptions, speakerNames: ['小林', '阿青'], memberNames: ['小林', '阿青'], messageBounds: { min: 1, max: 4 } })

    expect(result.parsed.bubbles.map((bubble) => [bubble.speakerIndex, bubble.type])).toEqual([[2, 'text'], [2, 'image']])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
