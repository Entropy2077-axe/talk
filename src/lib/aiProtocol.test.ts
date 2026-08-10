import { describe, expect, it } from 'vitest'
import {
  parseJsonLoose,
  parseStructuredAiResponse,
  looksLikeStructuredAiResponse,
  parseRawPrivateDraft,
  rawPrivateDraftNeedsUtility,
  serializePrivateTurn,
} from './aiProtocol'

describe('parseJsonLoose', () => {
  it('parses plain JSON and fenced JSON', () => {
    expect(parseJsonLoose<{ ok: boolean }>('{"ok":true}')).toEqual({ ok: true })
    expect(parseJsonLoose<{ ok: boolean }>('```json\n{"ok":true}\n```')).toEqual({ ok: true })
  })

  it('extracts the first balanced object from surrounding model prose', () => {
    const raw = '处理完成： {"outer":{"text":"brace } inside string"},"items":[1,2]} 谢谢'
    expect(parseJsonLoose(raw)).toEqual({ outer: { text: 'brace } inside string' }, items: [1, 2] })
  })

  it('returns null for empty, incomplete, and invalid JSON', () => {
    expect(parseJsonLoose('')).toBeNull()
    expect(parseJsonLoose('{"ok":true')).toBeNull()
    expect(parseJsonLoose('not json at all')).toBeNull()
  })
})

describe('structured chat reply detection', () => {
  it('accepts a final messages payload without falling back to its JSON lines', () => {
    const raw = '```json\n{"messages":[{"type":"text","content":"已经收到啦"}],"mood":"开心","thought":"想自然回应"}\n```'

    expect(looksLikeStructuredAiResponse(raw)).toBe(true)
    expect(parseStructuredAiResponse(raw)).toMatchObject({
      bubbles: [{ type: 'text', content: '已经收到啦' }],
      thought: '想自然回应',
    })
  })

  it('recognizes a valid payload even when a compatible service prepends prose', () => {
    const raw = '按要求返回如下：\n{"messages":[{"type":"text","content":"好呀"}]}'
    expect(looksLikeStructuredAiResponse(raw)).toBe(true)
    expect(parseStructuredAiResponse(raw)?.bubbles).toEqual([{ type: 'text', content: '好呀' }])
  })

  it('does not mistake ordinary text containing the word messages for a protocol payload', () => {
    expect(looksLikeStructuredAiResponse('我刚看完 messages 里的内容')).toBe(false)
    expect(parseStructuredAiResponse('我刚看完 messages 里的内容')).toBeNull()
  })
})

describe('private chat local draft parser', () => {
  it('parses compliant text without a utility-model round trip', () => {
    const raw = [
      '（我想先接住他的玩笑）[😌]“你这答案也太标准了”',
      '（其实还想听个具体的）[😌]“所以到底想吃什么”',
    ].join('\n')

    const parsed = parseRawPrivateDraft(raw)

    expect(parsed.bubbles).toEqual([
      { type: 'text', content: '你这答案也太标准了' },
      { type: 'text', content: '所以到底想吃什么' },
    ])
    expect(parsed.thought).toBe('我想先接住他的玩笑')
    expect(parsed.mood).toBe('平静')
    expect(rawPrivateDraftNeedsUtility(raw, parsed)).toBe(false)
    expect(JSON.parse(serializePrivateTurn(parsed)).messages).toHaveLength(2)
  })

  it('extracts explicit action markers locally', () => {
    const raw = [
      '（给他发个红包正合适）[😊]“[redPacket:66:买杯奶茶]”',
      '（这个词我确实没听过）[🤔]“[knowledge:新的网络梗]”',
      '（顺手发张照片）[📷]“[image:orange cat sunlight:你看这个]”',
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
      '（先回应一句）[😊]“等我一下”',
      '（先把图发过去）[📷]“[image:orange cat by a rainy window, cinematic lighting:就是这种感觉]”',
      '（再补充一句）[😊]“窗外还得有一点霓虹”',
      '（最后用表情收尾）[😄]“[sticker:excited cat reaction]”',
      '（别让话题断掉）[🤔]“你更喜欢暖色还是冷色”',
    ].join('\n')

    const parsed = parseRawPrivateDraft(raw)

    expect(parsed.bubbles.map((bubble) => bubble.type)).toEqual(['text', 'image', 'text', 'sticker', 'text'])
    expect(rawPrivateDraftNeedsUtility(raw, parsed)).toBe(false)
  })

  it('falls back when required metadata or a known-looking marker is malformed', () => {
    const missingMood = '（先回一句）“好啊”'
    const malformedMarker = [
      '（这个格式不完整）[🤔]“[image:missing-caption]”',
    ].join('\n')

    const first = parseRawPrivateDraft(missingMood)
    const second = parseRawPrivateDraft(malformedMarker)

    expect(rawPrivateDraftNeedsUtility(missingMood, first)).toBe(true)
    expect(rawPrivateDraftNeedsUtility(malformedMarker, second)).toBe(true)
  })
})
