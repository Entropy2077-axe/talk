import { describe, expect, it } from 'vitest'
import { parseAiResponse, parseRawPrivateDraft, rawPrivateDraftNeedsUtility } from './aiProtocol'
import { createDefaultImageProviders, createDefaultStickerProviders } from './mediaProviders'
import { buildJsonConversionPrompt, buildRawChatPrompt } from './prompt'
import { generateRemoteImage, searchRemoteStickers } from './remoteMedia'

const deepseekKey = import.meta.env.VITE_DEEPSEEK_API_KEY || ''
const deepseekBaseUrl = (import.meta.env.VITE_DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const giphyKey = import.meta.env.VITE_LIVE_GIPHY_API_KEY || ''
const atlasKey = import.meta.env.VITE_LIVE_ATLAS_API_KEY || ''
const runLive = import.meta.env.VITE_RUN_LIVE_MEDIA_TESTS === '1'
const runAiRecheck = import.meta.env.VITE_RUN_LIVE_AI_RECHECK === '1'

async function deepseekRequest(model: string, messages: Array<{ role: 'system' | 'user'; content: string }>, maxTokens: number, jsonMode = false) {
  const response = await fetch(`${deepseekBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deepseekKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      thinking: { type: 'disabled' },
      temperature: jsonMode ? 0.1 : 0.7,
      max_tokens: maxTokens,
    }),
  })
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}: ${payload.error?.message || 'unknown error'}`)
  return payload.choices?.[0]?.message?.content || ''
}

async function contactReply(userText: string) {
  const system = buildRawChatPrompt({
    name: '小满',
    persona: '你是用户熟悉的恋人。说话自然、短句，有自己的态度，但会在意用户。',
    stylePrompt: '像真人微信聊天，不要客服腔。',
    relationshipBase: '恋人',
    recentContext: '正在进行一段自然的日常聊天。',
    latestUserText: userText,
    stickerNames: [],
    remoteStickerSearchEnabled: true,
    imageGenerationEnabled: true,
  })
  const raw = await deepseekRequest('deepseek-v4-pro', [{ role: 'system', content: system }, { role: 'user', content: userText }], 500)
  const parsed = parseRawPrivateDraft(raw)
  return { raw, parsed, needsUtility: rawPrivateDraftNeedsUtility(raw, parsed) }
}

describe.runIf(runLive)('live AI media integration', () => {
  it('keeps production draft format and chooses media according to context', async () => {
    expect(deepseekKey, 'missing DeepSeek key').not.toBe('')
    const casual = await contactReply('我终于下班了，今天累死了')
    const requestedImage = await contactReply('给我画一张雨夜里橘猫坐在便利店窗边的图，再跟我说两句')
    const serious = await contactReply('我奶奶刚住院，我现在有点乱，不知道该怎么办')
    const turns = [casual, requestedImage, serious]
    const stickerTurns = turns.filter((turn) => turn.parsed.bubbles.some((bubble) => bubble.type === 'sticker')).length

    console.info(JSON.stringify({
      liveAi: turns.map((turn) => ({
        types: turn.parsed.bubbles.map((bubble) => bubble.type),
        needsUtility: turn.needsUtility,
        hasMood: !!turn.parsed.mood,
        hasThought: !!turn.parsed.thought,
      })),
      stickerTurns,
    }))

    for (const turn of turns) expect(turn.parsed.bubbles.length).toBeGreaterThan(0)
    expect(casual.parsed.bubbles.some((bubble) => bubble.type === 'sticker')).toBe(true)
    expect(requestedImage.parsed.bubbles.some((bubble) => bubble.type === 'image')).toBe(true)
    expect(serious.parsed.bubbles.some((bubble) => bubble.type === 'image')).toBe(false)
    expect(serious.parsed.bubbles.some((bubble) => bubble.type === 'sticker')).toBe(false)
  }, 90_000)

  it('searches GIPHY and generates one real Atlas image', async () => {
    expect(giphyKey, 'missing GIPHY key').not.toBe('')
    expect(atlasKey, 'missing Atlas key').not.toBe('')

    const stickerProviders = createDefaultStickerProviders()
    stickerProviders.giphy.apiKey = giphyKey
    const stickers = await searchRemoteStickers({ stickerProvider: 'giphy', stickerProviders }, 'tired reaction')
    expect(stickers.length).toBeGreaterThan(0)
    expect(stickers[0].url).toMatch(/^https:\/\//)

    const imageProviders = createDefaultImageProviders()
    imageProviders.atlas.apiKey = atlasKey
    const image = await generateRemoteImage(
      { imageProvider: 'atlas', imageProviders },
      'an orange cat sitting by a convenience store window on a rainy night, cinematic lighting, cozy atmosphere',
    )
    console.info(JSON.stringify({ liveMedia: { giphyResults: stickers.length, atlasGenerated: !!image?.url } }))
    expect(image?.url).toMatch(/^(https:\/\/|data:image\/)/)
  }, 180_000)
})

describe.runIf(runAiRecheck)('live production-format recheck', () => {
  it('produces a sticker in casual chat and a valid final structured turn', async () => {
    expect(deepseekKey, 'missing DeepSeek key').not.toBe('')
    const turn = await contactReply('忙完啦，今天总算可以躺一会儿了')
    let finalTurn = turn.parsed
    let usedUtility = false
    if (turn.needsUtility) {
      usedUtility = true
      const converted = await deepseekRequest(
        'deepseek-v4-flash',
        [{ role: 'system', content: buildJsonConversionPrompt(turn.raw) }],
        600,
        true,
      )
      finalTurn = parseAiResponse(converted)
    }
    console.info(JSON.stringify({
      liveRecheck: {
        rawTypes: turn.parsed.bubbles.map((bubble) => bubble.type),
        usedUtility,
        finalTypes: finalTurn.bubbles.map((bubble) => bubble.type),
        hasMood: !!finalTurn.mood,
        hasThought: !!finalTurn.thought,
      },
    }))
    expect(finalTurn.bubbles.length).toBeGreaterThan(0)
    expect(finalTurn.bubbles.some((bubble) => bubble.type === 'sticker')).toBe(true)
    expect(finalTurn.mood).toBeTruthy()
    expect(finalTurn.thought).toBeTruthy()
  }, 90_000)
})
