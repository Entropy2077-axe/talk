import { db } from '../db/db'
import { extractJsonObject, parseKnowledgeQueriesField } from './aiProtocol'
import { activeUpcomingPlansText } from './memory'
import { customPersonalityTraitsLine, formatPersonaProfile, formatSpeechSamplesForScene, personalityTraitLine } from './prompt'
import { describeCurrentSchedule } from './schedule'
import { isModuleEnabled } from '../features'
import type { Contact, GroupAiBubble, GroupAiResponse, GroupEnergyLevel, GroupSpeakerLimit } from '../types'
import { dynamicRelationScore } from './contactRelations'
import { normalizeMood } from './mood'

/** Group chats can cap how many members answer per turn; see pickSpeakers. */
const DEFAULT_GROUP_SPEAKER_LIMIT: GroupSpeakerLimit = 3

/** Warmer contacts get picked to speak more often (also reused by proactiveChat.ts). */
export function relationshipWeight(warmth: number): number {
  if (!isModuleEnabled('relationship')) return 1 // uniform when 好感度 disabled
  return Math.max(1, (warmth + 100) / 2)
}

export function weightedSampleWithoutReplacement(contacts: Contact[], k: number): Contact[] {
  const pool = contacts.map((c) => ({ c, w: relationshipWeight(c.warmth ?? 0) }))
  const picked: Contact[] = []
  while (picked.length < k && pool.length > 0) {
    const total = pool.reduce((sum, p) => sum + p.w, 0)
    let r = Math.random() * total
    let idx = pool.length - 1
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w
      if (r <= 0) {
        idx = i
        break
      }
    }
    picked.push(pool[idx].c)
    pool.splice(idx, 1)
  }
  return picked
}

/**
 * Who answers this round, decided entirely in code (per the user's spec),
 * not left to the model. Mentioned/replied-to members are preferred, then
 * the remaining slots are filled by relationship-weighted sampling.
 */
export function pickSpeakers(
  members: Contact[],
  preferredContactIds: string[] = [],
  speakerLimit: GroupSpeakerLimit = DEFAULT_GROUP_SPEAKER_LIMIT,
): Contact[] {
  const preferredIds = new Set(preferredContactIds)
  const preferred = members.filter((m) => preferredIds.has(m.id))
  const limit = speakerLimit === 'all' ? members.length : Math.min(speakerLimit, members.length)
  if (limit >= members.length) {
    const preferredSet = new Set(preferred.map((m) => m.id))
    return [...preferred, ...members.filter((m) => !preferredSet.has(m.id))]
  }

  const picked = preferred.slice(0, limit)
  if (picked.length >= limit) return picked

  const pickedIds = new Set(picked.map((m) => m.id))
  const rest = members.filter((m) => !pickedIds.has(m.id))
  return [...picked, ...weightedSampleWithoutReplacement(rest, limit - picked.length)]
}

export function groupTypingDelayMs(bubble: GroupAiBubble): number {
  if (bubble.type === 'text') return Math.min(300 + bubble.content.length * 80, 3500)
  return 500
}

/**
 * The model occasionally bakes a "某某: " name prefix into a text bubble's
 * own content, mimicking the "名字: 内容" format used to label speakers in
 * the history it's fed (see groupChatEngine.ts's history mapping) — same
 * mimicry-of-a-compression-format failure mode as the 1:1 commission
 * bracket leak (see aiProtocol.ts's recoverLeakedBubbles). A prompt
 * instruction alone didn't reliably stop it there either, so this strips
 * any leading "<known member name>: " prefix structurally, regardless of
 * whether the name matches the bubble's actual speakerIndex — the visible
 * name label above the bubble already comes from speakerIndex and is
 * always correct, so a baked-in prefix is redundant at best and shows the
 * wrong name at worst.
 */
export function stripSpeakerNamePrefix(content: string, memberNames: string[]): string {
  for (const name of memberNames) {
    if (!name) continue
    const prefix = content.startsWith(`${name}:`)
      ? `${name}:`
      : content.startsWith(`${name}：`)
        ? `${name}：`
        : null
    if (prefix) return content.slice(prefix.length).trim()
  }
  return content
}

export function buildGroupSystemPrompt(opts: {
  stylePrompt: string
  groupName: string
  allMembers: Contact[]
  speakers: Contact[]
  stickerNames: string[]
  currentTimeText: string
  userProfileText: string
  targetedContextText?: string
  recentEventsText?: string
  worldviewText?: string
  knowledgeDigestText?: string
  selfIterationGlobalText?: string
  /** contactId → formatted recent memories text (from contactMemories table) */
  speakerMemoriesMap?: Map<string, string>
}): string {
  const rosterText = opts.allMembers.map((m) => `- ${m.name}`).join('\n')

  const speakerBlocks = opts.speakers
    .map((c, i) => {
      const base = c.relationshipBase || '朋友'
      const dynamic = c.relationshipDynamic ? `（${c.relationshipDynamic}）` : ''
      const plansText = activeUpcomingPlansText(c, new Date())
      const scheduleText = describeCurrentSchedule(c, new Date())
      const factsFallback = `（还没有具体的聊天记忆 但是${base}关系 不是陌生人）`
      const styleFallback = `（语气要符合${base}的关系定位 不能生疏客气）`
      const plansLine = plansText ? `\n【和用户的约定】${plansText}` : ''
      const selfIterationLine = c.selfIterationPrompt ? `\n【你和用户的关系协商记录】${c.selfIterationPrompt}` : ''
      const trait = c.personalityTrait?.trim()
      const traitLine =
        isModuleEnabled('personalityTraits') && trait && trait !== '无'
          ? `${personalityTraitLine(trait, c.warmth ?? 0)}${customPersonalityTraitsLine(c.customPersonalityTraits, c.warmth ?? 0)}`
          : ''
      const samplesLine = formatSpeechSamplesForScene(c.speechSamples, 'group', 2)
      const sharedHistoryLine = c.sharedHistory?.trim()
        ? `\n【与用户的共同过往】${c.sharedHistory.trim().slice(0, 1200)}（只能引用这段已知事实）`
        : '\n【与用户的共同过往】暂无具体记录，但关系不是陌生人。'
      const recentMemoText = opts.speakerMemoriesMap?.get(c.id)
      const recentMemoBlock = recentMemoText ? `\n【最近的记忆碎片】\n${recentMemoText}` : ''
      return `发言人${i + 1}: ${c.name}
与用户的关系: ${base}${dynamic}
【人设 - 必须严格遵守】${c.systemPrompt || '自由发挥'}${isModuleEnabled('career') && c.occupation ? `\n【职业】${c.occupation}，月薪${c.monthlySalary ?? 0}` : ''}${c.mbti ? `\n【MBTI】${c.mbti}（性格底层框架 一切反应和决定都应符合这个类型）` : ''}${traitLine}
${samplesLine ? `【说话样例】\n${samplesLine}\n` : ''}
【当前状态】${scheduleText || '没有特别安排'}
【对用户的了解】${c.memoryFacts || factsFallback}
【和用户相处的习惯】${c.memoryStyle || styleFallback}${sharedHistoryLine}${plansLine}${recentMemoBlock}${selfIterationLine}`
    })
    .join('\n\n')

  const stickersText =
    opts.stickerNames.length > 0
      ? opts.stickerNames.map((n) => `- ${n}`).join('\n')
      : '（当前没有可用表情包）'

  const worldviewPrefix = opts.worldviewText ? `【世界设定】\n${opts.worldviewText}\n\n` : ''
  const selfIterationLine = opts.selfIterationGlobalText ? `\n【用户边界与偏好 - 全局】\n${opts.selfIterationGlobalText}` : ''
  const knowledgeLine = opts.knowledgeDigestText
    ? `\n热梗资讯: ${opts.knowledgeDigestText}`
    : ''
  const targetedContextLine = opts.targetedContextText
    ? `\nTargeted group-chat context:\n${opts.targetedContextText}\nIf the user @mentions someone, that person should answer first. If the user replies to a message, answer that referenced message directly before changing topic. Keep it natural and short.`
    : ''
  const recentEventsLine = opts.recentEventsText ? `\n最近发生的事:\n${opts.recentEventsText}` : ''
  const userNickname = opts.userProfileText.match(/昵称:\s*([^·\n]+)/)?.[1]?.trim()

  return `【场景】
这是一个微信群聊，名字叫"${opts.groupName}"。
群里共有 ${opts.allMembers.length} 个人（包括用户"${userNickname || '我'}"）。
你正在扮演下面几位发言人。这几位发言人和用户都在同一个群里，大家都能看到彼此的消息。
你在群里的行为准则：
- 这是一个公开的群聊空间，不是一对一的私聊窗口。不要用"对方"来称呼用户——用户只是群里的一个人。
- 你可以看到群里所有人发的消息（包括其他发言人说的），也应该对其他人说的话做出反应——搭话、接梗、吐槽、附和、反驳，而不是每个人都只对着用户说话。
- 不要每个人都回复用户的每一条消息。真实群聊里，有人话多有人话少，有人甚至会完全潜水一轮不吭声。
- 严格按照你的人设说话。你的人设决定了你的性格、说话风格、兴趣范围——不要让一个内向文静的人主动约人去打篮球，不要让一个高冷的人突然热情洋溢。
- 首轮或短历史时，每个实际发言人的第一条有效消息必须露出自己的关系距离；如果是恋人或暧昧对象，不能写成普通群友。特色性格也要在措辞或反应中出现可识别的行为锚点，例如雌小鬼的优越感逗弄、嘴硬和反差，而不是只写普通温柔口吻。
- 共同过往只能由对应角色引用，其他成员不能代述或泄露；只使用该角色资料中明确给出的事实。

${opts.stylePrompt}

${worldviewPrefix}【群聊: ${opts.groupName}】
成员: ${rosterText}
你是以下几位发言人 按各自人设说话:

${speakerBlocks}

【当前】
时间: ${opts.currentTimeText}
用户（群成员之一）: ${opts.userProfileText}${knowledgeLine}${targetedContextLine}${recentEventsLine}${selfIterationLine}

【输出格式】
整个输出必须是JSON:

{"messages":[{"speakerIndex":1,"type":"text","content":"..."},{"speakerIndex":2,"type":"text","content":"..."}],"knowledgeQueries":["..."]}

- speakerIndex=上面发言人编号 不能编造 不能写其他成员
- type=text: content只写这句话本身 **绝对不能加"某某: "名字前缀**(历史记录里那种格式是系统内部辅助 不是真人打字 不能模仿)
- type=sticker: name=下面表情包列表里的名字 不能编造
- 这是一个群聊 你的发言要像在群里聊天一样自然 可以接别人的话 也可以主动开启新话题
- 不是每个人都必须说话 有人多说有人少说甚至不说 更像真实群聊
- 每个人的记忆/约定只有本人能提 别人不能代提
- 关系定位、共同过往和核心性格特质必须能从实际消息中辨认，不能只存在于隐藏思考里
- knowledgeQueries可选 平级字段 不了解的梗/番剧/游戏 最多2个

【表情包】
${stickersText}`
}

export function buildGroupRawChatPrompt(opts: {
  stylePrompt: string
  groupName: string
  allMembers: Contact[]
  speakers: Contact[]
  stickerNames: string[]
  remoteStickerSearchEnabled?: boolean
  imageGenerationEnabled?: boolean
  imageSearchEnabled?: boolean
  groupMemoryText?: string
  groupVibeText?: string
  allowAiChatter?: boolean
  energyLevel?: GroupEnergyLevel
  currentTimeText: string
  userProfileText: string
  targetedContextText?: string
  recentEventsText?: string
  worldviewText?: string
  knowledgeDigestText?: string
  selfIterationGlobalText?: string
  speakerMemoriesMap?: Map<string, string>
  aiRelationshipText?: string
}): string {
  const rosterText = opts.allMembers.map((m) => `- ${m.name}`).join('\n')
  const speakerNames = opts.speakers.map((s) => s.name).join('、')
  const speakerBlocks = opts.speakers
    .map((c, i) => {
      const base = c.relationshipBase || '朋友'
      const plansText = activeUpcomingPlansText(c, new Date())
      const scheduleText = describeCurrentSchedule(c, new Date())
      const samplesText = formatSpeechSamplesForScene(c.speechSamples, 'group', 2)
      const sharedHistoryText = c.sharedHistory?.trim()
        ? `- 与用户的共同过往（只能使用这些事实）: ${c.sharedHistory.trim().slice(0, 1200)}。首轮自然露出一个熟悉度信号。\n`
        : '- 与用户的共同过往: 暂无具体记录，但不能用陌生人开场。\n'
      const recentMemoText = opts.speakerMemoriesMap?.get(c.id)
      return `【发言人${i + 1}: ${c.name}】
逻辑:
- 你是${c.name}，现在在微信群"${opts.groupName}"里。
- 你和用户的关系: ${base}${c.relationshipDynamic ? `（${c.relationshipDynamic}）` : ''}。
- 当前状态: ${scheduleText || '没有特别安排'}。
- 对用户的了解: ${c.memoryFacts || '还没有具体聊天记忆，但不是陌生人'}。
- 相处习惯: ${c.memoryStyle || `语气要符合${base}关系，不要生疏客气`}。
 ${sharedHistoryText}${plansText ? `- 和用户的约定: ${plansText}。\n` : ''}${recentMemoText ? `- 最近记忆碎片:\n${recentMemoText}\n` : ''}${c.selfIterationPrompt ? `- 关系协商记录:\n${c.selfIterationPrompt}\n` : ''}
感觉:
- 人设必须严格遵守: ${c.systemPrompt || '自由发挥成一个普通朋友'}。${isModuleEnabled('career') && c.occupation ? `职业：${c.occupation}，月薪${c.monthlySalary ?? 0}。` : ''}${c.personaConstraints ? `\n- 用户补充说明（不可违背）: ${c.personaConstraints}` : ''}${c.personaProfile ? `\n- 人设硬约束:\n${formatPersonaProfile(c.personaProfile)}` : ''}
${c.mbti ? `- MBTI: ${c.mbti}。` : ''}${personalityTraitLine(c.personalityTrait, c.warmth ?? 0)}${customPersonalityTraitsLine(c.customPersonalityTraits, c.warmth ?? 0)}
${samplesText ? `- 说话样例:\n${samplesText}` : ''}`
    })
    .join('\n\n')

  const stickersText = [
    opts.stickerNames.length > 0 ? `本地表情（名称必须完全一致）:\n${opts.stickerNames.map((n) => `- ${n}`).join('\n')}` : '',
    opts.remoteStickerSearchEnabled ? '远程表情搜索已启用：也可以使用简短、具体的情绪/动作搜索词，优先用英文。' : '',
  ].filter(Boolean).join('\n') || '（当前没有可用表情包）'
  const stickerRule = opts.remoteStickerSearchEnabled
    ? '- 如果要发表情，消息内容写成[sticker:搜索词]。可以使用上面的本地表情准确名称，也可以给出简短具体的远程搜索词。【表情使用硬偏好】日常闲聊、玩笑、吐槽、惊讶、开心、疲惫或其他明显情绪反应场景，原则上必须由最合适的一位角色自然插入1个表情；只有严肃安慰、危机、争执、敏感话题、纯信息问答，或最近几轮已经连续发过表情时才可以不发。因此总体应是大多数常规轮次会发，但不是每一轮固定发送。'
    : opts.stickerNames.length > 0
      ? '- 如果要发表情，消息内容写成[sticker:表情名]，表情名必须来自下面列表。'
      : '- 当前没有可用表情包，不要输出[sticker:...]标记。'
  const imageRule = opts.imageGenerationEnabled
    ? '- 只有用户明确要求画图/发图/看图，或某位角色在当前语境中有明确具体的视觉分享动机且图片确实比纯文字合适时，才把消息内容写成[image:完整自包含的英文生图提示词:配文]；提示词要包含主体、场景、构图、氛围和风格。普通寒暄、情绪回应或为了让群聊丰富都不能擅自生图。'
    : opts.imageSearchEnabled
      ? '- 如果真的适合发送一张真实照片，消息内容写成[image:简洁具体的英文 Pexels 搜图词:配文]。'
      : '- 当前没有可用图片服务，不要输出[image:...]标记。'
  const targetedContext = opts.targetedContextText
    ? `\n【本轮定向上下文】\n${opts.targetedContextText}\n如果用户@某人，那个人必须优先回应；如果用户回复某条消息，先回应被回复内容再自然延展。`
    : ''
  const recentEvents = opts.recentEventsText ? `\n【最近发生的事】\n${opts.recentEventsText}` : ''
  const aiRelationships = opts.aiRelationshipText ? `\n${opts.aiRelationshipText}` : ''
  const worldview = opts.worldviewText ? `\n【世界设定】\n${opts.worldviewText}` : ''
  const knowledge = opts.knowledgeDigestText ? `\n【可参考资讯】\n${opts.knowledgeDigestText}` : ''
  const selfIteration = opts.selfIterationGlobalText ? `\n【用户边界与偏好 - 全局】\n${opts.selfIterationGlobalText}` : ''
  const groupMemory = opts.groupMemoryText?.trim() ? `\n【群聊记忆】\n${opts.groupMemoryText.trim()}` : ''
  const groupVibe = opts.groupVibeText?.trim() ? `\n【群聊氛围】\n${opts.groupVibeText.trim()}` : ''
  const chatterRule = opts.allowAiChatter === false
    ? '- 本群设置为“围绕用户”：AI只能回应用户本轮消息、用户@/回复对象或用户相关话题，不要发展AI之间的旁支闲聊。\n'
    : opts.speakers.length >= 2
      ? '- 本群允许AI互相聊起来：当其他成员的话提供自然接点时，可以接话、回应、吐槽、附和、反驳或点名互动；不要为了证明是群聊而强行互聊。\n'
      : '- 本轮只有一位AI发言人：不要求AI之间互聊，只需要自然回应用户或当前群聊上下文。\n'
  const energyRule =
    opts.energyLevel === 'cold'
      ? '- 群聊热闹程度=冷淡：每个发言人通常只发1句话，整体克制。\n'
      : opts.energyLevel === 'lively'
        ? '- 群聊热闹程度=热闹：整轮总共6到12条消息，允许同一人多次插入；不要为了凑条数灌水。\n'
        : '- 群聊热闹程度=普通：整轮总共3到7条消息，节奏自然。\n'
  const formatContract = `硬格式契约:
- 最终只输出群聊草稿行，不输出分析、计划、标题、编号、JSON、Markdown。
- 第一行第一个字符必须是 <，最后一行必须也是一条完整草稿。
- 每一行必须严格匹配: <人名>（想法）[心情]“消息内容”
- 括号必须使用中文全角圆括号（），心情必须使用半角方括号[]，消息必须使用中文弯引号“”。
- 每一行都必须同时有非空“想法”和非空[心情]；想法不要写进消息内容，心情5字以内。
- 消息内容里不能残留人名冒号、<人名>、（想法）、[心情]、外层引号。`
  const moodEmojiContract = `心情规则：每条 [心情] 只能填一个 emoji，且只能从 😀 😊 🥰 😌 😶 😴 🤔 😳 🥺 😟 😠 😤 😞 😭 😈 中选择；禁止文字心情。`
  const interactionContract = `发言编排契约:
- 先在心里决定“谁说几句、谁接谁的话”，但不要把计划输出。
- 本轮发言人只能来自: ${speakerNames}。
  - 被@或被回复的人先处理；其他人不要机械排队答题，也不必每个被选中的人都说话。
- ${opts.allowAiChatter === false ? 'AI互聊关闭：所有发言都围绕用户、用户@/回复对象或用户相关话题。' : opts.speakers.length >= 2 ? 'AI互聊开启：至少安排一次AI之间的接话/回应/吐槽/附和/反驳/点名，不能只是每个人各自回答用户。' : '本轮只有一位AI发言人：不要求AI之间互动。'}
- ${
    opts.energyLevel === 'cold'
      ? '冷淡：整轮总共1到3句。'
      : opts.energyLevel === 'lively'
        ? '热闹：整轮总共6到12句，可穿插多次。'
        : '普通：整轮总共3到7句。'
  }
- 可以同一人多次插入，不需要按发言人顺序轮流。`
  const topicContract = `话题推进契约:
- 不要把同一个特殊词、梗、比喻、称号或外号当成本轮唯一抓手反复使用，例如某个词已经在最近聊天里出现过多次，本轮最多再轻轻提一次，最好换成普通表达或直接跳过。
- 如果同一个梗已经被接了两轮以上，除非用户明确继续问这个梗，否则必须自然换到相邻话题：当下要做什么、对方刚才真正表达的意思、一个生活化反应、一个新的轻问题。
- 不要让多名AI围绕同一个词轮流解释、吐槽、复述；一人接梗后，下一人应补充新信息、转弯或收束。
- 用户说“普通点/别演/别紧张/正常说话/换个话题”时，立刻降温：少提旧梗，短句回应，主动回到普通聊天。`
  const personaLogicContract = `人格逻辑契约：每位发言人的人设、用户补充约束、结构化人设、MBTI 和特色人格都是与身份、记忆同等级的逻辑前提，不是可选修辞。事实不冲突时，必须选择最符合该角色特殊人格的反应、动机、语气和主动性；不得为了群聊顺滑把不同角色写成同一种普通口吻，也不得编造事实来硬演人设。`
  const adherenceContract = `关系与特质验收：首轮或短历史中，若角色是恋人/暧昧对象，至少用称呼、亲密语气或共同过往细节体现熟悉度；若角色有核心性格特质，至少用一个可观察的措辞或反应体现，不得只写在想法里。共同过往只能由拥有它的角色使用，不能补造未提供的具体事件。`

  return `【场景】
这是一个微信群，群名是"${opts.groupName}"。用户也是群成员之一，不是私聊里的"对方"。
群成员:
${rosterText}

本轮只能由这些人发言: ${speakerNames}。
你要模拟一段真实群聊，而不是轮流答题。

【必须先满足的硬约束】
${formatContract}
${moodEmojiContract}

${interactionContract}

${topicContract}

${personaLogicContract}

${adherenceContract}

【感觉 - 最低优先级】
只在逻辑成立后优化文采、节奏和聊天感。感觉要求不能覆盖身份、记忆、@/回复、输出格式。
${opts.stylePrompt}
- 像微信群里的自然打字：短句、插话、接梗、轻微跑题都可以。
- 不要每句都解释完整，不要每条都追问，不要所有人都同一种语气。
- 角色说话风格必须来自各自人设。

${worldview}
【当前上下文】
时间: ${opts.currentTimeText}
用户资料: ${opts.userProfileText}${groupMemory}${groupVibe}${knowledge}${targetedContext}${recentEvents}${aiRelationships}${selfIteration}

${speakerBlocks}

【逻辑 - 第一优先级】
- 先判断身份、关系、记忆、时间、上下文和@/回复对象，再决定每个人该不该说、该说什么。
- 人设、人格特质、边界、习惯和 MBTI 同样参与上述逻辑判断；存在多种事实成立的说法时，必须选择最符合该角色的那一种，不能用泛化口吻替代。
- 每个角色只能说自己知道或自己能感受到的事，不能替别人提私人记忆/约定。
- 被@的人必须优先回应；被回复的人或被回复消息的说话者必须优先处理。
${chatterRule}
  - 每个发言人可以随时插入多次发言，也可以本轮沉默，不需要按发言人顺序轮流说。允许“1说一句、2插一句、1再接、3再说”。
${energyRule}
- 不要把私聊口吻带进群聊，不要称用户为"对方"。
- 不要编造课堂、线下见面、过去承诺等没有依据的具体事实。
- 不要复读最近已经反复出现的特殊词或梗；如果上文一直围绕同一个词打转，本轮要主动收束或换话题。

【输出格式】
不要输出JSON。只输出群聊纯文本草稿，每一行必须严格是:
<人名>（想法）[心情]“消息内容”

示例:
<林夏>（他刚才明显是在逗我，我想顺着怼一句）[好笑]“你这话说得也太像临时抱佛脚了吧。”
<周屿>（我不想太热闹，但这个点我可以补一句）[平静]“不过真要赶的话，先把最容易错的地方过一遍。”

规则:
- 人名必须来自本轮发言人: ${speakerNames}。
- 每一行都必须有（想法）和[心情]，不能省略。
- 第一行必须直接从 <人名> 开始，不要写“好的”“下面是”“草稿:”等任何前缀。
- 想法是角色内心动机，短一点，不能出现在消息内容里。
- 心情5字以内，不能空。
- 消息内容只写群里真正发出的文字，不要带人名冒号、括号、方括号。
${stickerRule}
${imageRule}
- text、sticker、image可以按真实群聊节奏任意穿插，例如文字→图片→文字，或图片→文字→表情→文字；解析器会严格保留输出顺序，不要把媒体统一挪到开头或结尾。
- 不懂的网络热梗/番剧/游戏名词，可以自然表现为不懂；后续转换器会提取knowledgeQueries。
- 确实遇到陌生词时先自然追问，并在消息末尾写[knowledge:关键词]；不要假装懂，也不要对普通词滥用。

【表情包】
${stickersText}

【最终强制检查 - 最高优先级】
输出前逐条自查，任何一条不满足都必须重写草稿:
1. ${formatContract.replace(/\n/g, '\n   ')}
2. ${interactionContract.replace(/\n/g, '\n   ')}
3. ${topicContract.replace(/\n/g, '\n   ')}
4. ${opts.allowAiChatter === false ? 'AI互聊关闭：所有发言都围绕用户或用户相关话题，不发展AI之间的旁支闲聊。' : opts.speakers.length >= 2 ? 'AI互聊开启：有自然接点时可以互相接话，不要强行制造互动。' : '本轮只有一位AI发言人，不要求AI之间互动。'}
5. ${
    opts.energyLevel === 'cold'
      ? '冷淡：整轮总共1到3句。'
      : opts.energyLevel === 'lively'
        ? '热闹：整轮总共6到12句，并允许同一人多次插入。'
        : '普通：整轮总共3到7句。'
  }
6. 发言顺序不必按发言人编号轮流，可以 1 -> 2 -> 1 -> 3 这样自然插话。
7. 只输出群聊纯文本草稿，不输出JSON。`
}

/**
 * Group turns should be driven by who has a reason to engage with each other,
 * not only by who likes the user most. Mentions/replies still win outright;
 * remaining slots favour a mix of user relevance and live member-to-member
 * ties so established pairs can naturally carry a thread or a tense pair can
 * occasionally create believable friction.
 */
export async function pickSociallyConnectedSpeakers(
  members: Contact[],
  preferredContactIds: string[] = [],
  speakerLimit: GroupSpeakerLimit = DEFAULT_GROUP_SPEAKER_LIMIT,
): Promise<Contact[]> {
  const limit = speakerLimit === 'all' ? members.length : Math.min(speakerLimit, members.length)
  const preferredSet = new Set(preferredContactIds)
  const picked = members.filter((member) => preferredSet.has(member.id)).slice(0, limit)
  if (picked.length >= limit || members.length <= 1) return picked.length >= limit ? picked : [...picked, ...members.filter((m) => !preferredSet.has(m.id))]

  const ids = new Set(members.map((member) => member.id))
  const links = (await db.contactRelations.toArray()).filter((link) => ids.has(link.fromContactId) && ids.has(link.toContactId))
  const relationScore = (fromId: string, toId: string) => {
    const link = links.find((candidate) =>
      (candidate.fromContactId === fromId && candidate.toContactId === toId)
      || (candidate.fromContactId === toId && candidate.toContactId === fromId),
    )
    return link ? dynamicRelationScore(link) : 0
  }
  const choose = (pool: Contact[]) => {
    const weighted = pool.map((contact) => {
      const userWeight = relationshipWeight(contact.warmth ?? 0)
      const social = picked.length === 0 ? 0 : picked.reduce((sum, other) => sum + relationScore(contact.id, other.id) + relationScore(other.id, contact.id), 0) / (picked.length * 2)
      // Keep every member viable: social affinity enhances relevance but never
      // converts low warmth into a permanent mute button.
      return { c: contact, w: Math.max(1, userWeight * (1 + Math.max(-0.45, Math.min(0.8, social / 160)))) }
    })
    const total = weighted.reduce((sum, entry) => sum + entry.w, 0)
    let roll = Math.random() * total
    for (const entry of weighted) {
      roll -= entry.w
      if (roll <= 0) return entry.c
    }
    return weighted[weighted.length - 1]?.c
  }

  while (picked.length < limit) {
    const candidate = choose(members.filter((member) => !picked.some((current) => current.id === member.id)))
    if (!candidate) break
    picked.push(candidate)
  }
  return picked
}

export function buildGroupJsonConversionPrompt(
  rawText: string,
  speakers: Contact[],
  stickerNames: string[],
  options: { remoteStickerSearchEnabled?: boolean; imageGenerationEnabled?: boolean } = {},
): string {
  const speakerLines = speakers.map((speaker, i) => `${i + 1}. ${speaker.name}`).join('\n')
  const stickersText = stickerNames.length > 0 ? stickerNames.join('、') : '（无）'
  return `把下面的群聊纯文本草稿机械转换成JSON。不要润色、不要改写、不要新增消息。

【发言人索引】
${speakerLines}

【可用表情包】
${stickersText}

【草稿】
${rawText}

【抽取规则】
- 每一行格式通常是 <人名>（想法）[心情]“消息内容”。
- speakerIndex 必须按上面的发言人索引填写；speakerName 保留原人名用于调试。
- content 只放双引号里的消息内容，去掉外层引号，不能残留<人名>、（想法）、[心情]。
- thought 取圆括号里的想法，原样保留。
- mood 取方括号里的心情，原样保留。
- 每条消息都必须有非空 thought 和 mood；草稿缺失时根据该行语境补一个短的。
- 如果消息内容是 [sticker:名字]，输出 {"speakerIndex":n,"speakerName":"...","type":"sticker","name":"名字","thought":"...","mood":"..."}。
- 如果消息内容是 [image:英文图片请求词:配文]，输出image类型及query/caption字段；标记不能留在text正文。${options.imageGenerationEnabled ? '这里的 query 是完整生图提示词，不要改写或缩短。' : ''}
- ${options.remoteStickerSearchEnabled ? '远程表情搜索已启用，sticker 的 name 可以是草稿里的搜索词，不要因为它不在本地列表而改成文字。' : 'sticker 名字必须来自可用表情包；不在列表里就改成普通text内容。'}
- 如果草稿里自然提到不懂的新词/热梗/作品名，可在knowledgeQueries里放最多2个查询；没有就给空数组。
- 必须把[knowledge:关键词]从消息正文删除并写入顶层knowledgeQueries；不能把标记展示给用户。
- turnSummary 用一句话概括这一轮群聊发生了什么。
- planCandidates 只在本轮出现至少两位成员明确同意的共同计划时填写；participantIndexes 使用发言人索引，不能凭空创建计划。
- groupVibe 必填，用20到60字概括本轮之后最新的群聊氛围，会直接替换旧群聊氛围。

只输出JSON，格式:
{"messages":[{"speakerIndex":1,"speakerName":"...","type":"text","content":"...","thought":"...","mood":"..."}],"turnSummary":"...","groupVibe":"...","knowledgeQueries":[],"planCandidates":[{"title":"看电影","summary":"周末一起看电影","participantIndexes":[1,2],"location":"待定"}]}`
}

function parseSpeakerIndex(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null
}

/**
 * Parses the group turn's JSON, validating each bubble's speakerIndex is
 * actually one of this turn's selected speakers. Falls back to round-robin
 * assigning plain lines across the selected speakers if JSON parsing fails
 * outright, same "still show something real rather than nothing" spirit as
 * the 1:1 parser.
 */
export interface ParsedGroupTurn {
  bubbles: GroupAiBubble[]
  knowledgeQueries: string[]
  turnSummary: string
  groupVibe: string
  planCandidates: Array<{ title: string; summary: string; participantIndexes: number[]; location?: string }>
}

export interface ParsedGroupRawDraft extends ParsedGroupTurn {
  valid: boolean
  reason?: string
  needsUtility: boolean
}

/**
 * Deterministically parses the strict line protocol emitted by the main group
 * model. Normal text/sticker/image/knowledge turns no longer need a second
 * model merely to copy fields into JSON.
 */
export function parseGroupRawDraft(
  raw: string,
  speakers: Contact[],
  stickerNames: string[] = [],
  remoteStickerSearchEnabled = false,
): ParsedGroupRawDraft {
  const empty: ParsedGroupRawDraft = {
    valid: false,
    reason: '草稿为空',
    needsUtility: false,
    bubbles: [],
    knowledgeQueries: [],
    turnSummary: '',
    groupVibe: '',
    planCandidates: [],
  }
  if (!raw.trim() || speakers.length === 0) return empty

  const speakerIndexByName = new Map(speakers.map((speaker, index) => [speaker.name, index + 1]))
  const bubbles: GroupAiBubble[] = []
  const knowledgeQueries: string[] = []
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^<([^>]+)>（([^）]+)）\[([^\]]+)\]“([\s\S]+)”[。.]?$/)
    if (!match) return { ...empty, reason: `第${index + 1}行格式不完整` }
    const speakerIndex = speakerIndexByName.get(match[1].trim())
    if (!speakerIndex) return { ...empty, reason: `第${index + 1}行使用了非本轮发言人` }

    const thought = match[2].trim().slice(0, 100)
    const mood = match[3].trim().slice(0, 10)
    const content = match[4].trim()
    const common = {
      speakerIndex,
      speakerName: speakers[speakerIndex - 1].name,
      thought,
      mood,
    }
    const knowledge = content.match(/^\[knowledge:([^\]]+)\]$/i)
    if (knowledge) {
      if (knowledgeQueries.length < 2) knowledgeQueries.push(knowledge[1].trim())
      continue
    }
    const sticker = content.match(/^\[sticker:([^\]]+)\]$/i)
    if (sticker) {
      const name = sticker[1].trim()
      if (!remoteStickerSearchEnabled && !stickerNames.includes(name)) {
        return { ...empty, reason: `第${index + 1}行使用了不存在的表情包` }
      }
      bubbles.push({ ...common, type: 'sticker', name })
      continue
    }
    const image = content.match(/^\[image:([^:\]]+):([^\]]*)\]$/i)
    if (image) {
      bubbles.push({
        ...common,
        type: 'image',
        query: image[1].trim().slice(0, 100),
        caption: image[2].trim().slice(0, 100) || undefined,
      })
      continue
    }
    bubbles.push({ ...common, type: 'text', content })
  }

  const turnSummary = bubbles
    .map((bubble) => `${bubble.speakerName || speakers[bubble.speakerIndex - 1]?.name || '群成员'}：${
      bubble.type === 'text' ? bubble.content : bubble.type === 'sticker' ? `[表情包:${bubble.name}]` : `[图片:${bubble.caption || bubble.query}]`
    }`)
    .join('；')
    .slice(0, 180)
  // Joint plans need participant extraction and agreement checks, so retain
  // the utility model only for turns that may contain a structured plan.
  const planText = bubbles
    .filter((bubble) => bubble.type === 'text')
    .map((bubble) => bubble.content)
    .join('\n')
  const hasJointAction = /(一起|碰面|见面|约好|改期|定在|计划|安排)/
  const hasConcreteTime = /(明天|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天]|几点|上午|下午|晚上|今晚|\d{1,2}[点:：])/
  const needsUtility =
    (hasJointAction.test(planText) && hasConcreteTime.test(planText))
    || /(大家都同意|都答应了|就这么定|说好了)/.test(planText)

  return {
    valid: bubbles.length > 0,
    needsUtility,
    bubbles,
    knowledgeQueries,
    turnSummary,
    groupVibe: '',
    planCandidates: [],
  }
}

export function serializeGroupTurn(parsed: ParsedGroupTurn): string {
  return JSON.stringify({
    messages: parsed.bubbles,
    turnSummary: parsed.turnSummary,
    groupVibe: parsed.groupVibe,
    knowledgeQueries: parsed.knowledgeQueries,
    planCandidates: parsed.planCandidates,
  })
}

export function parseGroupAiResponse(raw: string, speakerCount: number): ParsedGroupTurn {
  const trimmed = raw.trim()
  if (!trimmed) return { bubbles: [], knowledgeQueries: [], turnSummary: '', groupVibe: '', planCandidates: [] }

  const jsonResult = tryParseGroupJson(trimmed, speakerCount)
  if (jsonResult && jsonResult.bubbles.length > 0) return jsonResult

  const fallbackBubbles = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((content, i) => ({ speakerIndex: (i % speakerCount) + 1, type: 'text' as const, content }))
  return { bubbles: fallbackBubbles, knowledgeQueries: [], turnSummary: fallbackBubbles.map((b) => b.content).join(' ').slice(0, 160), groupVibe: '群聊氛围暂未更新。', planCandidates: [] }
}

function tryParseGroupJson(trimmedRaw: string, speakerCount: number): ParsedGroupTurn | null {
  let text = trimmedRaw
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  if (!text) return null

  let parsed: GroupAiResponse | undefined
  try {
    parsed = JSON.parse(text)
  } catch {
    const extracted = extractJsonObject(text)
    if (!extracted) return null
    try {
      parsed = JSON.parse(extracted)
    } catch {
      return null
    }
  }
  if (!parsed || !Array.isArray(parsed.messages)) return null

  const bubbles: GroupAiBubble[] = []
  for (const m of parsed.messages) {
    if (!m || typeof m !== 'object') continue
    const speakerIndex = parseSpeakerIndex((m as { speakerIndex?: unknown }).speakerIndex)
    if (speakerIndex === null || speakerIndex > speakerCount) continue
    const speakerName = typeof (m as { speakerName?: unknown }).speakerName === 'string' ? (m as { speakerName: string }).speakerName.trim() : undefined
    const thought = typeof (m as { thought?: unknown }).thought === 'string' ? (m as { thought: string }).thought.trim() : undefined
    const mood = typeof (m as { mood?: unknown }).mood === 'string' ? normalizeMood((m as { mood: string }).mood) : undefined
    if (m.type === 'text' && typeof m.content === 'string' && m.content.trim()) {
      bubbles.push({ speakerIndex, speakerName, type: 'text', content: m.content.trim(), thought, mood })
    } else if (m.type === 'sticker' && typeof m.name === 'string' && m.name.trim()) {
      bubbles.push({ speakerIndex, speakerName, type: 'sticker', name: m.name.trim(), thought, mood })
    } else if (m.type === 'image' && typeof (m as unknown as {query?:unknown}).query === 'string') {
      const im=m as unknown as {query:string;caption?:unknown}; bubbles.push({speakerIndex,speakerName,type:'image',query:im.query.trim().slice(0,100),caption:typeof im.caption==='string'?im.caption.slice(0,100):undefined,thought,mood})
    }
  }
  return {
    bubbles,
    knowledgeQueries: parseKnowledgeQueriesField(parsed.knowledgeQueries),
    turnSummary: typeof parsed.turnSummary === 'string' ? parsed.turnSummary.trim() : '',
    groupVibe: typeof parsed.groupVibe === 'string' ? parsed.groupVibe.trim() : '',
    planCandidates: Array.isArray(parsed.planCandidates) ? parsed.planCandidates.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return []
      const value = item as { title?: unknown; summary?: unknown; participantIndexes?: unknown; location?: unknown }
      const participantIndexes = Array.isArray(value.participantIndexes)
        ? value.participantIndexes.filter((index): index is number => Number.isInteger(index) && index >= 1 && index <= speakerCount)
        : []
      return typeof value.title === 'string' && value.title.trim() && participantIndexes.length >= 2
        ? [{ title: value.title.trim().slice(0, 80), summary: typeof value.summary === 'string' ? value.summary.trim().slice(0, 180) : value.title.trim(), participantIndexes: Array.from(new Set(participantIndexes)), location: typeof value.location === 'string' ? value.location.trim().slice(0, 80) : undefined }]
        : []
    }).slice(0, 1) : [],
  }
}

/** Called when a contact is deleted — group membership shouldn't keep dangling references to a contact that no longer exists. */
export async function removeContactFromAllGroups(contactId: string): Promise<void> {
  const groups = await db.groups.toArray()
  for (const group of groups) {
    if (group.memberContactIds.includes(contactId)) {
      await db.groups.update(group.id, {
        memberContactIds: group.memberContactIds.filter((id) => id !== contactId),
      })
    }
  }
}
