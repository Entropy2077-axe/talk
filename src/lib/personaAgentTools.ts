import { db } from '../db/db'
import type { AppSettings, Contact } from '../types'
import { displayName } from './contact'
import { chatCompletionProgress, type ChatMessage, type ChatToolCall, type ChatToolDefinition } from './deepseek'
import { parseJsonLoose } from './aiProtocol'
import { diagnosePersonaGeneration, type PersonaGenerationResult } from './prompt'
import { retrieveWorldbookContext } from './worldbook'

interface VoiceContext {
  provider: string
  options: Array<{ id: string; name: string; gender: string; language: string }>
}

export interface PersonaAgentOptions {
  settings: AppSettings
  systemPrompt: string
  taskId: string
  worldviewId?: string
  voiceContext?: VoiceContext
  signal?: AbortSignal
  onProgress?: (progress: PersonaAgentProgress) => void | Promise<void>
}

export interface PersonaAgentProgress {
  message: string
  toolName?: string
  /** Incremental submit_contact_draft arguments, or text JSON fallback. */
  raw?: string
}

export interface PersonaAgentResult {
  draft: PersonaGenerationResult | null
  raw: string
  usedNativeTools: boolean
}

const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''

const PERSONA_SCHEDULE_LOCATION_IDS = [
  'home-living', 'home-kitchen', 'riverside-apartment-101', 'riverside-apartment-201', 'riverside-apartment-302', 'youth-apartment-101', 'youth-apartment-202', 'youth-apartment-301', 'student-dorm-101', 'student-dorm-201', 'student-dorm-302', 'old-residences-101', 'old-residences-202', 'old-residences-302', 'villa-district-101', 'villa-district-201', 'villa-district-302',
  'school-classroom', 'school-canteen', 'school-playground', 'office-floor', 'office-lobby', 'mall-atrium', 'mall-cafe', 'mall-shop',
  'hospital-lobby', 'hospital-clinic', 'park-lawn', 'park-riverside', 'beach-boardwalk', 'mountain-lookout', 'farm-field',
] as const

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ChatToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  }
}

function submitContactDraftTool(voiceContext?: VoiceContext): ChatToolDefinition {
  const properties: Record<string, unknown> = {
    name: { type: 'string', description: '联系人日常使用的姓名或网名。' },
    realName: { type: 'string', description: '真实姓名。' },
    nickname: { type: 'string', description: '昵称或网名。' },
    birthday: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    gender: { type: 'string' },
    ageRange: { type: 'string' },
    relationship: { type: 'string' },
    occupation: { type: 'string' },
    persona: { type: 'string', description: '唯一且完整的人设正文；身份背景、性格、边界、习惯、典型行为反应和说话特点写在这里。实际消息示例通过 speechExamples 单独提交，程序随后自动合并进此人设正文。' },
    speechExamples: {
      type: 'array', minItems: 10, maxItems: 10,
      description: '正好10条实际聊天消息示例，必须互不重复并覆盖日常、关心、开心、生气、被夸、争执、亲密、拒绝、低落等不同场景。每条使用“[场景] 消息正文”格式；只写该角色会实际发出的短消息，不写分析。',
      items: { type: 'string', minLength: 4, maxLength: 160 },
    },
    visualIdentity: { type: 'string', description: 'English only. Stable physical identity without clothing, pose, scene or lighting.' },
    initialMemories: {
      type: 'array', maxItems: 10,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' }, period: { type: 'string' }, summary: { type: 'string' },
          relatedContactNames: { type: 'array', items: { type: 'string' } },
          relatedContactIds: { type: 'array', items: { type: 'string' }, description: '只填写 inspect_existing_contacts 返回的真实联系人 ID；没有参与者时填空数组。' },
          importance: { type: 'integer', minimum: 0, maximum: 100 },
        },
        required: ['title', 'period', 'summary', 'relatedContactNames', 'relatedContactIds', 'importance'],
      },
    },
    monthlySalary: { type: 'integer', minimum: 1000, maximum: 200000 },
    initialWarmth: { type: 'integer', minimum: -100, maximum: 100 },
    avatarKeyword: { type: 'string' },
    schedule: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          dayOfWeek: { type: 'integer', minimum: 0, maximum: 6 },
          startHour: { type: 'integer', minimum: 0, maximum: 23 },
          endHour: { type: 'integer', minimum: 1, maximum: 24 },
          phoneAccess: { type: 'string', enum: ['available', 'unavailable'] },
          locationId: { type: 'string', enum: [...PERSONA_SCHEDULE_LOCATION_IDS] },
          location: { type: 'string' }, activity: { type: 'string' },
        },
        required: ['dayOfWeek', 'startHour', 'endHour', 'phoneAccess', 'locationId', 'location', 'activity'],
      },
    },
  }
  if (voiceContext) {
    properties.speechVoiceId = { type: 'string', enum: voiceContext.options.map((option) => option.id) }
    properties.speechStyleInstruction = { type: 'string' }
  }
  return tool('submit_contact_draft', '提交完整的联系人初稿。只有资料已经相互一致、符合用户要求和正史时才能调用；这是最终提交动作。', properties, [
    'name', 'realName', 'nickname', 'birthday', 'gender', 'ageRange', 'relationship', 'occupation', 'persona', 'speechExamples',
    'visualIdentity', 'initialMemories',
    'monthlySalary', 'avatarKeyword', 'schedule', ...(voiceContext ? ['speechVoiceId', 'speechStyleInstruction'] : []),
  ])
}

export function personaGenerationTools(voiceContext?: VoiceContext): ChatToolDefinition[] {
  return [
    tool('search_worldbook', '按关键词查询当前世界的正史资料。仅在已有提示内容不足以确认身份、组织、能力、地点或事件时调用。', {
      query: { type: 'string', description: '简短而具体的查询词。' },
    }, ['query']),
    tool('inspect_existing_contacts', '查询现有联系人的身份、人设锚点和既有关系。需要核对新人物与谁有关时调用，可一次查询多人。', {
      names: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' } },
    }, ['names']),
    tool('get_shared_canon', '查询若干现有联系人之间已经保存的共同记忆与关系正史。', {
      contactIds: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' } },
    }, ['contactIds']),
    tool('list_available_locations', '列出联系人固定日程允许使用的真实地点 ID。只在需要核对地点含义时调用。', {}, []),
    ...(voiceContext ? [tool('list_voice_options', '列出当前语音服务真实可用的音色。只在需要核对音色时调用。', {}, [])] : []),
    submitContactDraftTool(voiceContext),
  ]
}

function callArguments(call: ChatToolCall): Record<string, unknown> | null {
  const value = parseJsonLoose<unknown>(call.function.arguments)
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function inspectContacts(names: string[]) {
  const contacts = await db.contacts.toArray()
  const needles = names.map((name) => name.trim().toLowerCase()).filter(Boolean)
  const matches = contacts.filter((contact) => {
    const aliases = [contact.id, contact.name, contact.realName, contact.nickname, displayName(contact)].filter(Boolean).map((value) => String(value).toLowerCase())
    return needles.some((needle) => aliases.some((alias) => alias === needle || alias.includes(needle) || needle.includes(alias)))
  }).slice(0, 8)
  return matches.map((contact) => ({
    id: contact.id, name: displayName(contact), realName: contact.realName, nickname: contact.nickname,
    gender: contact.gender, birthday: contact.birthday, occupation: contact.occupation,
    relationshipWithUser: contact.relationshipBase,
    personaSummary: contact.systemPrompt.slice(0, 900),
  }))
}

async function sharedCanon(contactIds: string[]) {
  const ids = Array.from(new Set(contactIds.map((id) => id.trim()).filter(Boolean))).slice(0, 6)
  const [contacts, memories, relations] = await Promise.all([
    db.contacts.bulkGet(ids),
    db.contactMemories.filter((memory) => ids.includes(memory.contactId) && (memory.relatedContactIds?.some((id) => ids.includes(id)) || memory.scope === 'interpersonal')).toArray(),
    db.contactRelations.filter((relation) => ids.includes(relation.fromContactId) && ids.includes(relation.toContactId)).toArray(),
  ])
  const names = new Map(contacts.filter((contact): contact is Contact => !!contact).map((contact) => [contact.id, displayName(contact)]))
  return {
    contacts: ids.map((id) => ({ id, name: names.get(id) ?? '未知联系人' })),
    relations: relations.slice(0, 20).map((relation) => ({ from: relation.fromContactId, to: relation.toContactId, label: relation.label, summary: relation.dynamicSummary })),
    memories: memories.sort((a, b) => b.importance - a.importance).slice(0, 12).map((memory) => ({
      contactId: memory.contactId, relatedContactIds: memory.relatedContactIds,
      content: memory.content, importance: memory.importance, tags: memory.tags,
    })),
  }
}

async function executeQuery(call: ChatToolCall, opts: PersonaAgentOptions): Promise<string> {
  const args = callArguments(call) ?? {}
  if (call.function.name === 'search_worldbook') {
    const query = text(args.query, 160)
    return query ? await retrieveWorldbookContext(query, { maxEntries: 6, maxChars: 5000, includeHighPriorityFallback: false, worldviewId: opts.worldviewId }) || '没有找到相关条目。' : '查询词为空。'
  }
  if (call.function.name === 'inspect_existing_contacts') {
    const names = Array.isArray(args.names) ? args.names.filter((value): value is string => typeof value === 'string').slice(0, 6) : []
    return JSON.stringify(await inspectContacts(names))
  }
  if (call.function.name === 'get_shared_canon') {
    const ids = Array.isArray(args.contactIds) ? args.contactIds.filter((value): value is string => typeof value === 'string').slice(0, 6) : []
    return JSON.stringify(await sharedCanon(ids))
  }
  if (call.function.name === 'list_available_locations') {
    const stored = await db.locations.bulkGet([...PERSONA_SCHEDULE_LOCATION_IDS])
    return JSON.stringify(PERSONA_SCHEDULE_LOCATION_IDS.map((id, index) => ({ id, name: stored[index]?.name ?? id, description: stored[index]?.description ?? '' })))
  }
  if (call.function.name === 'list_voice_options') return JSON.stringify(opts.voiceContext ?? { options: [] })
  return JSON.stringify({ error: `未知查询工具：${call.function.name}` })
}

function submittedDraft(calls: ChatToolCall[]): { draft: PersonaGenerationResult | null; raw: string } | null {
  const submit = calls.find((call) => call.function.name === 'submit_contact_draft')
  if (!submit) return null
  const args = callArguments(submit)
  const raw = args ? JSON.stringify(args) : submit.function.arguments
  const draft = diagnosePersonaGeneration(raw).result
  if (draft && Array.isArray(args?.initialMemories) && draft.initialMemories) {
    draft.initialMemories = draft.initialMemories.map((experience, index) => ({
      ...experience,
      relatedContactIds: Array.isArray((args.initialMemories as Array<Record<string, unknown>>)[index]?.relatedContactIds)
        ? ((args.initialMemories as Array<Record<string, unknown>>)[index].relatedContactIds as unknown[]).filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean).slice(0, 8)
        : undefined,
    })) as PersonaGenerationResult['initialMemories']
  }
  return { draft, raw }
}

/** A bounded read-only persona agent. It may inspect local canon, but only the
 * existing confirmation flow is allowed to write the resulting contact. */
export async function generatePersonaWithTools(opts: PersonaAgentOptions): Promise<PersonaAgentResult> {
  const allTools = personaGenerationTools(opts.voiceContext)
  const submitTool = allTools.find((item) => item.function.name === 'submit_contact_draft')!
  const messages: ChatMessage[] = [
    { role: 'system', content: `${opts.systemPrompt}\n\n你可以使用只读工具核对现有资料，最多查询三轮。资料充分后必须调用 submit_contact_draft，一次提交完整初稿。不要调用不存在的工具。如果当前模型或接口无法使用工具，则直接按上面的固定 JSON 协议输出完整 JSON。` },
    { role: 'user', content: '请生成联系人。先判断现有资料是否足够；需要时查询，资料充分后提交完整初稿。' },
  ]
  let usedNativeTools = false
  let lastSubmittedRaw = ''
  for (let round = 0; round < 4; round++) {
    const forceSubmit = round === 3
    await opts.onProgress?.({ message: round === 0 ? '正在设计人物身份与人设' : forceSubmit ? '正在整理并提交完整人物初稿' : '正在根据已查询资料继续生成' })
    const result = await chatCompletionProgress({
      apiKey: opts.settings.apiKey, baseUrl: opts.settings.baseUrl, model: opts.settings.model,
      provider: opts.settings.aiProvider, messages, signal: opts.signal, thinking: 'disabled', temperature: 0.7,
      purpose: 'persona', trace: { turnId: opts.taskId, stage: round === 0 ? 'original_generation' : 'tool_call' },
      tools: forceSubmit ? [submitTool] : allTools,
      toolChoice: forceSubmit ? { type: 'function', function: { name: 'submit_contact_draft' } } : 'auto',
      onProgress: async (snapshot) => {
        const submit = snapshot.toolCalls.find((call) => call.function.name === 'submit_contact_draft')
        if (submit) await opts.onProgress?.({ message: '正在逐项生成联系人资料', toolName: submit.function.name, raw: submit.function.arguments })
        else if (snapshot.toolCalls.length) {
          const active = snapshot.toolCalls.at(-1)!
          await opts.onProgress?.({ message: `正在调用资料查询：${active.function.name || '准备查询'}`, toolName: active.function.name })
        } else if (snapshot.content) await opts.onProgress?.({ message: '接口不支持原生工具，正在读取兼容 JSON', raw: snapshot.content })
      },
    })
    if (!result.toolCalls?.length) return { draft: null, raw: result.content, usedNativeTools }
    usedNativeTools = true
    const submitted = submittedDraft(result.toolCalls)
    if (submitted) lastSubmittedRaw = submitted.raw
    if (submitted?.draft) return { ...submitted, usedNativeTools }

    messages.push({ role: 'assistant', content: result.content, tool_calls: result.toolCalls })
    for (const call of result.toolCalls) {
      if (call.function.name === 'submit_contact_draft') {
        messages.push({ role: 'tool', tool_call_id: call.id, content: '提交未通过结构校验。请补齐 name、persona 等必填内容并重新完整提交。' })
      } else {
        await opts.onProgress?.({ message: `已完成资料查询：${call.function.name}`, toolName: call.function.name })
        messages.push({ role: 'tool', tool_call_id: call.id, content: await executeQuery(call, opts) })
      }
    }
  }
  return { draft: null, raw: lastSubmittedRaw, usedNativeTools }
}
