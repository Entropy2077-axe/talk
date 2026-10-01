import { afterEach, describe, expect, it, vi } from 'vitest'
import { decidePrivateTurnActions } from './chatAgentTools'
import { chooseJevActions, JEV_DECISIONS_URL } from './jevActions'

const options = {
  apiKey: 'chat-test', baseUrl: 'https://example.test/v1', model: 'chat', utilityModel: 'utility',
  actionDecisionProvider: 'jev' as const, actionDecisionApiKey: 'jev-test',
  messages: [{ role: 'user' as const, content: '下周再讨论换衣服' }], purpose: 'chat' as const,
  trace: { turnId: 'turn-1', stage: 'tool_call' as const, conversationId: 'conversation-1' },
  stickerNames: [], stickerSearchEnabled: false, imageEnabled: false, knowledgeEnabled: false,
  scheduleEnabled: false, locationIds: [],
}

afterEach(() => vi.unstubAllGlobals())

describe('OpenRouter Jev action selection', () => {
  it('uses the Decisions API and skips the action LLM when no action is selected', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ answers: Object.fromEntries(
      ['outfit_change', 'contact_recommendation', 'transfer', 'red_packet', 'loan_request', 'loan_decision', 'gift_purchase'].map((name) => [name, { type: 'noul', noul: 0.03 }]),
    ) }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await decidePrivateTurnActions(options)
    expect(result.decided).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(JEV_DECISIONS_URL)
  })

  it('rejects incomplete answers instead of treating them as no action', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })))
    await expect(chooseJevActions({ apiKey: 'test', messages: options.messages, allowed: ['image'] })).rejects.toThrow('image')
  })

  it('judges the character\'s actual reply before deciding whether a location action is needed', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { state: { candidate_reply: string }; questions: { activity_now: { instructions: string } } }
      expect(request.state.candidate_reply).toContain('地址发我')
      expect(request.questions.activity_now.instructions).toContain('candidate_reply')
      return new Response(JSON.stringify({ answers: { activity_now: { type: 'noul', noul: 0.07 } } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const selected = await chooseJevActions({
      apiKey: 'test', messages: [{ role: 'user', content: '可以来我家卧室一下吗' }],
      candidateReply: '地址发我，我下播收拾一下就过去。', allowed: ['activity_now'],
    })
    expect(selected).toEqual([])
  })

  it('only accepts a complete action of the selected type', async () => {
    const answers = Object.fromEntries(
      ['outfit_change', 'contact_recommendation', 'transfer', 'red_packet', 'loan_request', 'loan_decision', 'gift_purchase'].map((name) => [name, { type: 'noul', noul: name === 'transfer' ? 0.93 : 0.02 }]),
    )
    const invalidAction = { decided: true, reason: '转账', thought: '想转账', mood: '开心', knowledgeQueries: [], events: [{ type: 'red_packet', amount: 8, blessing: '开心' }] }
    const validAction = { ...invalidAction, events: [{ type: 'transfer', amount: 8, note: '给你' }] }
    const completion = (args: object) => new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'action', type: 'function', function: { name: 'decide_turn_actions', arguments: JSON.stringify(args) } }] } }] }), { status: 200 })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers }), { status: 200 }))
      .mockResolvedValueOnce(completion(invalidAction))
      .mockResolvedValueOnce(completion(validAction))
    vi.stubGlobal('fetch', fetchMock)
    const result = await decidePrivateTurnActions(options)
    expect(result.decided).toBe(true)
    expect(result.parsed.bubbles).toEqual([{ type: 'transfer', amount: 8, note: '给你' }])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('turns an accepted immediate visit into a validated location action', async () => {
    const names = ['schedule', 'activity_now', 'outfit_change', 'contact_recommendation', 'transfer', 'red_packet', 'loan_request', 'loan_decision', 'gift_purchase']
    const answers = Object.fromEntries(names.map((name) => [name, { type: 'noul', noul: name === 'activity_now' ? 0.9 : 0.02 }]))
    const params = { decided: true, reason: '立即去客厅', thought: '想去见他', mood: '期待', knowledgeQueries: [], events: [{ type: 'activity_now', locationId: 'home-living', activity: '拜访', durationMinutes: 30, phoneAccess: 'available' }] }
    const actionResponse = new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'visit', type: 'function', function: { name: 'decide_turn_actions', arguments: JSON.stringify(params) } }] } }] }), { status: 200 })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers }), { status: 200 }))
      .mockResolvedValueOnce(actionResponse))
    const result = await decidePrivateTurnActions({ ...options, scheduleEnabled: true, locationIds: ['home-living'], candidateReply: '我现在就来你家客厅。' })
    expect(result.decided).toBe(true)
    expect(result.parsed.immediateActivities).toEqual([{ locationId: 'home-living', activity: '拜访', durationMinutes: 30, phoneAccess: 'available' }])
  })
})
