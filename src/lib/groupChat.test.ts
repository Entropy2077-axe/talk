import { describe, expect, it } from 'vitest'
import type { Contact } from '../types'
import { buildGroupRawChatPrompt, buildGroupSystemPrompt, parseGroupRawDraft, serializeGroupTurn } from './groupChat'

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

    const parsed = parseGroupRawDraft(raw, speakers, [], true)

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

  it('preserves arbitrary interleaving between text, image, sticker, and later text', () => {
    const raw = [
      '<林夏>（先接住话题）[😊]“我先给你看个东西”',
      '<林夏>（图片放在这里最自然）[😊]“[image:orange cat under neon rain, cinematic lighting:就是它]”',
      '<周野>（接着评价图片）[😀]“这个光影确实不错”',
      '<林夏>（用反应表情接一句）[😈]“[sticker:excited cat reaction]”',
      '<周野>（继续把话题往前推）[🤔]“不过暖色会更耐看吧”',
    ].join('\n')

    const parsed = parseGroupRawDraft(raw, speakers, [], true)

    expect(parsed.valid).toBe(true)
    expect(parsed.bubbles.map((bubble) => bubble.type)).toEqual(['text', 'image', 'text', 'sticker', 'text'])
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

describe('group chat persona prompt anchors', () => {
  it('includes each speaker shared history and visible first-turn adherence rules', () => {
    const lover = { id: 'lover', name: '小满', systemPrompt: '嘴硬但很在乎用户', relationshipBase: '恋人', personalityTrait: '雌小鬼', sharedHistory: '大学社团认识，曾陪用户熬夜备考。' } as Contact
    const friend = { id: 'friend', name: '阿野', systemPrompt: '直率的朋友', relationshipBase: '朋友' } as Contact
    const common = {
      stylePrompt: '自然短句',
      groupName: '周末群',
      allMembers: [lover, friend],
      speakers: [lover, friend],
      stickerNames: [],
      currentTimeText: '周六上午',
      userProfileText: '昵称：我',
    }
    const systemPrompt = buildGroupSystemPrompt(common)
    const rawPrompt = buildGroupRawChatPrompt(common)
    for (const prompt of [systemPrompt, rawPrompt]) {
      expect(prompt).toContain('大学社团认识')
      expect(prompt).toContain('首轮')
      expect(prompt).toContain('恋人')
      expect(prompt).toContain('雌小鬼')
    }
  })
})
