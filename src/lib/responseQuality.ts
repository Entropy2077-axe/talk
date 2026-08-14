import { chatCompletionText as chatCompletion } from './deepseek'
import { displayName } from './contact'
import { activeUpcomingPlansText } from './memory'
import { describeCurrentSchedule, describeUpcomingScheduleText } from './schedule'
import type { AdminAiTraceStage, AiBubble, AppSettings, Contact, GroupAiBubble, GroupEnergyLevel } from '../types'

interface QualityResult {
  valid: boolean
  reason: string
  fixedRaw?: string
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed
}

function parseQualityResult(raw: string): QualityResult | null {
  try {
    const parsed = JSON.parse(raw.trim())
    if (!parsed || typeof parsed !== 'object') return null
    return {
      valid: parsed.valid === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 120) : '',
      fixedRaw: typeof parsed.fixedRaw === 'string' && parsed.fixedRaw.trim() ? parsed.fixedRaw.trim() : undefined,
    }
  } catch {
    return null
  }
}

/**
 * The mandatory middle stage for normal chat turns.  The reviewer receives
 * the exact master prompt and draft, but may only return a replacement in the
 * same raw protocol – it never gets authority to invent a different format.
 */
/** Insert executable markers after the main model has written natural prose. */
export async function insertToolCallsIntoRawTurn(opts: {
  settings: AppSettings
  rawDraft: string
  recentContext: string
  locationContext?: string
  scene: 'private' | 'group'
  imageGenerationEnabled?: boolean
  trace: { turnId: string; conversationId: string }
  signal?: AbortSignal
}): Promise<{ raw: string; changed: boolean }> {
  const prompt = `You are the tool-call insertion stage. The main model has already written the reply. Preserve its wording, order, speaker labels, punctuation, paragraphs, and tone exactly. Only insert executable markers; never rewrite, summarize, explain, output JSON, or add a wrapper.

One reply may contain zero, one, or multiple tool calls. It may contain multiple calls of the same kind and may mix different kinds, such as a sticker followed by an image and a schedule action. Insert every clearly established tool call in the correct position and preserve their order. If no tool is clearly needed, insert no marker at all and return the reply unchanged. Never force a tool call merely to use the available tools.

Allowed markers and their exact downstream JSON mapping:
- [sticker:exact sticker name or concise search query]
- [image:English image prompt:caption]. Downstream JSON MUST be {"type":"image","query":"English image prompt","caption":"caption"}; never use content, text, prompt, or imagePrompt for the image prompt. When image generation is available, the English prompt must be at least 100 words and specify subject, setting, clothing, action, composition, camera, lighting, colors, materials, and mood.
- [schedule:date=YYYY-MM-DD;startHour=0-23;endHour=1-24;locationId=known-location-id;activity=activity;phoneAccess=available|unavailable;summary=summary]
- [location:locationId=known-location-id;summary=short summary]
- [knowledge:search query]
- [transfer:amount:note], [redPacket:amount:blessing], [loanRequest:amount:reason], [loanDecision:loanId:accept|reject:amount], [giftPurchase:price:item:emoji:description]
Downstream JSON MUST use {"type":"sticker","name":"sticker name or search query"} for sticker markers; never use content or text for sticker names. A marker is not visible text. Text messages alone use {"type":"text","content":"..."}.
Never guess IDs, dates, hours, amounts, or other missing fields. Do not add a marker unless the current reply and context clearly establish the action.

Location and special-task facts:
${opts.locationContext || '(no location/special-task context supplied)'}
For a real agreed schedule or special task, insert exactly one complete [schedule:...] marker only after the reply clearly agrees to it. The marker must copy date, startHour, endHour, locationId, activity, phoneAccess, and summary from established facts; never fill a missing field. locationId must be copied exactly from the legal location list. A discussion, question, refusal, conditional possibility, or vague future idea is not an executable schedule call. Do not expose system wording or location IDs in the visible prose.

Scene: ${opts.scene}
Image generation available: ${opts.imageGenerationEnabled ? 'yes' : 'no'}
Recent turns:
${opts.recentContext || '(none)'}

Current main-model reply:
${opts.rawDraft}

Return the complete reply text with only necessary markers inserted. If no tool is clearly requested, return it unchanged.`
  const raw = await chatCompletion({
    apiKey: opts.settings.apiKey, baseUrl: opts.settings.baseUrl,
    model: opts.settings.utilityModel || opts.settings.model,
    messages: [{ role: 'system', content: prompt }], jsonMode: false,
    thinking: 'disabled', temperature: 0,
    maxTokens: Math.max(1200, Math.min(3000, opts.rawDraft.length * 3)),
    purpose: 'quality', signal: opts.signal,
    trace: { turnId: opts.trace.turnId, stage: 'tool_call', conversationId: opts.trace.conversationId },
  })
  const cleaned = raw.trim()
  if (!cleaned) throw new Error('工具调用模型没有返回文本')
  return { raw: cleaned, changed: cleaned !== opts.rawDraft.trim() }
}

export async function auditAndRepairRawTurn(opts: {
  settings: AppSettings
  masterPrompt: string
  rawDraft: string
  scene: 'private' | 'group'
  regenerationInstruction?: string
  signal?: AbortSignal
  trace: { turnId: string; conversationId: string }
}): Promise<{ raw: string; repaired: boolean; reason: string }> {
  const protocol = `The input is natural prose, not a line-by-line protocol. Preserve every sentence and paragraph in order. Convert tool markers mechanically: [sticker:...] to a sticker message; [image:English prompt:caption] to an image message; [schedule:...] to scheduleChange with exactly the supplied fields; [knowledge:...] to knowledgeQueries and remove it from visible text; finance markers to their corresponding message types. A scheduleChange JSON message MUST contain date, startHour, endHour, locationId, activity, phoneAccess, and summary copied from the marker; never put these fields in content and never invent missing values. For group replies, retain existing speaker labels when present and map them to speakerIndex.`
  // Put the draft in the highest-authority message and before the long master
  // prompt. The reviewer must inspect what was actually written, rather than
  // merely remembering the requested format after a large context window.
  const jsonSchema = opts.scene === 'group'
    ? '{"messages":[{"speakerIndex":1,"speakerName":"...","type":"text","content":"...","thought":"...","mood":"..."},{"speakerIndex":1,"type":"sticker","name":"表情包名称或搜索词"},{"speakerIndex":1,"type":"image","query":"English image prompt","caption":"配文","kind":"selfie|portrait|group|scene|object","participantIndexes":[1],"includeUser":false}],"turnSummary":"...","knowledgeQueries":[],"planCandidates":[]}'
    : '{"messages":[{"type":"text","content":"..."},{"type":"sticker","name":"表情包名称或搜索词"},{"type":"image","query":"English image prompt","caption":"配文","scene":"...","kind":"selfie|portrait|scene|object","participants":["self"]}],"mood":"...","thought":"...","knowledgeQueries":[]}'
  const prompt = `【待审核原文｜必须逐行核对，优先阅读】
${opts.rawDraft}

You are the mandatory format auditor and JSON translator for a roleplay reply. Output JSON only: {"valid":true|false,"reason":"short","fixedRaw":"JSON string"}.
The natural prose itself is valid input. Do not reject it for lacking thought, mood, speakerIndex, JSON, or a line protocol.
Immutable output protocol:
${protocol}
The fixedRaw field must ALWAYS contain the complete final chat JSON object as a JSON-escaped string, even when valid=true. Its required shape is:
${jsonSchema}
Executable markers such as [sticker:...], [image:...:...], [knowledge:...], and [schedule:...] must be converted to their corresponding JSON message types, not shown to the user. IMPORTANT: a sticker message MUST use type="sticker" and put the exact sticker name or search query in the string field name. Never put a sticker name in content or text; content is only for type="text". Every sticker marker becomes its own messages item, and multiple sticker markers become multiple sticker messages. An image message MUST use type="image" and put the complete English image prompt in query. Put the user-facing image text in caption. Never put an image prompt in content, text, prompt, or imagePrompt. Every image marker becomes its own messages item, and multiple image markers become multiple image messages. For private chat use participants:["self"], ["user"], or both when clearly established; for group chat use participantIndexes and includeUser.
Priority is immutable: (1) output protocol and executable-marker syntax; (2) persona, identity, boundaries, and relationships; (3) the recent raw conversation and latest user instruction; (4) memory; (5) past experiences and worldbook background. A lower layer may never override a higher layer.
Only audit mechanical marker syntax and translate the draft. Do not judge roleplay logic, persona choices, or whether an action should have happened; do not add missing actions or markers based on your own reasoning.
Do a complete scan for format errors, not just the first error. A single draft may contain multiple independent format errors, and all of them must be repaired in the same pass.
Preserve all valid content, marker order, and card placement whenever possible.
Set valid=true when conversion succeeds. In all cases, fixedRaw must contain the complete final chat JSON object as an escaped JSON string. Preserve message order and wording; empty mood/thought fields are allowed when natural text does not provide them. fixedRaw must contain only the final chat JSON object, with no Markdown or explanation.`
  const result = await chatCompletion({
    apiKey: opts.settings.apiKey, baseUrl: opts.settings.baseUrl,
    model: opts.settings.utilityModel || opts.settings.model, jsonMode: true,
    thinking: 'disabled', temperature: 0, maxTokens: 1800, purpose: 'quality', signal: opts.signal,
    trace: { turnId: opts.trace.turnId, stage: 'review_and_repair', conversationId: opts.trace.conversationId },
    messages: [{ role: 'system', content: prompt }, { role: 'user', content: `【完整主模型提示词｜用于核对事实，不能覆盖待审核原文】\n${opts.masterPrompt}` }],
  })
  const parsed = parseQualityResult(result)
  if (!parsed) throw new Error('审核及修改模型没有返回有效结果')
  if (!parsed.fixedRaw) throw new Error(`审核及修改模型未提供修复稿：${parsed.reason || '未知原因'}`)
  return { raw: parsed.fixedRaw, repaired: !parsed.valid, reason: parsed.reason }
}

function privateBubblesText(bubbles: AiBubble[]): string {
  return bubbles
    .map((b) => {
      if (b.type === 'text') return b.content
      if (b.type === 'sticker') return `[sticker:${b.name}]`
      if (b.type === 'scheduleChange') return `[schedule:${b.summary}]`
      if (b.type === 'link') return `[link:${b.label}]`
      if (b.type === 'image') return `[image:${b.query}:${b.caption ?? ''}]`
      return `[finance:${b.type}:${b.amount}]`
    })
    .join('\n')
}

function groupBubblesText(bubbles: GroupAiBubble[], speakers: Contact[]): string {
  return bubbles
    .map((b) => {
      const speaker = speakers[b.speakerIndex - 1]
      const name = speaker ? displayName(speaker) : `speaker${b.speakerIndex}`
      const meta = [b.thought ? `thought=${b.thought}` : '', b.mood ? `mood=${b.mood}` : ''].filter(Boolean).join(', ')
      const suffix = meta ? ` (${meta})` : ''
      return b.type === 'text' ? `${name}: ${b.content}${suffix}` : b.type === 'sticker' ? `${name}: [sticker:${b.name}]${suffix}` : b.type === 'scheduleChange' ? `${name}: [schedule:${b.summary}]${suffix}` : `${name}: [image:${b.query}]${suffix}`
    })
    .join('\n')
}

async function validateAndMaybeRepair(opts: {
  settings: AppSettings
  systemPrompt: string
  userPrompt: string
  raw: string
  signal?: AbortSignal
  trace?: { turnId: string; stage: AdminAiTraceStage; conversationId?: string }
}): Promise<{ raw: string; repaired: boolean; reason?: string; detectedInvalid?: boolean }> {
  try {
    const judged = await chatCompletion({
      apiKey: opts.settings.apiKey,
      baseUrl: opts.settings.baseUrl,
      model: opts.settings.utilityModel || opts.settings.model,
      jsonMode: true,
      signal: opts.signal,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userPrompt },
      ],
      purpose: 'quality',
      trace: opts.trace,
    })
    const result = parseQualityResult(judged)
    if (!result) {
      return { raw: opts.raw, repaired: false }
    }
    if (result.valid) return { raw: opts.raw, repaired: false }
    if (!result.fixedRaw) {
      const reason = result.reason || 'invalid_without_fixedRaw'
      console.warn('[quality] 判定无效但未提供fixedRaw，原样放行', reason)
      return { raw: opts.raw, repaired: false, reason, detectedInvalid: true }
    }
    return { raw: result.fixedRaw, repaired: true, reason: result.reason }
  } catch {
    return { raw: opts.raw, repaired: false }
  }
}

export async function validatePrivateTurn(opts: {
  settings: AppSettings
  contact: Contact
  latestUserText: string
  recentConversationText?: string
  sharedRecentContext?: string
  raw: string
  bubbles: AiBubble[]
  worldbookText?: string
  signal?: AbortSignal
  trace?: { turnId: string; stage: AdminAiTraceStage; conversationId?: string }
}): Promise<{ raw: string; repaired: boolean; reason?: string; detectedInvalid?: boolean }> {
  const name = displayName(opts.contact)
  const now = new Date()
  const currentSchedule = describeCurrentSchedule(opts.contact, now)
  const upcomingSchedule = describeUpcomingScheduleText(opts.contact, now)
  const upcomingPlans = activeUpcomingPlansText(opts.contact, now)
  const activeMood = opts.contact.mood?.text && Date.now() < opts.contact.mood.expiresAt ? opts.contact.mood.text : ''
  const worldbookInfo = opts.worldbookText ? `\nWorldbook (canon world rules — content consistent with these is NOT "invented facts", it is legitimate world-building):\n${opts.worldbookText}` : ''
  const systemPrompt = `You are a strict roleplay response reviewer. Output JSON only: {"valid":true/false,"reason":"short","fixedRaw":"optional"}.
Mandatory primary check: logical grounding. Decide whether the reply's inference is tightly supported by its premises: persona/identity, memory, relationship, mood, location, schedule/plans, recent events,${opts.worldbookText ? ' worldbook (see user prompt),' : ''} and the latest user message.
Then check: (1) reply fits persona and personality trait, (2) never violates user-authored persona constraints, (3) answers user, (4) no invented facts — BUT worldbook entries define canonical world rules; content grounded in an active worldbook entry is NOT "invented" even if it seems fantastical, (5) mood/thought are present. A trait may be subtle, but a reply that directly contradicts its behavioral anchor is invalid.
Treat persona adherence as a logical validity requirement, not a style preference. When facts allow more than one reply, the selected reply must be the one this particular persona would naturally choose. Reject a generic, flattened response if the unified persona should materially affect motivation, tone, initiative, or emotional reaction in this situation.
If the prose feels good but the premise→reply logic is weak, unsupported, contradictory, or loosely associated, it is invalid.
If valid, return valid=true.
If invalid, rewrite as fixedRaw. Must include mood and thought: {"messages":[{"type":"text","content":"..."}],"mood":"15字情绪","thought":"30字内心想法 和嘴上说的不一样"}. Keep it short.`
  const strictContinuityPrompt = `Extra invalid cases:
- The user is questioning/correcting the assistant, but the reply ignores that and continues an old bit.
- The reply confuses the persona's own identity with a third party mentioned in chat, such as acting as if "teacher" is the persona when the persona is not a teacher.
- The reply invents concrete scenes like class, teacher, classroom, offline meetings, prior promises, or past events that are not supported by persona/memory/latest message${opts.worldbookText ? ' or worldbook entries' : ''}.
- The reply tries to forcibly rationalize a previous mistake instead of naturally clarifying it.
- Logical incoherence: wrong reference resolution, wrong cause/effect, contradictory timeline, contradicting the user's correction, answering a different question, or treating a joke/metaphor as literal without evidence.
- If the user asks "why/what/are you X/did X happen", the reply must directly resolve that logical question before adding emotion or banter.
- Pragmatic/humor failure: if context asks for a specific answer and the user gives an over-broad, tautological, deliberately literal, or absurd answer, treat it as likely humor unless the user sounds distressed. Example: assistant asks "what do you want to eat?", user says "I want to eat rice/food" instead of a dish; a good reply catches the joke or teases lightly, not a literal nutrition/meal-planning response.
- If the user is joking, the reply should acknowledge the joke first, then optionally continue the topic.
- Repetition failure: reject a reply that keeps escalating, rephrasing, or re-selling the same request, object, joke, or proposal from the recent conversation (for example repeatedly asking the user to buy ice cream in slightly different quantities) when the user did not explicitly continue that topic. Rewrite by answering the newest message and moving naturally onward.
- State-transition confirmation failure: when a later record clearly replaces an earlier state (for example “我要睡了” followed by “我决定不睡了，起来喝咖啡”), treat the later state as settled. Reject a reply that merely repeats it as a confirmation question such as “你不睡了？” or “你起来了？”, unless the records genuinely conflict or the user sounded uncertain. If the newest message is an invitation/question/request, answer that first and weave continuity in naturally instead of proving that you remember it.
When rewriting, answer the latest user message first, keep it short, and admit a mistake naturally if needed.`
  const userPrompt = `Persona name: ${name}
Persona: ${truncate(opts.contact.systemPrompt || '', 700)}
Unified persona: ${truncate(opts.contact.systemPrompt || '(none)', 1200)}
Relationship: ${opts.contact.relationshipBase || '朋友'} ${truncate(opts.contact.relationshipDynamic || '', 160)}
Memory/style: ${truncate(opts.contact.memoryStyle || opts.contact.memoryFacts || '', 260)}
Current mood: ${activeMood || '(none)'}
Current schedule/location: ${currentSchedule || '(none)'}
Upcoming schedule: ${upcomingSchedule || '(none)'}
Plans with user: ${upcomingPlans || '(none)'}
Recent conversation:
${truncate(opts.recentConversationText || '(none)', 1200)}
Cross-scene recent original records (ground truth; private lines must not be leaked publicly):
${truncate(opts.sharedRecentContext || '(none)', 5000)}
Latest user message: ${truncate(opts.latestUserText || '(background event)', 500)}
Assistant rendered reply:
${truncate(privateBubblesText(opts.bubbles), 900)}
Raw assistant protocol:
${truncate(opts.raw, 1200)}${worldbookInfo}`

  return validateAndMaybeRepair({
    settings: opts.settings,
    systemPrompt: `${systemPrompt}\n${strictContinuityPrompt}`,
    userPrompt,
    raw: opts.raw,
    signal: opts.signal,
    trace: opts.trace,
  })
}

export async function validateGroupTurn(opts: {
  settings: AppSettings
  groupName: string
  speakers: Contact[]
  targetedContext: string
  sharedRecentContext?: string
  raw: string
  bubbles: GroupAiBubble[]
  worldbookText?: string
  signal?: AbortSignal
  trace?: { turnId: string; stage: AdminAiTraceStage; conversationId?: string }
}): Promise<{ raw: string; repaired: boolean; reason?: string; detectedInvalid?: boolean }> {
  const speakerText = opts.speakers
    .map((speaker, i) => `${i + 1}. ${displayName(speaker)}: ${truncate(speaker.systemPrompt || '', 260)}`)
    .join('\n')
  const worldbookInfo = opts.worldbookText ? `\nActive worldbook entries (canon world rules — content consistent with these is NOT "invented facts"):
${opts.worldbookText}` : ''
  const systemPrompt = `You are a strict group-chat response reviewer. Output JSON only: {"valid":true/false,"reason":"short","fixedRaw":"optional"}.
Judge whether each speaker follows their persona, the reply handles @mentions/replies, and the scene remains a natural group chat rather than several private replies to the user.
Treat a later explicit state as replacing an earlier one. A speaker must not repeat an already-settled transition as “你不睡了？”/“你起来了？” merely to show memory; answer the newest invitation, question, or request first unless the timeline is genuinely contradictory or uncertain.
The unified persona is a hard logical premise for every speaker: reject a speaker whose response could be factually possible but is generic or contradicts that persona. In any plausible alternative, require the response that best reflects that speaker's distinctive personality without inventing facts.
Also check the protocol: speakerIndex must be one of the listed speakers; content must not contain leaked <name>, speaker-name prefixes, parenthesized thoughts, bracketed moods, or wrapping quotes; every message must include non-empty thought and mood, and they must not leak into content.${opts.worldbookText ? ' Content grounded in an active worldbook entry is NOT "invented facts" — worldbook defines canon world rules.' : ''}
If valid, return valid=true and omit fixedRaw.
If invalid, rewrite fixedRaw using this exact protocol JSON: {"messages":[{"speakerIndex":1,"speakerName":"...","type":"text","content":"...","thought":"...","mood":"..."}],"turnSummary":"...","knowledgeQueries":[]}. Only use listed speakerIndex values. Keep it short.`
  const userPrompt = `Group: ${opts.groupName}
Speakers:
${speakerText}
Target context:
${truncate(opts.targetedContext || '(none)', 500)}
Cross-scene recent original records (ground truth; private lines must not be leaked publicly):
${truncate(opts.sharedRecentContext || '(none)', 5000)}
Assistant rendered reply:
${truncate(groupBubblesText(opts.bubbles, opts.speakers), 900)}
Raw assistant protocol:
${truncate(opts.raw, 1200)}${worldbookInfo}`

  return validateAndMaybeRepair({
    settings: opts.settings,
    systemPrompt,
    userPrompt,
    raw: opts.raw,
    signal: opts.signal,
    trace: opts.trace,
  })
}

export async function validateGroupDraft(opts: {
  settings: AppSettings
  groupName: string
  speakers: Contact[]
  rawText: string
  energyLevel: GroupEnergyLevel
  targetedContext: string
  sharedRecentContext?: string
  worldbookText?: string
  signal?: AbortSignal
  trace?: { turnId: string; stage: AdminAiTraceStage; conversationId?: string }
}): Promise<{ valid: boolean; reason?: string }> {
  const speakerText = opts.speakers.map((speaker, i) => `${i + 1}. ${displayName(speaker)}`).join('\n')
  const energyRule =
    opts.energyLevel === 'cold'
      ? '冷淡: 整轮应有1到3句话。'
      : opts.energyLevel === 'lively'
        ? '热闹: 整轮应有6到12句话，可以多次穿插发言。'
        : '普通: 整轮应有3到7句话。'
  const chatterRule = opts.speakers.length >= 2
    ? '群成员始终允许自然互相接话；不能为了满足规则而强行点名或接话。'
    : '本轮只有一位AI发言人，不要求AI之间互动。'

  try {
    const judged = await chatCompletion({
      apiKey: opts.settings.apiKey,
      baseUrl: opts.settings.baseUrl,
      model: opts.settings.utilityModel || opts.settings.model,
      jsonMode: true,
      signal: opts.signal,
      messages: [
        {
          role: 'system',
          content: `你是严格的群聊主模型草稿校验器。只输出JSON: {"valid":true/false,"reason":"short"}。

检查对象是主模型尚未转换成JSON的群聊纯文本草稿。

必须检查:
1. 每一行是否严格类似 <人名>（想法）[心情]“消息内容”，且草稿第一行是否直接从 < 开始，没有解释、标题、编号、JSON或Markdown。
2. 每一行是否都有非空“想法”和“心情”，括号是否为中文全角圆括号（），心情是否为半角方括号[]，消息是否为中文弯引号“”。
3. 人名是否只来自本轮发言人。
4. 是否符合群聊热闹程度: ${energyRule}
5. 群成员是否能自然接话、且没有机械地只围绕用户重复表态: ${chatterRule}
6. 发言顺序是否自然，允许同一人多次插入，不要求按发言人顺序轮流。
7. 草稿是否像真实群聊，而不是每个人机械回答用户。
8. 草稿是否过度复读同一个特殊词、梗、比喻、称号或外号；如果多名AI都围绕同一个词解释/吐槽/复述，应判为无效。
9. 草稿是否有话题推进；如果同一个梗已经被反复接住，除非用户明确继续问这个梗，否则应该收束或自然转到相邻话题。
10. 每位发言人是否把统一人设当作逻辑前提；如果事实允许多种回应，是否选择了最符合该角色的反应，而非泛化的普通聊天口吻。违反即无效。

只要违反任一必需规则，就 valid=false，并用一句话指出最重要的问题。${opts.worldbookText ? `\n\n注意：以下世界书条目定义了这个世界的规则。草稿中符合世界书设定的内容不属于"编造"或"偏离人设"，是合理的世界构建。\n世界书：\n${opts.worldbookText}` : ''}`,
        },
        {
          role: 'user',
          content: `群名: ${opts.groupName}
本轮发言人:
${speakerText}

定向上下文:
${truncate(opts.targetedContext || '(none)', 600)}

近期跨场景原文（事实依据；私聊内容不得在群聊泄露）:
${truncate(opts.sharedRecentContext || '(none)', 5000)}

草稿:
${truncate(opts.rawText, 3000)}`,
        },
      ],
      purpose: 'quality',
      trace: opts.trace,
    })
    const result = parseQualityResult(judged)
    if (!result) return { valid: true }
    return { valid: result.valid, reason: result.reason || undefined }
  } catch {
    return { valid: true }
  }
}
