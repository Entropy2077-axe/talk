import { db } from '../db/db'
import type { AppSettings, Contact } from '../types'
import { displayName } from './contact'
import { chatCompletion, type ChatMessage, type ChatToolCall, type ChatToolDefinition } from './deepseek'
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
}

export interface PersonaAgentResult {
  draft: PersonaGenerationResult | null
  raw: string
  usedNativeTools: boolean
}

const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''

const PERSONA_SCHEDULE_LOCATION_IDS = [
  'home-living', 'home-kitchen', 'riverside-apartment-room', 'youth-apartment-room', 'student-dorm-room', 'old-residences-lane', 'villa-district-lane',
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
    persona: { type: 'string', description: '完整、具体且自然的第三人称人物设定。' },
    visualIdentity: { type: 'string', description: 'English only. Stable physical identity without clothing, pose, scene or lighting.' },
    personalityTrait: { type: 'string' },
    mbti: { type: 'string', pattern: '^[IE][SN][TF][JP]$' },
    speechSamples: { type: 'array', minItems: 4, maxItems: 8, items: { type: 'string' } },
    personaProfile: {
      type: 'object', additionalProperties: false,
      properties: {
        facts: { type: 'array', items: { type: 'string' } },
        boundaries: { type: 'array', items: { type: 'string' } },
        habits: { type: 'array', items: { type: 'string' } },
        behaviorAnchors: { type: 'array', items: { type: 'string' } },
      },
      required: ['facts', 'boundaries', 'habits', 'behaviorAnchors'],
    },
    pastExperiences: {
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
    'name', 'realName', 'nickname', 'birthday', 'gender', 'ageRange', 'relationship', 'occupation', 'persona',
    'visualIdentity', 'personalityTrait', 'mbti', 'speechSamples', 'personaProfile', 'pastExperiences',
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
    tool('get_shared_canon', '查询若干现有联系人之间已经保存的共同经历与关系正史。', {
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
    relationshipWithUser: contact.relationshipBase, personaProfile: contact.personaProfile,
    personaSummary: contact.systemPrompt.slice(0, 900),
  }))
}

async function sharedCanon(contactIds: string[]) {
  const ids = Array.from(new Set(contactIds.map((id) => id.trim()).filter(Boolean))).slice(0, 6)
  const [contacts, experiences, relations] = await Promise.all([
    db.contacts.bulkGet(ids),
    db.contactExperiences.filter((experience) => experience.contactIds.some((id) => ids.includes(id))).toArray(),
    db.contactRelations.filter((relation) => ids.includes(relation.fromContactId) && ids.includes(relation.toContactId)).toArray(),
  ])
  const names = new Map(contacts.filter((contact): contact is Contact => !!contact).map((contact) => [contact.id, displayName(contact)]))
  return {
    contacts: ids.map((id) => ({ id, name: names.get(id) ?? '未知联系人' })),
    relations: relations.slice(0, 20).map((relation) => ({ from: relation.fromContactId, to: relation.toContactId, label: relation.label, summary: relation.dynamicSummary })),
    experiences: experiences.sort((a, b) => b.importance - a.importance).slice(0, 12).map((experience) => ({
      contactIds: experience.contactIds, title: experience.title, period: experience.periodLabel,
      summary: experience.summary, importance: experience.importance, sources: experience.sources,
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
  if (draft && Array.isArray(args?.pastExperiences) && draft.pastExperiences) {
    draft.pastExperiences = draft.pastExperiences.map((experience, index) => ({
      ...experience,
      relatedContactIds: Array.isArray((args.pastExperiences as Array<Record<string, unknown>>)[index]?.relatedContactIds)
        ? ((args.pastExperiences as Array<Record<string, unknown>>)[index].relatedContactIds as unknown[]).filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean).slice(0, 8)
        : undefined,
    })) as PersonaGenerationResult['pastExperiences']
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
    const result = await chatCompletion({
      apiKey: opts.settings.apiKey, baseUrl: opts.settings.baseUrl, model: opts.settings.model,
      provider: opts.settings.aiProvider, messages, signal: opts.signal, thinking: 'disabled', temperature: 0.7,
      maxTokens: 2600, purpose: 'persona', trace: { turnId: opts.taskId, stage: round === 0 ? 'original_generation' : 'tool_call' },
      tools: forceSubmit ? [submitTool] : allTools,
      toolChoice: forceSubmit ? { type: 'function', function: { name: 'submit_contact_draft' } } : 'auto',
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
        messages.push({ role: 'tool', tool_call_id: call.id, content: await executeQuery(call, opts) })
      }
    }
  }
  return { draft: null, raw: lastSubmittedRaw, usedNativeTools }
}
