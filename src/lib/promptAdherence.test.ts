import { describe, expect, it } from 'vitest'
import { buildPersonaGenerationPrompt, buildRawChatPrompt } from './prompt'
import { createDefaultPromptModules, getPromptTemplate } from './promptModules'

describe('relationship and persona adherence prompts', () => {
  it('puts relationship, shared history, trait, and speech examples in the first-turn contract', () => {
    const prompt = buildRawChatPrompt({
      name: '小满',
      persona: '嘴硬但很在乎用户，喜欢用轻微挑衅掩饰关心。',
      stylePrompt: '自然聊天，短句。',
      relationshipBase: '恋人',
      personalityTrait: '雌小鬼',
      personalityWarmth: 80,
      recentContext: '刚开始聊天。',
      latestUserText: '早安',
      stickerNames: [],
      speechSamplesText: '- [亲近互动] 早啊，笨蛋，昨晚又熬夜了？',
      sharedHistory: '你们在大学社团认识，她曾陪用户熬夜准备考试。',
    })

    expect(prompt).toContain('与用户的共同过往')
    expect(prompt).toContain('第一句')
    expect(prompt).toContain('恋人')
    expect(prompt).toContain('雌小鬼')
    expect(prompt).toContain('说话样例')
    expect(prompt).toContain('只能使用给出的细节')
  })

  it('asks Nuwa draft generation to fill omitted identity fields consistently', () => {
    const prompt = buildPersonaGenerationPrompt({
      personalityTags: [],
      ageRange: '',
      gender: '',
      relationship: '',
      personalityTrait: '',
      hobbies: [],
      extra: '想要一个嘴硬但很在乎我的雌小鬼恋人。',
      sharedHistory: '我们小时候就认识。',
      draftMode: true,
    }, 'anime')

    expect(prompt).toContain('女娲初稿模式')
    expect(prompt).toContain('主动补全年龄、性别、关系定位、职业、兴趣、性格特质和身份资料')
    expect(prompt).toContain('我们小时候就认识')
    expect(prompt).toContain('relationship')
    expect(prompt).toContain('speechSamples')
  })

  it('teaches contacts to use remote sticker search and full image-generation prompts only when configured', () => {
    const enabled = buildRawChatPrompt({
      name: '小满',
      persona: '自然聊天。',
      stylePrompt: '短句。',
      recentContext: '正在聊天。',
      stickerNames: ['点头'],
      remoteStickerSearchEnabled: true,
      imageGenerationEnabled: true,
    })
    expect(enabled).toContain('[sticker:简短具体的搜索词]')
    expect(enabled).toContain('表情使用硬偏好')
    expect(enabled).toContain('原则上必须自然插入1个表情')
    expect(enabled).toContain('大多数常规轮次会发')
    expect(enabled).toContain('严肃安慰')
    expect(enabled).toContain('完整、自包含的英文生图提示词')
    expect(enabled).toContain('用户明确要求画图/发图/看图')
    expect(enabled).toContain('任意穿插')

    const disabled = buildRawChatPrompt({
      name: '小满',
      persona: '自然聊天。',
      stylePrompt: '短句。',
      recentContext: '正在聊天。',
      stickerNames: [],
    })
    expect(disabled).toContain('当前没有可用图片服务')
    expect(disabled).not.toContain('[sticker:简短具体的搜索词]')
  })

  it('uses editable global module prompts and completely omits blocked module payloads', () => {
    const promptModules = createDefaultPromptModules()
    promptModules.relationship.templates.chat = 'RELATIONSHIP_CUSTOM_SENTINEL\n{{relationshipContext}}'
    promptModules.memory.enabled = false
    const prompt = buildRawChatPrompt({
      name: '小满',
      persona: '自然聊天。',
      stylePrompt: '旧风格',
      promptModules,
      recentContext: '',
      relationshipContext: 'RELATIONSHIP_DYNAMIC_PAYLOAD',
      memoryContext: 'MEMORY_PRIVATE_PAYLOAD',
      sharedHistory: 'MEMORY_SHARED_PAYLOAD',
      stickerNames: [],
    })

    expect(prompt).toContain('RELATIONSHIP_CUSTOM_SENTINEL')
    expect(prompt).toContain('RELATIONSHIP_DYNAMIC_PAYLOAD')
    expect(prompt).not.toContain('MEMORY_PRIVATE_PAYLOAD')
    expect(prompt).not.toContain('MEMORY_SHARED_PAYLOAD')
  })

  it('treats worldbook entries as canonical constraints instead of flavor text', () => {
    const promptModules = createDefaultPromptModules()
    const prompt = buildRawChatPrompt({
      name: '小满',
      persona: '普通人。',
      stylePrompt: '短句。',
      promptModules,
      recentContext: '',
      worldviewText: '夜晚禁止使用魔法。',
      stickerNames: [],
    })
    expect(prompt).toContain('世界书 — 正史硬约束')
    expect(prompt).toContain('不是可选背景')
    expect(prompt).toContain('每一轮先检索并逐条判断')
    expect(prompt).toContain('必须改成符合条目的行为')
    expect(prompt).toContain('夜晚禁止使用魔法')
  })

  it('keeps the strengthened worldbook contract visible across runtime surfaces', () => {
    const promptModules = createDefaultPromptModules()
    const marker = 'WORLDBOOK_UNIQUE_RULE: 夜晚不能使用魔法，违反会导致行动失败'
    const surfaces = [
      getPromptTemplate({ promptModules }, 'worldview', 'privateRuntime', { worldbookEntries: marker }),
      getPromptTemplate({ promptModules }, 'worldview', 'groupRuntime', { worldbookEntries: marker }),
      getPromptTemplate({ promptModules }, 'worldview', 'momentsRuntime', { worldbookEntries: marker }),
      getPromptTemplate({ promptModules }, 'worldview', 'lifeRuntime', { worldbookEntries: marker }),
    ]
    for (const surface of surfaces) {
      expect(surface).toContain(marker)
      expect(surface).toContain('不能只')
      expect(surface).toContain('世界书')
    }
  })
})
