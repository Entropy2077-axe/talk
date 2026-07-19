import { describe, expect, it } from 'vitest'
import type { Contact } from '../types'
import { parseGroupRawDraft, serializeGroupTurn } from './groupChat'

const speakers = [
  { id: 'a', name: '林夏' },
  { id: 'b', name: '周野' },
] as Contact[]

describe('group chat local draft parser', () => {
  it('parses a compliant multi-speaker turn without utility conversion', () => {
    const raw = [
      '<林夏>（这回答也太敷衍了，我想先吐槽一句）[😈]“你这不是说了等于没说吗”',
      '<周野>（她吐槽得正好，我顺手补一刀）[😀]“至少态度很诚恳。”',
    ].join('\n')

    const parsed = parseGroupRawDraft(raw, speakers)

    expect(parsed.valid).toBe(true)
    expect(parsed.needsUtility).toBe(false)
    expect(parsed.bubbles).toEqual([
      {
        speakerIndex: 1,
        speakerName: '林夏',
        type: 'text',
        content: '你这不是说了等于没说吗',
        thought: '这回答也太敷衍了，我想先吐槽一句',
        mood: '😈',
      },
      {
        speakerIndex: 2,
        speakerName: '周野',
        type: 'text',
        content: '至少态度很诚恳。',
        thought: '她吐槽得正好，我顺手补一刀',
        mood: '😀',
      },
    ])
    expect(JSON.parse(serializeGroupTurn(parsed)).messages).toHaveLength(2)
  })

  it('extracts sticker, image, and knowledge markers locally', () => {
    const raw = [
      '<林夏>（这个表情正合适）[😀]“[sticker:笑哭]”',
      '<周野>（发张图给他们看）[😊]“[image:orange cat sunlight:就这只]”',
      '<林夏>（这个词我确实不了解）[🤔]“[knowledge:新的网络梗]”',
    ].join('\n')

    const parsed = parseGroupRawDraft(raw, speakers, ['笑哭'])

    expect(parsed.valid).toBe(true)
    expect(parsed.bubbles.map((bubble) => bubble.type)).toEqual(['sticker', 'image'])
    expect(parsed.knowledgeQueries).toEqual(['新的网络梗'])
  })

  it('falls back for malformed drafts and keeps utility extraction for plans', () => {
    const malformed = parseGroupRawDraft('林夏：格式不对', speakers)
    const greeting = parseGroupRawDraft(
      '<林夏>（先正常打个招呼）[😊]“晚上好啊”',
      speakers,
    )
    const plan = parseGroupRawDraft(
      '<林夏>（这次可以定下来）[😊]“那我们明天晚上一起吃饭吧”',
      speakers,
    )

    expect(malformed.valid).toBe(false)
    expect(greeting.needsUtility).toBe(false)
    expect(plan.valid).toBe(true)
    expect(plan.needsUtility).toBe(true)
  })
})
