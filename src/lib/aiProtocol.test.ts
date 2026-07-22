import { describe, expect, it } from 'vitest'
import {
  parseRawPrivateDraft,
  rawPrivateDraftNeedsUtility,
  serializePrivateTurn,
} from './aiProtocol'

describe('private chat local draft parser', () => {
  it('parses compliant text without a utility-model round trip', () => {
    const raw = [
      '<thought>我想先接住他的玩笑</thought>你这答案也太标准了',
      '<thought>其实还想听个具体的</thought>所以到底想吃什么',
      '<mood>被逗笑了</mood>',
    ].join('\n')

    const parsed = parseRawPrivateDraft(raw)

    expect(parsed.bubbles).toEqual([
      { type: 'text', content: '你这答案也太标准了' },
      { type: 'text', content: '所以到底想吃什么' },
    ])
    expect(parsed.thought).toBe('我想先接住他的玩笑')
    expect(parsed.mood).toBe('😌')
    expect(rawPrivateDraftNeedsUtility(raw, parsed)).toBe(false)
    expect(JSON.parse(serializePrivateTurn(parsed)).messages).toHaveLength(2)
  })

  it('extracts explicit action markers locally', () => {
    const raw = [
      '<thought>给他发个红包正合适</thought>[redPacket:66:买杯奶茶]',
      '<thought>这个词我确实没听过</thought>[knowledge:新的网络梗]',
      '<thought>顺手发张照片</thought>[image:orange cat sunlight:你看这个]',
      '<mood>挺开心</mood>',
    ].join('\n')

    const parsed = parseRawPrivateDraft(raw)

    expect(parsed.bubbles).toEqual([
      { type: 'redPacket', amount: 66, note: '买杯奶茶' },
      { type: 'image', query: 'orange cat sunlight', caption: '你看这个' },
    ])
    expect(parsed.knowledgeQueries).toEqual(['新的网络梗'])
    expect(rawPrivateDraftNeedsUtility(raw, parsed)).toBe(false)
  })

  it('preserves arbitrary text, image, sticker, and text ordering', () => {
    const raw = [
      '<thought>先回应一句</thought>等我一下',
      '<thought>先把图发过去</thought>[image:orange cat by a rainy window, cinematic lighting:就是这种感觉]',
      '<thought>再补充一句</thought>窗外还得有一点霓虹',
      '<thought>最后用表情收尾</thought>[sticker:excited cat reaction]',
      '<thought>别让话题断掉</thought>你更喜欢暖色还是冷色',
      '<mood>很有兴致</mood>',
    ].join('\n')

    const parsed = parseRawPrivateDraft(raw)

    expect(parsed.bubbles.map((bubble) => bubble.type)).toEqual(['text', 'image', 'text', 'sticker', 'text'])
    expect(rawPrivateDraftNeedsUtility(raw, parsed)).toBe(false)
  })

  it('falls back when required metadata or a known-looking marker is malformed', () => {
    const missingMood = '<thought>先回一句</thought>好啊'
    const malformedMarker = [
      '<thought>这个格式不完整</thought>[image:missing-caption]',
      '<mood>疑惑</mood>',
    ].join('\n')

    const first = parseRawPrivateDraft(missingMood)
    const second = parseRawPrivateDraft(malformedMarker)

    expect(rawPrivateDraftNeedsUtility(missingMood, first)).toBe(true)
    expect(rawPrivateDraftNeedsUtility(malformedMarker, second)).toBe(true)
  })
})
