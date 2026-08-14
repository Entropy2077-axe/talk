import { parseJsonLoose } from './aiProtocol'
import type { ChatToolDefinition } from './deepseek'

export interface NuwaStructuredResult {
  realName: string
  nickname: string
  birthday: string
  tendencies: string
  age: string
  gender: string
  relationship: string
  occupation: string
  hobbies: string
  otherSetting: string
}

export const NUWA_FORM_KEYS = ['realName', 'nickname', 'birthday', 'tendencies', 'age', 'gender', 'relationship', 'occupation', 'hobbies', 'otherSetting'] as const
export const NUWA_FORM_JSON_SCHEMA = '{"realName":"","nickname":"","birthday":"","tendencies":"","age":"","gender":"","relationship":"","occupation":"","hobbies":"","otherSetting":""}'
export const NUWA_FIELD_LABELS: Record<(typeof NUWA_FORM_KEYS)[number], string> = {
  realName: '真名', nickname: '网名/昵称', birthday: '出生日期', tendencies: '性格倾向', age: '年龄', gender: '性别', relationship: '关系定位', occupation: '职业', hobbies: '兴趣爱好', otherSetting: '人设',
}

/** Native-function counterpart of the fixed Nuwa form protocol. */
export function submitNuwaFormTool(): ChatToolDefinition {
  const properties = Object.fromEntries(NUWA_FORM_KEYS.map((key) => [key, {
    type: 'string',
    description: NUWA_FIELD_LABELS[key],
  }]))
  return {
    type: 'function',
    function: {
      name: 'submit_nuwa_form',
      description: '提交精细创建的人设补全结果。必须完整填写固定表单；只能补全空字段，绝不能改写用户已有字段。',
      parameters: {
        type: 'object',
        properties,
        required: [...NUWA_FORM_KEYS],
        additionalProperties: false,
      },
    },
  }
}

export function nuwaFormOutputProtocol(): string {
  return `【固定输出协议】这是不可编辑的界面数据协议，优先级高于前文的输出形式要求。
支持原生工具调用时，必须调用 submit_nuwa_form，并将以下全部字段作为工具参数提交；接口不支持工具调用时，才只返回一个合法 JSON 对象。禁止输出普通段落、Markdown、代码块、标题或解释。
JSON 的键必须完整且只能使用以下结构：
${NUWA_FORM_JSON_SCHEMA}
必须把原本为空的每一个字段都补成具体、非空的内容，不允许继续返回空字符串；已填写字段必须逐字保留。所有性格、边界、习惯、行为和说话方式都写入 otherSetting 这一份完整人设正文，不得创建并行的人格字段。
hobbies 使用顿号分隔。即使初稿建议很简短，也要根据已有信息合理补齐全部字段，并保证彼此一致。`
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  const value = parseJsonLoose<unknown>(raw)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function parseNuwaStructuredResult(raw: string): NuwaStructuredResult | null {
  const value = parseJsonRecord(raw)
  if (!value) return null
  const text = (...keys: string[]) => {
    const item = keys.map((key) => value[key]).find((candidate) => candidate !== undefined && candidate !== null)
    const scalar = (entry: unknown) => typeof entry === 'string' || typeof entry === 'number' ? String(entry).trim() : ''
    if (Array.isArray(item)) return item.map(scalar).filter(Boolean).join('、')
    return scalar(item)
  }
  return {
    realName: text('realName', '真名'),
    nickname: text('nickname', '网名', '昵称'),
    birthday: text('birthday', '出生日期'),
    tendencies: text('tendencies', '性格倾向'),
    age: text('age', '年龄'),
    gender: text('gender', '性别'),
    relationship: text('relationship', '关系定位'),
    occupation: text('occupation', '职业'),
    hobbies: text('hobbies', '兴趣爱好'),
    otherSetting: text('otherSetting', 'personaSetting', '其他角色设定', '其他设定'),
  }
}

/** The model may paraphrase a field despite the instruction not to.  The UI
 * owns user-entered values, so restore them before review or application;
 * completion is allowed to contribute only to genuinely empty fields. */
export function preserveFilledNuwaFields(raw: string, current: NuwaStructuredResult): string {
  const value = parseJsonRecord(raw)
  if (!value) return raw
  for (const key of NUWA_FORM_KEYS) {
    if (current[key]) value[key] = current[key]
  }
  return JSON.stringify(value)
}

export function localNuwaFormatIssues(raw: string): string[] {
  const value = parseJsonRecord(raw)
  if (!value) return ['输出不是合法的 JSON 对象']
  const missing = NUWA_FORM_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  const wrongTypes = NUWA_FORM_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(value, key) && typeof value[key] !== 'string')
  const extra = Object.keys(value).filter((key) => !NUWA_FORM_KEYS.includes(key as typeof NUWA_FORM_KEYS[number]))
  return [
    missing.length ? `缺少字段：${missing.join('、')}` : '',
    wrongTypes.length ? `字段必须是字符串：${wrongTypes.join('、')}` : '',
    extra.length ? `包含未允许字段：${extra.join('、')}` : '',
  ].filter(Boolean)
}

export function parseNuwaReview(raw: string): { valid: boolean; issues: string[] } | null {
  const value = parseJsonRecord(raw)
  if (!value) return null
  const issues = Array.isArray(value.issues)
    ? value.issues.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : []
  return { valid: value.valid === true, issues }
}

export function hasNuwaFormFields(result: NuwaStructuredResult): boolean {
  return [result.realName, result.nickname, result.birthday, result.tendencies, result.age, result.gender, result.relationship, result.occupation, result.hobbies].some(Boolean)
}
