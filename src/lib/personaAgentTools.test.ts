import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../types'
import type { ChatToolCall } from './deepseek'

const completionMock = vi.hoisted(() => vi.fn())

vi.mock('./deepseek', async (importOriginal) => {
  const original = await importOriginal<typeof import('./deepseek')>()
  return { ...original, chatCompletionProgress: completionMock }
})

import { generatePersonaWithTools, personaGenerationTools } from './personaAgentTools'

const call = (name: string, args: Record<string, unknown>, id = name): ChatToolCall => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
})

const draft = {
  name: '林澄', realName: '林澄', nickname: '阿澄', birthday: '2002-06-15', gender: '女', ageRange: '24岁',
  relationship: '朋友', occupation: '设计师', persona: '慢热但真诚，观察细致，有稳定的生活习惯，会用具体行动表达关心，也尊重彼此的边界。',
  visualIdentity: 'young woman, oval face, warm brown eyes, shoulder-length black hair, slim build',
  speechExamples: Array.from({ length: 10 }, (_, index) => `[场景${index + 1}] 示例消息${index + 1}`),
  personaProfile: { facts: ['设计师'], boundaries: ['尊重隐私'], habits: ['早起'], behaviorAnchors: ['先观察再回应'] },
  initialMemories: [], monthlySalary: 8000, avatarKeyword: 'young asian woman portrait', schedule: [],
}

const settings = {
  apiKey: 'test-key', baseUrl: 'https://example.test/v1', model: 'test-model', utilityModel: 'test-model', aiProvider: 'deepseek',
} as AppSettings

afterEach(() => {
  completionMock.mockReset()
})

describe('persona generation native tools', () => {
  it('exposes read-only queries and one structured final submission tool', () => {
    const tools = personaGenerationTools({ provider: 'test-tts', options: [{ id: 'voice-a', name: 'A', gender: '女', language: '中文' }] })
    expect(tools.map((item) => item.function.name)).toEqual([
      'search_worldbook', 'inspect_existing_contacts', 'get_shared_canon', 'list_available_locations', 'list_voice_options', 'submit_contact_draft',
    ])
    const submit = tools.at(-1)!
    const properties = submit.function.parameters.properties as Record<string, Record<string, unknown>>
    expect(properties.speechVoiceId.enum).toEqual(['voice-a'])
    expect(properties.speechExamples.minItems).toBe(10)
    expect(properties.speechExamples.maxItems).toBe(10)
    expect(submit.function.parameters.required).toContain('speechExamples')
    expect((properties.schedule.items as Record<string, unknown>).type).toBe('object')
  })

  it('executes a bounded query round and then accepts the structured draft', async () => {
    completionMock
      .mockResolvedValueOnce({ status: 'ok', content: '', toolCalls: [call('list_voice_options', {}, 'query-1')] })
      .mockResolvedValueOnce({ status: 'ok', content: '', toolCalls: [call('submit_contact_draft', { ...draft, speechVoiceId: 'voice-a', speechStyleInstruction: '语速平稳' }, 'submit-1')] })

    const result = await generatePersonaWithTools({
      settings, systemPrompt: '生成人物', taskId: 'task-1',
      voiceContext: { provider: 'test-tts', options: [{ id: 'voice-a', name: 'A', gender: '女', language: '中文' }] },
    })

    expect(result.usedNativeTools).toBe(true)
    expect(result.draft?.name).toBe('林澄')
    expect(result.draft?.speechExamples).toHaveLength(10)
    const secondMessages = completionMock.mock.calls[1][0].messages
    expect(secondMessages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'query-1' })
  })

  it('returns plain JSON content for providers that fall back without tool calls', async () => {
    completionMock.mockResolvedValueOnce({ status: 'ok', content: JSON.stringify(draft), toolCalls: [] })
    const result = await generatePersonaWithTools({ settings, systemPrompt: '生成人物', taskId: 'task-2' })
    expect(result.usedNativeTools).toBe(false)
    expect(result.draft).toBeNull()
    expect(JSON.parse(result.raw).name).toBe('林澄')
  })
})
