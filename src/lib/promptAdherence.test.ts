import { describe, expect, it } from 'vitest'
import { buildPersonaGenerationPrompt, buildRawChatPrompt, personaNarrativeForPrompt } from './prompt'
import { createDefaultPromptModules, getPromptTemplate } from './promptModules'

describe('relationship and persona adherence prompts', () => {
  it('removes a legacy persona-setting prefix duplicated by the generated narrative', () => {
    const setting = '年龄：14\n关系定位：青梅竹马'
    expect(personaNarrativeForPrompt(`${setting}\n\n她表面嘴硬，实际很在意用户。`, setting))
      .toBe('她表面嘴硬，实际很在意用户。')
  })

  it('puts the canonical persona, relationship, and shared history in the first-turn contract', () => {
    const prompt = buildRawChatPrompt({
      name: '小满',
      persona: '嘴硬但很在乎用户，喜欢用轻微挑衅掩饰关心。',
      stylePrompt: '自然聊天，短句。',
      relationshipBase: '恋人',
      recentContext: '刚开始聊天。',
      latestUserText: '早安',
      stickerNames: [],
      recentMemoriesText: '你们在大学社团认识，她曾陪用户熬夜准备考试。',
    })

    expect(prompt).toContain('最近的记忆碎片')
    expect(prompt).toContain('第一句')
    expect(prompt).toContain('恋人')
    expect(prompt).toContain('嘴硬但很在乎用户')
    expect(prompt).toContain('只能使用给出的细节')
  })

  it('does not duplicate a current-situation heading supplied by runtime context', () => {
    const prompt = buildRawChatPrompt({
      name: '小满',
      persona: '自然聊天。',
      stylePrompt: '短句。',
      recentContext: '',
      situationContext: '【当前情境】现在是周六晚上。',
      stickerNames: [],
    })

    expect(prompt.match(/【当前情境】/g)).toHaveLength(1)
    expect(prompt).toContain('现在是周六晚上。')
    expect(prompt).toContain('通过本轮指定的原生工具提交')
    expect(prompt).not.toContain('只输出自然聊天正文')
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
    expect(prompt).toContain('birthday、ageRange和persona中写出的年龄必须')
    expect(prompt).toContain('我们小时候就认识')
    expect(prompt).toContain('relationship')
    expect(prompt).toContain('唯一且完整的人设正文')
    expect(prompt).not.toContain('speechSamples')
    expect(prompt).not.toContain('personaProfile')
  })

  it('keeps media tool instructions out of the main natural-text prompt', () => {
    const enabled = buildRawChatPrompt({
      name: '小满',
      persona: '自然聊天。',
      stylePrompt: '短句。',
      recentContext: '正在聊天。',
      stickerNames: ['点头'],
      remoteStickerSearchEnabled: true,
      imageGenerationEnabled: true,
    })
    expect(enabled).not.toContain('[sticker:')
    expect(enabled).not.toContain('[image:')
    expect(enabled).not.toContain('表情使用硬偏好')
    expect(enabled).not.toContain('具体英文场景描述')
    expect(enabled).not.toContain('工具调用')

    const disabled = buildRawChatPrompt({
      name: '小满',
      persona: '自然聊天。',
      stylePrompt: '短句。',
      recentContext: '正在聊天。',
      stickerNames: [],
    })
    expect(disabled).not.toContain('[sticker:')
    expect(disabled).not.toContain('[image:')
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
      recentMemoriesText: 'MEMORY_SHARED_PAYLOAD',
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
    ]
    for (const surface of surfaces) {
      expect(surface).toContain(marker)
      expect(surface).toContain('不能只')
      expect(surface).toContain('世界书')
    }
  })
})
