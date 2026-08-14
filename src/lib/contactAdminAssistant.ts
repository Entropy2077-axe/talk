import type { AppSettings, Contact, PromptModuleSettings } from '../types'
import { chatCompletionText } from './deepseek'
import { parseJsonLoose } from './aiProtocol'

export interface ContactAdminSuggestion {
  summary: string
  contactPatch?: Partial<Contact>
  promptModulePatches?: Partial<PromptModuleSettings>
}

export async function suggestContactAdminEdit(input: {
  settings: AppSettings
  contact: Contact
  promptModules: PromptModuleSettings
  instruction: string
}): Promise<ContactAdminSuggestion> {
  const raw = await chatCompletionText({
    apiKey: input.settings.apiKey,
    baseUrl: input.settings.baseUrl,
    model: input.settings.utilityModel || input.settings.model,
    provider: input.settings.aiProvider,
    messages: [{
      role: 'system',
      content: `你是联系人设定二次编辑助手。根据管理员的明确要求提出最小修改，不得擅自改变未被要求的身份、人设、记忆、关系、职业或世界观。只输出 JSON：
{"summary":"修改说明","contactPatch":{},"promptModulePatches":{}}
contactPatch 只放需要改变的 Contact 字段；不得修改 id、createdAt、记忆游标或后台时间戳。所有人设、性格、边界、习惯、行为方式、口癖和实际说话示例都必须直接修改 systemPrompt，不能创建 personaConstraints、personaProfile、personalityTrait、customPersonalityTraits、speechSamples、mbti、sharedHistory 等并行或退役字段。过去事实只能进入记忆系统，不得伪装成人设。promptModulePatches 只放当前仍存在的模块和模板，不得使用 sharedHistory、hardPersona、aiChatterMode、energyLevel 等退役占位符。`,
    }, {
      role: 'user',
      content: `管理员要求：${input.instruction}

当前联系人：
${JSON.stringify(input.contact)}

当前固定提示词：
${JSON.stringify(input.promptModules)}`,
    }],
    jsonMode: true,
    thinking: 'disabled',
    temperature: 0.25,
    maxTokens: 3200,
    purpose: 'persona',
  })
  const parsed = parseJsonLoose<ContactAdminSuggestion>(raw)
  if (!parsed || typeof parsed !== 'object' || typeof parsed.summary !== 'string') throw new Error('AI 没有返回可用的修改方案')
  return parsed
}
