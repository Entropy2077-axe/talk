import { describe, expect, it } from 'vitest'
import { localNuwaFormatIssues, NUWA_FORM_KEYS, parseNuwaReview, parseNuwaStructuredResult, preserveFilledNuwaFields, submitNuwaFormTool, validateNuwaCompletion } from './nuwaPersona'

describe('Nuwa persona protocol', () => {
  it('parses fenced JSON and legacy Chinese field aliases', () => {
    const parsed = parseNuwaStructuredResult('```json\n{"真名":"林夏","昵称":"小夏","兴趣爱好":["摄影","徒步"]}\n```')
    expect(parsed?.realName).toBe('林夏')
    expect(parsed?.nickname).toBe('小夏')
    expect(parsed?.hobbies).toBe('摄影、徒步')
  })

  it('reports missing, wrongly typed, and extra fields', () => {
    const issues = localNuwaFormatIssues('{"realName":42,"extra":"value"}')
    expect(issues.join('\n')).toContain('缺少字段')
    expect(issues.join('\n')).toContain('字段必须是字符串：realName')
    expect(issues.join('\n')).toContain('包含未允许字段：extra')
  })

  it('keeps only string review issues', () => {
    expect(parseNuwaReview('{"valid":false,"issues":["缺少生日",42]}'))
      .toEqual({ valid: false, issues: ['缺少生日'] })
  })

  it('keeps the native submit tool schema aligned with the fixed form', () => {
    const schema = submitNuwaFormTool().function.parameters as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }
    expect(Object.keys(schema.properties)).toEqual([...NUWA_FORM_KEYS])
    expect(schema.properties).not.toHaveProperty('personalityTrait')
    expect(schema.properties).not.toHaveProperty('personalityTraitContent')
    expect(schema.required).toEqual([...NUWA_FORM_KEYS])
    expect(schema.additionalProperties).toBe(false)
  })

  it('restores user-entered fields instead of accepting a model paraphrase', () => {
    const raw = JSON.stringify(Object.fromEntries(NUWA_FORM_KEYS.map((key) => [key, `${key}-model`])))
    const current = { ...Object.fromEntries(NUWA_FORM_KEYS.map((key) => [key, ''])) } as unknown as import('./nuwaPersona').NuwaStructuredResult
    current.otherSetting = '用户原始人设，必须保留。'
    expect(parseNuwaStructuredResult(preserveFilledNuwaFields(raw, current))?.otherSetting).toBe(current.otherSetting)
  })

  it('accepts harmless provider formatting differences without a second AI review', () => {
    const raw = `\`\`\`json\n${JSON.stringify({
      真名: '林夏', 昵称: '小夏', 出生日期: '2001-05-06', 性格倾向: '温和、坚定', 年龄: 25,
      性别: '女', 关系定位: '朋友', 职业: '摄影师', 兴趣爱好: ['摄影', '徒步'],
      其他角色设定: '说话自然，重视承诺。', harmlessExtra: '兼容提供商附加字段',
    })}\n\`\`\``
    const validated = validateNuwaCompletion(raw)
    expect(validated.issues).toEqual([])
    expect(validated.result?.hobbies).toBe('摄影、徒步')
  })

  it('retries only when content needed by the form is genuinely empty', () => {
    const raw = JSON.stringify(Object.fromEntries(NUWA_FORM_KEYS.map((key) => [key, key === 'birthday' ? '' : '已填写'])))
    expect(validateNuwaCompletion(raw).issues).toEqual(['以下内容仍未补全：出生日期'])
  })
})
