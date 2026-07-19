import { describe, expect, it } from 'vitest'
import { buildPersonaGenerationPrompt, buildRawChatPrompt } from './prompt'

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
    expect(prompt).toContain('首轮')
    expect(prompt).toContain('恋人')
    expect(prompt).toContain('雌小鬼')
    expect(prompt).toContain('说话样例')
    expect(prompt).toContain('共同过往只允许使用已给出的事实')
  })

  it('asks minimal Nuwa generation to fill omitted identity fields consistently', () => {
    const prompt = buildPersonaGenerationPrompt({
      personalityTags: [],
      ageRange: '',
      gender: '',
      relationship: '',
      personalityTrait: '',
      hobbies: [],
      extra: '想要一个嘴硬但很在乎我的雌小鬼恋人。',
      sharedHistory: '我们小时候就认识。',
      minimalNuwa: true,
    }, 'anime')

    expect(prompt).toContain('极简女娲模式')
    expect(prompt).toContain('自行补全年龄、性别、关系定位、职业、兴趣、性格特质和身份资料')
    expect(prompt).toContain('我们小时候就认识')
    expect(prompt).toContain('relationship')
    expect(prompt).toContain('speechSamples')
  })
})
