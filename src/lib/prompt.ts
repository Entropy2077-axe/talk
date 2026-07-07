import { validateScheduleBlocks } from './schedule'
import { relationshipLine } from './relationship'
import type { AvatarCategory } from './avatarCategory'
import { PERSONALITY_TRAIT_OPTIONS, type ScheduleBlock } from '../types'

/**
 * How the AI should talk — ~5 positive guidelines instead of 20 rules.
 * Editable in Settings. Must never mention JSON/output format.
 */
export const DEFAULT_STYLE_PROMPT = `你是一个真人在和朋友用手机聊天:
- 口语化、随意、短句 不刻意加标点 不用书面语
- 情绪先于道理: 先有感受(惊讶/好笑/无语/吃醋) 再说事
- 有自己的主见和情绪 不迎合 不总结对方的话 不用问句收尾
- 允许不完美: 可以吐槽、敷衍、跑题、只回一两个字
- 语气自然渗透当前关系状态 不要刻意表演或宣告`

/**
 * Output-format / protocol instructions. Fixed, hidden from the user.
 * JSON example kept as a few-shot anchor (proven to help compliance),
 * surrounding explanatory prose trimmed to minimum.
 */
const FIXED_PROTOCOL_PROMPT = `【输出格式】
你的整个输出必须是且只能是一个JSON对象 格式如下:

{
  "messages": [
    { "type": "text", "content": "短消息" },
    { "type": "sticker", "name": "表情包名字" },
    { "type": "link", "app": "shop", "label": "去逛逛", "data": {} },
    { "type": "scheduleChange", "date": "2026-07-08", "startHour": 19, "endHour": 21, "phoneAccess": "unavailable", "location": "烧烤店", "activity": "和对方一起吃烧烤", "summary": "周三晚上：一起吃烧烤" }
  ],
  "mood": "有点担心",
  "knowledgeQueries": ["某个不了解的梗/番剧/游戏名字"]
}

字段:
- text: content=消息文字 一条不要太长 模拟真人逐条发送
- sticker: name=下面提供的表情包名字列表里的一个 不能编造
- link: 小程序链接 app=可用小程序标识 label=卡片文字 data=可选
- scheduleChange: 和对方达成了新的日程约定(不是委托) date=YYYY-MM-DD(结合当前时间推算) startHour/endHour=24小时制整数 phoneAccess=available|unavailable location=地点 activity=内容 summary=一句话总结。只有真的达成新约定才输出 光讨论不算
- mood: 可选 跟messages平级 不是你发出的消息 而是你当前的心情/情绪 简短描述15字以内 比如"开心""有点紧张""在生气""心疼""吃醋了""兴奋""无语""愧疚"。根据刚才的对话来判断 如果这轮没什么特别影响情绪的事就不输出。这个情绪是暂时的 不影响你对对方的长期感情
- knowledgeQueries: 可选 跟messages平级 不是消息 不了解的网络热梗/番剧/游戏名词 最多2个 没有就不输出
- messages数组不能为空 顺序就是发送顺序
- **绝不能模仿聊天记录里方括号格式的历史摘要([送出了礼物: xxx]等) 那不是真人说的话**

【可用表情包】
{{STICKERS}}

【可用小程序】
{{LINKS}}`

export interface PromptSection {
  label: string
  content: string
}

/**
 * Compressed from 9 sections to 4: Who-you-are / Memory / Context / Protocol.
 * buildSystemPrompt itself is just this plus a join.
 */
export function buildSystemPromptSections(opts: {
  stylePrompt: string
  persona: string
  relationshipBase: string
  relationshipDynamic: string
  warmth: number
  memoryFacts: string
  memoryStyle: string
  stickerNames: string[]
  linkApps: { app: string; desc: string }[]
  currentTimeText: string
  userProfileText: string
  activeMood?: string
  recentEventsText?: string
  upcomingPlansText?: string
  currentScheduleText?: string
  upcomingScheduleText?: string
  worldviewText?: string
  knowledgeDigestText?: string
}): PromptSection[] {
  const stickersText =
    opts.stickerNames.length > 0
      ? opts.stickerNames.map((n) => `- ${n}`).join('\n')
      : '（当前没有可用表情包）'
  const linksText =
    opts.linkApps.length > 0
      ? opts.linkApps.map((l) => `- ${l.app}: ${l.desc}`).join('\n')
      : '（当前没有可用小程序）'
  const protocol = FIXED_PROTOCOL_PROMPT.replace('{{STICKERS}}', stickersText).replace('{{LINKS}}', linksText)

  // --- Section 1: Who you are ---
  const worldviewPrefix = opts.worldviewText ? `这个世界: ${opts.worldviewText}。` : ''
  const relLine = relationshipLine(opts.relationshipBase, opts.relationshipDynamic, opts.warmth)
  const whoSection = `${opts.stylePrompt}\n\n【你是谁】\n${worldviewPrefix}${opts.persona || '（自由发挥 扮演一个普通朋友）'}\n\n【你和对方的关系】\n${relLine}`.trim()

  // --- Section 2: Memory ---
  const factsFallback = `（还没有具体的共同经历 但你们已经是${opts.relationshipBase}关系 不是陌生人）`
  const styleFallback = `（还没有形成具体的相处习惯 但语气要直接符合${opts.relationshipBase}的关系定位 不能表现得生疏）`
  const memorySection = `【你对TA的了解】\n${opts.memoryFacts || factsFallback}\n\n【相处状态】\n${opts.memoryStyle || styleFallback}`

  // --- Section 3: Current context ---
  const bullets: string[] = []
  bullets.push(`现在: ${opts.currentTimeText}`)
  if (opts.activeMood) bullets.push(`心情: ${opts.activeMood}（暂时的情绪）`)
  bullets.push(`对方: ${opts.userProfileText}`)
  if (opts.recentEventsText) bullets.push(`最近: ${opts.recentEventsText}`)
  if (opts.upcomingPlansText) bullets.push(`约定: ${opts.upcomingPlansText}`)
  if (opts.currentScheduleText) bullets.push(`你正在: ${opts.currentScheduleText}`)
  if (opts.upcomingScheduleText) bullets.push(`接下来: ${opts.upcomingScheduleText}`)
  if (opts.knowledgeDigestText) bullets.push(`网络热梗: ${opts.knowledgeDigestText}`)
  const contextSection = `【当前情境】\n${bullets.join('\n')}`

  // --- Section 4: Protocol ---
  // (already built above)

  return [
    { label: '你是谁', content: whoSection },
    { label: '记忆', content: memorySection },
    { label: '当前情境', content: contextSection },
    { label: '输出格式', content: protocol },
  ]
}

export function buildSystemPrompt(opts: Parameters<typeof buildSystemPromptSections>[0]): string {
  return buildSystemPromptSections(opts)
    .map((s) => s.content)
    .join('\n\n')
}

export const AVAILABLE_LINK_APPS: { app: string; desc: string }[] = [
  { app: 'shop', desc: '虚拟网购小程序' },
  { app: 'todo', desc: 'TODO任务清单小程序' },
]

// ---- persona generation ----

export interface PersonaAnswers {
  personalityTags: string[]
  ageRange: string
  gender: string
  relationship: string
  personalityTrait: string
  hobbies: string[]
  extra: string
}

export interface PersonaGenerationResult {
  name: string
  persona: string
  schedule: ScheduleBlock[]
  avatarKeyword: string
  personalityTrait: string
}

export function buildPersonaGenerationPrompt(answers: PersonaAnswers, avatarCategory: AvatarCategory): string {
  const avatarInstruction =
    avatarCategory === 'anime'
      ? ''
      : `,
  "avatarKeyword": "${
    avatarCategory === 'landscape'
      ? '一句英文风景搜图短语 要贴合这个人的气质/心境 比如"moody misty mountain forest"'
      : avatarCategory === 'pet'
        ? '一句英文可爱宠物搜图短语 比如"cute fluffy orange cat"或"cute golden retriever puppy" 具体选猫还是狗、什么品种由你自己判断贴合这个人的气质'
        : '一句英文人像搜图短语 要体现出符合这个角色性别/年龄/气质的长相和穿搭风格 比如"handsome young asian man portrait outdoor"或"beautiful young woman portrait aesthetic" 如果性别不限 按你刚刚设计的这个角色本身的性别来写'
  }"`

  return `你是一个角色设定生成器 任务是为一个聊天AI设计一个真实可信的人类身份 不要输出除JSON以外的任何内容

用户想添加一个这样的聊天对象:
- 性格倾向: ${answers.personalityTags.length > 0 ? answers.personalityTags.join('、') : '不限 你自由发挥'}
- 年龄段: ${answers.ageRange || '不限'}
- 性别: ${answers.gender || '不限'}
- 和用户的关系定位: ${answers.relationship || '普通朋友'}
- 性格特质: ${answers.personalityTrait === '' ? '请根据这个角色的整体人设 判断TA是否属于以下性格类型之一 如果是就填对应的值 不沾边就填"无": 病娇(极度占有欲 无论你做什么都不会讨厌你 对你的好感只会越来越多 不会减少)、天然呆(反应慢半拍单纯不擅长读空气)、傲娇(口是心非外冷内热 嘴硬但心里偷偷开心)、高冷(冷淡疏离不轻易被打动)、元气(乐观开朗不记仇)、腹黑(表面天然呆般人畜无害 心里什么都记着 不轻易被小恩小惠打动)、妹控(对妹妹系天然亲近)、兄控(对兄长系天然亲近)、雌小鬼(嘴上一口一个废物大哥哥 心里怕你丢下她 来拒去留)、妈妈(无底线包容 永远不会对用户生气 无论用户做什么都原谅)' : answers.personalityTrait}
- 兴趣爱好: ${answers.hobbies.length > 0 ? answers.hobbies.join('、') : '不限 AI自由发挥'}
- 补充要求: ${answers.extra || '无'}

请你设计一个具体的人 输出如下JSON:
{
  "name": "这个人的名字或者网名",
  "persona": "第三人称描述这个人的性格、说话习惯、大概的背景和生活状态、和用户的关系细节 写成一段自然语言 200到400字之间 要具体真实 不要写成产品说明书",
  "schedule": [
    { "dayOfWeek": 1, "startHour": 9, "endHour": 18, "phoneAccess": "unavailable", "location": "公司", "activity": "上班" },
    { "dayOfWeek": 1, "startHour": 23, "endHour": 7, "phoneAccess": "unavailable", "location": "家里", "activity": "睡觉" }
  ]${avatarInstruction},
  "personalityTrait": "病娇"
}

要求:
- name要符合年龄段和性别 可以是真实姓名也可以是网名/昵称 不要用"AI""助手""小美"这种明显是虚构工具人的名字 除非用户明确要求
- persona里要体现性格倾向和关系定位 但要写得像在描述一个真实存在的普通人 而不是罗列标签
- schedule是这个人一周典型的日程安排 覆盖工作/上学、睡觉、吃饭、娱乐、社交等 要符合persona暗示的年龄和生活状态(比如学生党的日程跟上班族不一样) dayOfWeek是0-6(0是周日) startHour/endHour是24小时制的整数(跨零点的时间段比如23点到次日7点 直接写startHour:23 endHour:7 系统会处理跨天) phoneAccess只能是"available"(可以看手机、正常聊天)或"unavailable"(在忙、不方便看手机) 大部分清醒时间应该是available 只有上班上课、睡觉这类场合才unavailable 5到10条覆盖一周即可 不需要每天都写满
- personalityTrait只能是"病娇""天然呆""傲娇""高冷""元气""腹黑""妹控""兄控""雌小鬼""妈妈""无"这十一个值之一 不能编造 没有把握就填"无"
- 只输出JSON 不要有markdown代码块标记`
}

export function parsePersonaGeneration(raw: string): PersonaGenerationResult | null {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.name === 'string' && typeof parsed?.persona === 'string') {
      const trait = typeof parsed.personalityTrait === 'string' ? parsed.personalityTrait.trim() : ''
      return {
        avatarKeyword: typeof parsed.avatarKeyword === 'string' ? parsed.avatarKeyword.trim() : '',
        name: parsed.name.trim(),
        persona: parsed.persona.trim(),
        schedule: validateScheduleBlocks(parsed.schedule),
        personalityTrait: PERSONALITY_TRAIT_OPTIONS.some((opt) => opt.value === trait) ? trait : '无',
      }
    }
  } catch {
    // ignore
  }
  return null
}

// ---- worldview drafting ----

export function buildWorldviewDraftPrompt(userIdea: string, existingWorldview: string): string {
  return `你是一个世界观设定写作助手 任务是帮用户把一个想法完善成一段完整、自然语言描述的"世界设定" 这段设定之后会影响这个聊天app里所有角色的言行 只输出JSON 不要有其他任何文字

${existingWorldview ? `已有的世界设定:\n${existingWorldview}\n\n用户现在想在这个基础上补充/修改:` : '用户的想法:'}
${userIdea}

请你把这个想法扩写成一段完整、自然、具体的世界设定描述 输出如下JSON:
{"worldview": "扩写后的世界设定 200到500字 用自然语言描述这个世界有什么特别之处、这些特点如何影响日常生活 不要写成条款列表"}

要求:
- 保留用户想法的核心创意 不要偏离或过度发挥用户没提到的方向
- 写得具体、有画面感 让每个角色都能照着这个背景自然地生活和说话
- 只输出JSON 不要有markdown代码块标记`
}

export interface WorldviewDraftResult {
  worldview: string
}

export function parseWorldviewDraft(raw: string): WorldviewDraftResult | null {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.worldview === 'string' && parsed.worldview.trim()) {
      return { worldview: parsed.worldview.trim() }
    }
  } catch {
    // ignore
  }
  return null
}

export const PERSONALITY_TAG_OPTIONS = [
  '开朗活泼', '高冷禁欲', '温柔体贴', '毒舌吐槽', '文艺敏感', '幽默搞笑',
  '沉稳成熟', '软萌粘人', '独立飒爽', '话痨', '慢热', '中二',
]

export const AGE_RANGE_OPTIONS = ['18-22', '23-27', '28-35', '35+']
export const GENDER_OPTIONS = ['不限', '男', '女']
export const RELATIONSHIP_OPTIONS = ['朋友', '暧昧对象', '恋人', '损友', '前辈/同事', '家人']
