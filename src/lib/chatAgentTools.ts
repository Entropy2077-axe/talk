import type { AiBubble, GroupAiBubble } from '../types'
import { parseJsonLoose, serializePrivateTurn, type ImmediateActivityAction, type ParsedAiTurn } from './aiProtocol'
import { normalizeMood } from './mood'
import type { ChatCompletionOptions, ChatMessage, ChatToolCall, ChatToolDefinition } from './deepseek'
import { chatCompletion, chatCompletionText } from './deepseek'

interface AgentToolOptions {
  apiKey: string
  baseUrl: string
  model: string
  utilityModel: string
  messages: ChatMessage[]
  signal?: AbortSignal
  purpose: ChatCompletionOptions['purpose']
  automatic?: boolean
  trace: NonNullable<ChatCompletionOptions['trace']>
  stickerNames: string[]
  stickerSearchEnabled: boolean
  imageEnabled: boolean
  knowledgeEnabled: boolean
  scheduleEnabled: boolean
  locationIds: string[]
}

interface ToolPlan { calls?: Array<{ name?: unknown; arguments?: unknown }> }

const PRIVATE_TURN_TOOL_NAME = 'submit_turn'

const GROUP_ACTION_TOOL_NAMES = new Set(['send_image', 'create_schedule'])

const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const positiveInteger = (value: unknown) => {
  const number = Math.round(Number(value))
  return Number.isFinite(number) && number > 0 ? number : 0
}

function commonProperties() {
  return {
    thought: { type: 'string', description: '角色这一刻没有说出口的真实想法，简短中文文字，不得留空。' },
    mood: { type: 'string', description: '角色当前心情，使用简短中文文字，例如开心、担心、期待、平静；不要使用 emoji。' },
  }
}

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[]): ChatToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  }
}

export function privateChatTools(opts: Pick<AgentToolOptions, 'stickerNames' | 'stickerSearchEnabled' | 'imageEnabled' | 'knowledgeEnabled' | 'scheduleEnabled' | 'locationIds'>): ChatToolDefinition[] {
  const tools = [fn('send_text', '发送一条普通聊天消息。每条独立消息调用一次，并按实际发送顺序排列调用。', {
    content: { type: 'string', description: '用户可见的自然聊天正文。' }, ...commonProperties(),
  }, ['content', 'thought', 'mood'])]
  if (opts.stickerNames.length || opts.stickerSearchEnabled) tools.push(fn('send_sticker', '发送一个表情包。没有真实发送意图时不要调用。', {
    name: opts.stickerSearchEnabled
      ? { type: 'string', description: '简短具体的表情搜索词，优先英文；也可使用已知本地表情名。' }
      : { type: 'string', enum: opts.stickerNames, description: '必须逐字选择一个本地表情名。' },
    ...commonProperties(),
  }, ['name', 'thought', 'mood']))
  if (opts.imageEnabled) tools.push(fn('send_image', '生成或搜索并发送一张纯图片。只有角色确实决定发图时调用；图片本身不带配文，因此必须在同一轮另外调用 send_text 自然说话。', {
    query: { type: 'string', description: '完整英文画面提示，清楚描述主体、场景、动作、构图、光线、颜色和氛围。' },
    kind: { type: 'string', enum: ['selfie', 'portrait', 'scene', 'object'] },
    participants: { type: 'array', items: { type: 'string', enum: ['self', 'user'] } },
    ...commonProperties(),
  }, ['query', 'kind', 'participants', 'thought', 'mood']))
  if (opts.knowledgeEnabled) tools.push(fn('search_knowledge', '查询角色当前确实不懂、但回答用户前必须弄清楚的新词、作品或事实。查询后系统会把结果交回角色重新回答。', {
    query: { type: 'string', description: '简短、可搜索的查询词。' },
  }, ['query']))
  if (opts.scheduleEnabled && opts.locationIds.length) tools.push(fn('create_schedule', '记录已经形成的具体线下安排。角色既可以接受用户提出的安排，也可以根据人设主动提出并作出具体承诺；只要日期、整点开始和结束时间、合法地点都已确定，就应调用。仅讨论可能性、反问、拒绝、附带未满足条件或信息不全时不要调用。此卡片不能代替自然聊天，必须同时调用 send_text 说清角色的回应。', {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    startHour: { type: 'integer', minimum: 0, maximum: 23 },
    endHour: { type: 'integer', minimum: 1, maximum: 24 },
    locationId: { type: 'string', enum: opts.locationIds },
    activity: { type: 'string' }, phoneAccess: { type: 'string', enum: ['available', 'unavailable'] }, summary: { type: 'string' },
    ...commonProperties(),
  }, ['date', 'startHour', 'endHour', 'locationId', 'activity', 'phoneAccess', 'summary', 'thought', 'mood']))
  if (opts.scheduleEnabled && opts.locationIds.length) tools.push(fn('start_activity_now', '角色明确决定现在立刻前往某个具体地点并开始一项活动时调用。适用于“现在去厨房做菜”这类即时行动，不用于未来安排、仅讨论可能性、拒绝或尚未答应的请求。调用后必须同时用 send_text 自然回应。', {
    locationId: { type: 'string', enum: opts.locationIds },
    activity: { type: 'string', description: '现在开始进行的简短活动，例如“做菜”。' },
    durationMinutes: { type: 'integer', minimum: 5, maximum: 480, description: '预计持续分钟数；根据活动合理估计。' },
    phoneAccess: { type: 'string', enum: ['available', 'unavailable'] },
    ...commonProperties(),
  }, ['locationId', 'activity', 'durationMinutes', 'phoneAccess', 'thought', 'mood']))
  tools.push(
    fn('recommend_contact', '当你以当前角色的身份，确实想到一位自己认识、尚未与用户建立联系的人，而且此刻自然适合牵线时调用。不要为了活跃气氛、完成任务或仅因工具可用而调用；同一人不要重复推荐。调用后还要用 send_text 自然引出推荐卡。', {
      candidateName: { type: 'string', description: '被推荐人的姓名或常用昵称。必须是当前角色确实认识的人。' },
      relationToRecommender: { type: 'string', description: '被推荐人与当前角色的真实关系，例如同事、大学室友、表姐。' },
      recommendationReason: { type: 'string', description: '为什么此刻觉得用户和对方值得认识，要具体且符合当前聊天语境。' },
      shortDescription: { type: 'string', description: '当前角色可以向用户公开的一两句人物介绍，不得泄露隐私。' },
      gender: { type: 'string', description: '已知性别；不确定时填写“不确定”。' },
      ageRange: { type: 'string', description: '已知年龄或年龄段；不确定时填写“不确定”。' },
      occupation: { type: 'string', description: '已知职业或身份；不确定时填写“不确定”。' },
      hobbies: { type: 'array', maxItems: 6, items: { type: 'string' }, description: '当前角色确实知道的兴趣，未知可为空数组。' },
      personalityClues: { type: 'array', maxItems: 6, items: { type: 'string' }, description: '当前角色通过相处知道的性格线索，不要写全知视角设定。' },
      ...commonProperties(),
    }, ['candidateName', 'relationToRecommender', 'recommendationReason', 'shortDescription', 'gender', 'ageRange', 'occupation', 'hobbies', 'personalityClues', 'thought', 'mood']),
    fn('transfer_money', '角色决定立即向用户转账时调用。', { amount: { type: 'integer', minimum: 1 }, note: { type: 'string' }, ...commonProperties() }, ['amount', 'note', 'thought', 'mood']),
    fn('send_red_packet', '角色决定立即向用户发送红包时调用。', { amount: { type: 'integer', minimum: 1 }, blessing: { type: 'string' }, ...commonProperties() }, ['amount', 'blessing', 'thought', 'mood']),
    fn('request_loan', '角色决定向用户借钱时调用。', { amount: { type: 'integer', minimum: 1 }, reason: { type: 'string' }, ...commonProperties() }, ['amount', 'reason', 'thought', 'mood']),
    fn('decide_loan', '角色处理一个上下文中明确存在的待处理贷款时调用。', { loanId: { type: 'string' }, decision: { type: 'string', enum: ['accept', 'reject'] }, amount: { type: 'integer', minimum: 1 }, ...commonProperties() }, ['loanId', 'decision', 'amount', 'thought', 'mood']),
    fn('purchase_gift', '角色决定立即购买礼物送给用户时调用。', { amount: { type: 'integer', minimum: 1 }, name: { type: 'string' }, icon: { type: 'string' }, description: { type: 'string' }, ...commonProperties() }, ['amount', 'name', 'icon', 'description', 'thought', 'mood']),
  )
  return tools
}

export function privateTurnToolDefinition(opts: Pick<AgentToolOptions, 'stickerNames' | 'stickerSearchEnabled' | 'imageEnabled' | 'knowledgeEnabled' | 'scheduleEnabled' | 'locationIds'>): ChatToolDefinition {
  const eventTypes = [
    'text',
    ...(opts.stickerNames.length || opts.stickerSearchEnabled ? ['sticker'] : []),
    ...(opts.imageEnabled ? ['image'] : []),
    ...(opts.scheduleEnabled && opts.locationIds.length ? ['schedule', 'activity_now'] : []),
    'contact_recommendation', 'transfer', 'red_packet', 'loan_request', 'loan_decision', 'gift_purchase',
  ]
  return fn(PRIVATE_TURN_TOOL_NAME, '一次提交本轮完整回复。events 按真实发送顺序排列，可以包含任意数量的文字、图片、表情和动作；不要机械地让每张图片固定搭配一句文字。图片和行动不能单独作为回复，但只要求整轮至少有一条自然文字，文字可以位于其前后。', {
    events: {
      type: 'array', minItems: 0, maxItems: 12,
      description: '本轮有序事件。可以连续发送多段文字或多张图片；根据角色意愿自然决定数量和顺序。仅查询知识时可以为空。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          type: {
            type: 'string', enum: eventTypes,
            description: '事件类型及必填字段：text→content；sticker→name；image→query/kind/participants；schedule→date/startHour/endHour/locationId/activity/phoneAccess/summary；activity_now→locationId/activity/durationMinutes/phoneAccess；contact_recommendation→candidateName/relationToRecommender/recommendationReason/shortDescription/gender/ageRange/occupation/hobbies/personalityClues；transfer→amount/note；red_packet→amount/blessing；loan_request→amount/reason；loan_decision→loanId/decision/amount；gift_purchase→amount/name/icon/description。',
          },
          content: { type: 'string', description: 'type=text 时的自然聊天正文。' },
          name: opts.stickerSearchEnabled
            ? { type: 'string', description: 'type=sticker 时的简短具体搜索词，优先英文；也可使用已知本地表情名。' }
            : { type: 'string', enum: opts.stickerNames.length ? opts.stickerNames : [''] },
          query: { type: 'string', description: 'type=image 时的完整英文画面提示。' },
          kind: { type: 'string', enum: ['selfie', 'portrait', 'scene', 'object'] },
          participants: { type: 'array', items: { type: 'string', enum: ['self', 'user'] } },
          date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          startHour: { type: 'integer', minimum: 0, maximum: 23 },
          endHour: { type: 'integer', minimum: 1, maximum: 24 },
          locationId: { type: 'string', enum: opts.locationIds.length ? opts.locationIds : [''] },
          activity: { type: 'string' },
          phoneAccess: { type: 'string', enum: ['available', 'unavailable'] },
          summary: { type: 'string' },
          durationMinutes: { type: 'integer', minimum: 5, maximum: 480 },
          amount: { type: 'integer', minimum: 1 },
          note: { type: 'string' },
          blessing: { type: 'string' },
          reason: { type: 'string' },
          loanId: { type: 'string' },
          decision: { type: 'string', enum: ['accept', 'reject'] },
          icon: { type: 'string' },
          description: { type: 'string' },
          candidateName: { type: 'string' },
          relationToRecommender: { type: 'string' },
          recommendationReason: { type: 'string' },
          shortDescription: { type: 'string' },
          gender: { type: 'string' },
          ageRange: { type: 'string' },
          occupation: { type: 'string' },
          hobbies: { type: 'array', maxItems: 6, items: { type: 'string' } },
          personalityClues: { type: 'array', maxItems: 6, items: { type: 'string' } },
        },
        required: ['type'],
      },
    },
    ...(opts.knowledgeEnabled ? {
      knowledgeQueries: { type: 'array', maxItems: 2, items: { type: 'string' }, description: '只有遇到角色确实不懂且回答前必须查清的新词或事实时填写；否则使用空数组。' },
    } : {}),
    ...commonProperties(),
  }, ['events', ...(opts.knowledgeEnabled ? ['knowledgeQueries'] : []), 'thought', 'mood'])
}

function argumentsObject(call: ChatToolCall): Record<string, unknown> | null {
  const parsed = parseJsonLoose<unknown>(call.function.arguments)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}

export function parsePrivateToolCalls(calls: ChatToolCall[]): ParsedAiTurn {
  const bubbles: AiBubble[] = []
  const knowledgeQueries: string[] = []
  const immediateActivities: ImmediateActivityAction[] = []
  const thoughts: string[] = []
  let mood: string | undefined
  for (const call of calls) {
    const args = argumentsObject(call)
    if (!args) continue
    const thought = text(args.thought, 100)
    const textualMood = text(args.mood, 20)
    if (call.function.name !== 'search_knowledge' && (!thought || !textualMood)) continue
    if (thought) thoughts.push(thought)
    if (textualMood) mood = normalizeMood(textualMood)
    if (call.function.name === 'send_text') {
      const content = text(args.content, 2_000); if (content) bubbles.push({ type: 'text', content })
    } else if (call.function.name === 'send_sticker') {
      const name = text(args.name, 100); if (name) bubbles.push({ type: 'sticker', name })
    } else if (call.function.name === 'send_image') {
      const query = text(args.query, 2_000)
      if (query) bubbles.push({ type: 'image', query, kind: ['selfie','portrait','scene','object'].includes(String(args.kind)) ? args.kind as 'selfie'|'portrait'|'scene'|'object' : undefined, participants: Array.isArray(args.participants) ? args.participants.filter((value): value is 'self'|'user' => value === 'self' || value === 'user') : undefined })
    } else if (call.function.name === 'search_knowledge') {
      const query = text(args.query, 120); if (query && knowledgeQueries.length < 2) knowledgeQueries.push(query)
    } else if (call.function.name === 'create_schedule') {
      const date = text(args.date, 10), locationId = text(args.locationId, 80), activity = text(args.activity, 16), summary = text(args.summary, 40)
      const startHour = Number(args.startHour), endHour = Number(args.endHour), phoneAccess = args.phoneAccess
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isInteger(startHour) && startHour >= 0 && startHour <= 23 && Number.isInteger(endHour) && endHour >= 1 && endHour <= 24 && startHour !== endHour && locationId && activity && summary && (phoneAccess === 'available' || phoneAccess === 'unavailable')) bubbles.push({ type: 'scheduleChange', date, startHour, endHour, location: locationId, locationId, activity, summary, phoneAccess })
    } else if (call.function.name === 'start_activity_now') {
      const locationId = text(args.locationId, 80), activity = text(args.activity, 16)
      const durationMinutes = Number(args.durationMinutes), phoneAccess = args.phoneAccess
      if (locationId && activity && Number.isInteger(durationMinutes) && durationMinutes >= 5 && durationMinutes <= 480 && (phoneAccess === 'available' || phoneAccess === 'unavailable') && immediateActivities.length === 0) {
        immediateActivities.push({ locationId, activity, durationMinutes, phoneAccess })
      }
    } else if (call.function.name === 'transfer_money') {
      const amount = positiveInteger(args.amount); if (amount) bubbles.push({ type: 'transfer', amount, note: text(args.note, 80) })
    } else if (call.function.name === 'send_red_packet') {
      const amount = positiveInteger(args.amount); if (amount) bubbles.push({ type: 'redPacket', amount, note: text(args.blessing, 80) })
    } else if (call.function.name === 'request_loan') {
      const amount = positiveInteger(args.amount); if (amount) bubbles.push({ type: 'loanRequest', amount, note: text(args.reason, 80) })
    } else if (call.function.name === 'decide_loan') {
      const amount = positiveInteger(args.amount), loanId = text(args.loanId, 100), decision = args.decision
      if (amount && loanId && (decision === 'accept' || decision === 'reject')) bubbles.push({ type: 'loanDecision', amount, loanId, decision })
    } else if (call.function.name === 'purchase_gift') {
      const amount = positiveInteger(args.amount), name = text(args.name, 30)
      if (amount && name) bubbles.push({ type: 'giftPurchase', amount, name, icon: text(args.icon, 8), description: text(args.description, 80) })
    } else if (call.function.name === 'recommend_contact') {
      const candidateName = text(args.candidateName, 40)
      const relationToRecommender = text(args.relationToRecommender, 40)
      const recommendationReason = text(args.recommendationReason, 240)
      const shortDescription = text(args.shortDescription, 300)
      const list = (value: unknown) => Array.isArray(value) ? value.map((item) => text(item, 60)).filter(Boolean).slice(0, 6) : []
      if (candidateName && relationToRecommender && recommendationReason && shortDescription) bubbles.push({
        type: 'link', app: 'contact_recommendation', label: candidateName,
        data: {
          version: 1, candidateName, relationToRecommender, recommendationReason, shortDescription,
          gender: text(args.gender, 30), ageRange: text(args.ageRange, 30), occupation: text(args.occupation, 60),
          hobbies: list(args.hobbies), personalityClues: list(args.personalityClues), status: 'pending',
        },
      })
    }
  }
  return { bubbles, knowledgeQueries, mood, thought: thoughts.join('；').slice(0, 100) || undefined, immediateActivities }
}

const PRIVATE_EVENT_TOOL_NAMES: Record<string, string> = {
  text: 'send_text', sticker: 'send_sticker', image: 'send_image', schedule: 'create_schedule',
  activity_now: 'start_activity_now', transfer: 'transfer_money', red_packet: 'send_red_packet',
  contact_recommendation: 'recommend_contact', loan_request: 'request_loan', loan_decision: 'decide_loan', gift_purchase: 'purchase_gift',
}

function parsePrivateTurnCall(call: ChatToolCall): ParsedAiTurn {
  if (call.function.name !== PRIVATE_TURN_TOOL_NAME) return { bubbles: [], knowledgeQueries: [] }
  const args = argumentsObject(call)
  if (!args || !Array.isArray(args.events)) return { bubbles: [], knowledgeQueries: [] }
  const thought = text(args.thought, 100)
  const mood = text(args.mood, 20)
  if (!thought || !mood) return { bubbles: [], knowledgeQueries: [] }
  const calls = args.events.flatMap((candidate, index): ChatToolCall[] => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const event = candidate as Record<string, unknown>
    const name = PRIVATE_EVENT_TOOL_NAMES[String(event.type)]
    if (!name) return []
    return [{
      id: `${call.id}_event_${index}`,
      type: 'function',
      function: { name, arguments: JSON.stringify({ ...event, type: undefined, thought, mood }) },
    }]
  })
  const parsed = parsePrivateToolCalls(calls)
  const queries = Array.isArray(args.knowledgeQueries)
    ? args.knowledgeQueries.map((query) => text(query, 120)).filter(Boolean).slice(0, 2)
    : []
  return { ...parsed, knowledgeQueries: queries, thought, mood: normalizeMood(mood) }
}

function privateTurnIsValid(parsed: ParsedAiTurn): boolean {
  if (parsed.knowledgeQueries.length > 0) return true
  if (parsed.bubbles.length === 0 && !parsed.immediateActivities?.length) return false
  const requiresText = !!parsed.immediateActivities?.length || parsed.bubbles.some((bubble) =>
    ['image', 'link', 'scheduleChange', 'transfer', 'redPacket', 'loanRequest', 'loanDecision', 'giftPurchase'].includes(bubble.type))
  return !requiresText || parsed.bubbles.some((bubble) => bubble.type === 'text')
}

async function fallbackCalls(opts: AgentToolOptions, raw: string, tools: ChatToolDefinition[]): Promise<ChatToolCall[]> {
  const allowed = tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }))
  const output = await chatCompletionText({
    apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.utilityModel || opts.model,
    messages: [{ role: 'system', content: `你是结构化聊天行动规划器。把主模型草稿转换为工具调用计划，不改变原意、不新增行动。心情必须用简短中文文字，禁止 emoji。只输出 JSON：{"calls":[{"name":"send_text","arguments":{}}]}。只能使用给定工具，arguments 必须符合对应参数结构。\n可用工具：${JSON.stringify(allowed)}\n主模型草稿：\n${raw}` }],
    jsonMode: true, thinking: 'disabled', temperature: 0, maxTokens: 2400, purpose: 'quality', signal: opts.signal,
    trace: { ...opts.trace, stage: 'tool_call' },
  })
  const plan = parseJsonLoose<ToolPlan>(output)
  return Array.isArray(plan?.calls) ? plan.calls.flatMap((entry, index) => {
    if (typeof entry?.name !== 'string' || !allowed.some((tool) => tool.name === entry.name) || !entry.arguments || typeof entry.arguments !== 'object') return []
    return [{ id: `fallback_${index}`, type: 'function' as const, function: { name: entry.name, arguments: JSON.stringify(entry.arguments) } }]
  }) : []
}

function actionSpeakerIndex(call: ChatToolCall): number | undefined {
  const args = argumentsObject(call)
  const speakerIndex = Number(args?.speakerIndex)
  return Number.isInteger(speakerIndex) && speakerIndex > 0 ? speakerIndex : undefined
}

async function addRequiredActionText(
  opts: AgentToolOptions,
  tools: ChatToolDefinition[],
  calls: ChatToolCall[],
  assistantContent: string,
  validate: (calls: ChatToolCall[]) => boolean,
  expectedSpeakerIndex?: number,
): Promise<ChatToolCall[]> {
  const sendText = tools.find((tool) => tool.function.name === 'send_text')
  if (!sendText) return calls
  const messages: ChatMessage[] = [
    ...opts.messages,
    { role: 'assistant', content: assistantContent, tool_calls: calls },
    ...calls.map((call): ChatMessage => ({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify({
        success: true,
        staged: true,
        message: `动作已验证并暂存，不要重复调用。现在必须用 send_text 自然回应${expectedSpeakerIndex ? `，speakerIndex 必须为 ${expectedSpeakerIndex}` : ''}。`,
      }),
    })),
  ]

  for (let round = 0; round < 2; round++) {
    const response = await chatCompletion({
      apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model, messages,
      tools: [sendText], toolChoice: { type: 'function', function: { name: 'send_text' } },
      signal: opts.signal, purpose: opts.purpose, automatic: opts.automatic,
      thinking: 'disabled', temperature: 0.65, maxTokens: 800,
      trace: { ...opts.trace, stage: 'tool_call' },
    })
    if (response.status !== 'ok') throw new Error('动作已生成，但模型没有返回配套聊天消息')
    let textCalls = (response.toolCalls ?? []).filter((call) => call.function.name === 'send_text')
    if (!textCalls.length && response.content.trim()) textCalls = await fallbackCalls(opts, response.content, [sendText])
    if (textCalls.length && validate(textCalls)) return [...textCalls, ...calls]

    const attemptedCalls = response.toolCalls ?? []
    if (attemptedCalls.length) {
      messages.push({ role: 'assistant', content: response.content, tool_calls: attemptedCalls })
      messages.push(...attemptedCalls.map((call): ChatMessage => ({
        role: 'tool', tool_call_id: call.id,
        content: JSON.stringify({ success: false, code: 'INVALID_ARGUMENTS', message: `send_text 参数无效${expectedSpeakerIndex ? `，speakerIndex 必须为 ${expectedSpeakerIndex}` : ''}，请重试。` }),
      })))
    } else {
      messages.push({ role: 'system', content: `必须调用 send_text 给出自然聊天正文${expectedSpeakerIndex ? `，speakerIndex 必须为 ${expectedSpeakerIndex}` : ''}。` })
    }
  }
  throw new Error('动作已生成，但连续两次未能生成有效的配套聊天消息')
}

async function completeGroupActionText(
  opts: AgentToolOptions & { speakerNames: string[]; memberNames: string[] },
  tools: ChatToolDefinition[],
  calls: ChatToolCall[],
  assistantContent: string,
): Promise<ChatToolCall[]> {
  let completed = calls
  const actionSpeakers = Array.from(new Set(calls
    .filter((call) => GROUP_ACTION_TOOL_NAMES.has(call.function.name))
    .map(actionSpeakerIndex)
    .filter((value): value is number => value !== undefined)))
  for (const speakerIndex of actionSpeakers) {
    const alreadyHasText = completed.some((call) => call.function.name === 'send_text' && actionSpeakerIndex(call) === speakerIndex)
    if (alreadyHasText) continue
    completed = await addRequiredActionText(opts, tools, completed, assistantContent, (textCalls) => {
      const parsed = parseGroupToolCalls(textCalls, opts.speakerNames.length, opts.memberNames.length)
      return parsed.bubbles.some((bubble) => bubble.type === 'text' && bubble.speakerIndex === speakerIndex)
    }, speakerIndex)
  }
  return completed
}

export async function generatePrivateAgentTurn(opts: AgentToolOptions): Promise<{ parsed: ParsedAiTurn; raw: string; native: boolean }> {
  const tool = privateTurnToolDefinition(opts)
  const messages = [...opts.messages]
  for (let round = 0; round < 3; round++) {
    const response = await chatCompletion({
      apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model, messages,
      tools: [tool], toolChoice: { type: 'function', function: { name: PRIVATE_TURN_TOOL_NAME } }, signal: opts.signal, purpose: opts.purpose, automatic: opts.automatic,
      thinking: 'disabled', temperature: 0.75, maxTokens: 2200, trace: opts.trace,
    })
    if (response.status !== 'ok') throw new Error('模型没有返回有效的聊天行动')
    const turnCall = (response.toolCalls ?? []).find((call) => call.function.name === PRIVATE_TURN_TOOL_NAME)
    if (turnCall) {
      const parsed = parsePrivateTurnCall(turnCall)
      if (privateTurnIsValid(parsed)) {
        return { parsed, raw: serializePrivateTurn(parsed), native: true }
      }
    }
    if (response.toolCalls?.length) {
      messages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls })
      messages.push(...response.toolCalls.map((call): ChatMessage => ({
        role: 'tool', tool_call_id: call.id,
        content: JSON.stringify({ success: false, code: 'INVALID_TURN', message: '整轮参数无效。图片或行动存在时，events 整体必须至少包含一条自然 text；请一次性重新提交完整 submit_turn，不要只补一条消息。' }),
      })))
    } else {
      messages.push({ role: 'assistant', content: response.content })
      messages.push({ role: 'system', content: '没有收到原生 submit_turn 工具调用。必须调用 submit_turn 一次性提交完整回复，禁止在普通 content 中输出 JSON。' })
    }
  }
  throw new Error('模型连续返回了无效的整轮工具参数')
}

export function groupChatTools(speakerNames: string[], memberNames: string[], base: ReturnType<typeof privateChatTools>): ChatToolDefinition[] {
  const allowed = new Set(['send_text', 'send_sticker', 'send_image', 'search_knowledge', 'create_schedule'])
  return base.filter((tool) => allowed.has(tool.function.name)).map((tool) => {
    if (tool.function.name === 'search_knowledge') return tool
    const parameters = tool.function.parameters as { properties: Record<string, unknown>; required: string[] }
    const properties = { ...parameters.properties }
    let required = [...parameters.required]
    if (tool.function.name === 'send_image') {
      delete properties.participants
      properties.kind = { type: 'string', enum: ['selfie', 'portrait', 'group', 'scene', 'object'] }
      properties.participantIndexes = { type: 'array', items: { type: 'integer', minimum: 1, maximum: memberNames.length }, description: `画面中出现的完整群成员索引：${memberNames.map((name, index) => `${index + 1}=${name}`).join('，')}。纯场景或物品使用空数组。` }
      properties.includeUser = { type: 'boolean', description: '画面中是否出现用户本人。' }
      required = required.filter((name) => name !== 'participants').concat(['participantIndexes', 'includeUser'])
    }
    return fn(tool.function.name, tool.function.description, {
      speakerIndex: { type: 'integer', minimum: 1, maximum: speakerNames.length, description: speakerNames.map((name, index) => `${index + 1}=${name}`).join('，') },
      ...properties,
    }, ['speakerIndex', ...required])
  })
}

export function parseGroupToolCalls(calls: ChatToolCall[], speakerCount: number, memberCount = speakerCount): { bubbles: GroupAiBubble[]; knowledgeQueries: string[]; turnSummary: string; planCandidates: [] } {
  const bubbles: GroupAiBubble[] = []
  const knowledgeQueries: string[] = []
  for (const call of calls) {
    const args = argumentsObject(call)
    if (!args) continue
    if (call.function.name === 'search_knowledge') {
      const query = text(args.query, 120); if (query && knowledgeQueries.length < 2) knowledgeQueries.push(query)
      continue
    }
    const speakerIndex = Number(args.speakerIndex)
    if (!Number.isInteger(speakerIndex) || speakerIndex < 1 || speakerIndex > speakerCount) continue
    const thought = text(args.thought, 100), textualMood = text(args.mood, 20)
    if (!thought || !textualMood) continue
    const common = { speakerIndex, thought, mood: normalizeMood(textualMood) }
    if (call.function.name === 'send_text') { const content = text(args.content, 2_000); if (content) bubbles.push({ ...common, type: 'text', content }) }
    else if (call.function.name === 'send_sticker') { const name = text(args.name, 100); if (name) bubbles.push({ ...common, type: 'sticker', name }) }
    else if (call.function.name === 'send_image') { const query = text(args.query, 2_000); if (query) bubbles.push({ ...common, type: 'image', query, kind: ['selfie','portrait','group','scene','object'].includes(String(args.kind)) ? args.kind as any : undefined, participantIndexes: Array.isArray(args.participantIndexes) ? Array.from(new Set(args.participantIndexes.map(Number).filter((index) => Number.isInteger(index) && index >= 1 && index <= memberCount))) : [speakerIndex], includeUser: args.includeUser === true }) }
    else if (call.function.name === 'create_schedule') {
      const privateParsed = parsePrivateToolCalls([{ ...call, function: { ...call.function, arguments: JSON.stringify({ ...args, speakerIndex: undefined }) } }])
      const schedule = privateParsed.bubbles.find((bubble) => bubble.type === 'scheduleChange')
      if (schedule?.type === 'scheduleChange') bubbles.push({ ...common, ...schedule })
    }
  }
  return { bubbles, knowledgeQueries, turnSummary: bubbles.map((bubble) => bubble.type === 'text' ? bubble.content : bubble.type).join(' ').slice(0, 160), planCandidates: [] }
}

export async function generateGroupAgentTurn(opts: AgentToolOptions & { speakerNames: string[]; memberNames: string[]; messageBounds: { min: number; max: number } }): Promise<{ parsed: ReturnType<typeof parseGroupToolCalls>; raw: string; native: boolean }> {
  const base = privateChatTools(opts)
  const tools = groupChatTools(opts.speakerNames, opts.memberNames, base)
  const messages = [...opts.messages]
  let accepted: ChatToolCall[] = []
  for (let round = 0; round < 3; round++) {
    const response = await chatCompletion({ ...opts, messages, tools, toolChoice: 'required', thinking: 'disabled', temperature: 0.8, maxTokens: 3000 })
    if (response.status !== 'ok') throw new Error('模型没有返回有效的群聊行动')
    const nativeCalls = response.toolCalls ?? []
    if (!nativeCalls.length) {
      const fallback = await fallbackCalls(opts, response.content, tools)
      const calls = await completeGroupActionText(opts, tools, fallback, response.content)
      const parsed = parseGroupToolCalls(calls, opts.speakerNames.length, opts.memberNames.length)
      if (parsed.bubbles.length < opts.messageBounds.min || parsed.bubbles.length > opts.messageBounds.max) {
        throw new Error(`群聊消息量不符合${opts.messageBounds.min}-${opts.messageBounds.max}条的硬约束`)
      }
      return { parsed, raw: JSON.stringify({ messages: parsed.bubbles, turnSummary: parsed.turnSummary, knowledgeQueries: parsed.knowledgeQueries, planCandidates: [] }), native: false }
    }
    const invalid = nativeCalls.filter((call) => {
      const parsed = parseGroupToolCalls([call], opts.speakerNames.length, opts.memberNames.length)
      return parsed.bubbles.length === 0 && parsed.knowledgeQueries.length === 0
    })
    accepted.push(...nativeCalls.filter((call) => !invalid.includes(call)))
    if (!invalid.length) {
      const staged = parseGroupToolCalls(accepted, opts.speakerNames.length, opts.memberNames.length)
      if (staged.bubbles.length > opts.messageBounds.max) {
        let bubbleCount = 0
        accepted = accepted.filter((call) => {
          const createsBubble = parseGroupToolCalls([call], opts.speakerNames.length, opts.memberNames.length).bubbles.length > 0
          if (!createsBubble) return true
          bubbleCount += 1
          return bubbleCount <= opts.messageBounds.max
        })
        break
      }
      if (staged.bubbles.length >= opts.messageBounds.min) break
      messages.push({ role: 'assistant', content: response.content, tool_calls: nativeCalls })
      messages.push(...nativeCalls.map((call): ChatMessage => ({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: true, staged: true, message: '已暂存，不要重复。' }) })))
      messages.push({ role: 'system', content: `整轮必须有${opts.messageBounds.min}到${opts.messageBounds.max}条实际消息，目前只有${staged.bubbles.length}条。继续调用消息工具补足，保持自然，不要重复已暂存内容。` })
      continue
    }
    messages.push({ role: 'assistant', content: response.content, tool_calls: nativeCalls })
    for (const call of nativeCalls) messages.push({ role: 'tool', tool_call_id: call.id, content: invalid.includes(call) ? JSON.stringify({ success: false, code: 'INVALID_ARGUMENTS', message: 'speakerIndex、参数、thought 或中文文字 mood 无效；只重试失败调用。' }) : JSON.stringify({ success: true, staged: true, message: '已暂存，不要重复。' }) })
  }
  const completed = await completeGroupActionText(opts, tools, accepted, '')
  const parsed = parseGroupToolCalls(completed, opts.speakerNames.length, opts.memberNames.length)
  if (!parsed.bubbles.length && !parsed.knowledgeQueries.length) throw new Error('模型连续返回了无效的群聊工具参数')
  if (parsed.bubbles.length < opts.messageBounds.min || parsed.bubbles.length > opts.messageBounds.max) throw new Error(`群聊消息量不符合${opts.messageBounds.min}-${opts.messageBounds.max}条的硬约束`)
  return { parsed, raw: JSON.stringify({ messages: parsed.bubbles, turnSummary: parsed.turnSummary, knowledgeQueries: parsed.knowledgeQueries, planCandidates: [] }), native: true }
}
