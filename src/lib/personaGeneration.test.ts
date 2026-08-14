import { describe, expect, it } from 'vitest'
import { buildPersonaGenerationPrompt, diagnosePersonaGeneration, parsePersonaGeneration, type PersonaAnswers } from './prompt'

const answers: PersonaAnswers = {
  personalityTags: ['慢热'],
  ageRange: '20-25岁',
  gender: '女',
  relationship: '朋友',
  personalityTrait: '猫系',
  hobbies: ['看书'],
  extra: '',
}
const speechExamples = Array.from({ length: 10 }, (_, index) => `[场景${index + 1}] 示例消息${index + 1}`)

describe('persona initial warmth', () => {
  it('asks the model to decide initial warmth only for Nuwa drafts', () => {
    expect(buildPersonaGenerationPrompt({ ...answers, draftMode: true }, 'anime')).toContain('"initialWarmth": 35')
    expect(buildPersonaGenerationPrompt({ ...answers, draftMode: false }, 'anime')).not.toContain('"initialWarmth": 35')
  })

  it('rounds and clamps the model-provided value', () => {
    const parsed = parsePersonaGeneration(JSON.stringify({
      name: '阿澄', persona: '测试人设', speechExamples, schedule: [], initialWarmth: 128.7,
    }))
    expect(parsed?.initialWarmth).toBe(100)
  })

  it('requires and parses initial memories', () => {
    expect(buildPersonaGenerationPrompt(answers, 'anime', undefined, '世界书中的旧事')).toContain('"initialMemories"')
    const parsed = parsePersonaGeneration(JSON.stringify({
      name: '林夏', persona: '测试人设', speechExamples, schedule: [],
      initialMemories: [{ title: '重逢', period: '去年', summary: '与旧友重新取得联系。', relatedContactNames: ['周晴'], importance: 88 }],
    }))
    expect(parsed?.initialMemories).toEqual([{ title: '重逢', period: '去年', summary: '与旧友重新取得联系。', relatedContactNames: ['周晴'], importance: 88 }])
  })

  it('asks the persona model to assign only an available contact voice', () => {
    const prompt = buildPersonaGenerationPrompt(answers, 'anime', undefined, '', {
      provider: 'mimo',
      options: [{ id: '冰糖', name: '冰糖 · 中文女声', gender: 'female', language: 'zh' }],
    })
    expect(prompt).toContain('speechVoiceId')
    expect(prompt).toContain('冰糖｜冰糖 · 中文女声｜female｜zh')
    const parsed = parsePersonaGeneration(JSON.stringify({
      name: '林夏', persona: '测试人设', speechExamples, schedule: [],
      speechVoiceId: '冰糖', speechStyleInstruction: '清亮、自然、语速稍慢',
    }))
    expect(parsed?.speechVoiceId).toBe('冰糖')
    expect(parsed?.speechStyleInstruction).toBe('清亮、自然、语速稍慢')
  })

  it('requires exactly ten structured speech examples', () => {
    const prompt = buildPersonaGenerationPrompt(answers, 'anime')
    expect(prompt).toContain('"speechExamples"')
    expect(prompt).toContain('聊天感觉基线——低权重')
    expect(prompt).toContain('角色独有的句子节奏')
    expect(prompt).toContain('0到2个自然口癖')
    expect(parsePersonaGeneration(JSON.stringify({ name: '林夏', persona: '测试人设', speechExamples, schedule: [] }))?.speechExamples).toHaveLength(10)
    const invalid = diagnosePersonaGeneration(JSON.stringify({ name: '林夏', persona: '测试人设', speechExamples: speechExamples.slice(0, 9), schedule: [] }))
    expect(invalid.diagnostics.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'speechExamples' })]))
  })
})

describe('persona generation diagnostics', () => {
  it('identifies a truncated JSON response', () => {
    const result = diagnosePersonaGeneration('{"name":"test","persona":"unfinished')
    expect(result.result).toBeNull()
    expect(result.diagnostics.issues[0]?.code).toBe('json_truncated')
  })

  it('lists missing and invalid core fields precisely', () => {
    const missing = diagnosePersonaGeneration(JSON.stringify({ persona: 'This is a sufficiently detailed persona used to test a missing name diagnostic.' }))
    expect(missing.diagnostics.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'name', code: 'required_field_missing' })]))
    const invalid = diagnosePersonaGeneration(JSON.stringify({ name: ['test'], persona: '' }))
    expect(invalid.diagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'name', code: 'required_field_invalid' }),
      expect.objectContaining({ field: 'persona', code: 'required_field_invalid' }),
    ]))
  })
})
