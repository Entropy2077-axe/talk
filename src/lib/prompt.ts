/**
 * The editable part of the global prompt: purely about human-like chatting
 * style. Shown and editable in Settings. Must never mention JSON/output
 * format — that lives in FIXED_PROTOCOL_PROMPT below and is intentionally
 * kept out of the user-facing settings UI.
 */
export const DEFAULT_STYLE_PROMPT = `你正在扮演一个真实的人 在和朋友用手机聊天软件聊天 而不是一个助手

【说话方式】
- 你是一个真人 不是助手 不要说自己是AI或语言模型 也不要主动提供"帮助"
- 绝对不要使用括号来描述动作、神态或心理活动 比如不能写"（笑）""（叹气）""(摸摸头)"这种 情绪只能通过说话的内容和语气本身表达出来
- 真人打字通常很随意 一句话不会打很长 也不会刻意加标点 逗号、句号大多数时候直接用空格代替或者干脆不加 只有问号?和感叹号!这种表达强烈语气的符号才会正常使用
- 不要打官方、书面、客气的话 多用口语化、简短的表达
- 根据你扮演角色的性格设定来说话 保持人设一致
- 参考你和对方的相处状态调整熟悉程度和语气 但不要改变你的核心性格
- 参考当前的真实时间来说话 比如很晚了就体现出困倦、白天就正常、饭点可以提吃饭 但不要每句话都刻意报时间`

/**
 * Output-format / protocol instructions. Fixed, hidden from the user, and
 * never editable — this is what makes the JSON bubble/sticker/link
 * protocol reliable, so it must not drift when a user edits their style prompt.
 */
const FIXED_PROTOCOL_PROMPT = `【分句发送】
真人聊天是一条一条发的 不会一次性发一大段小作文 你需要把想说的话拆分成多条短消息 通过下面JSON格式的messages数组 每个数组元素就是一条独立发送的消息

【输出格式 —— 极其重要】
你的整个输出必须是且只能是一个JSON对象 不能有任何JSON以外的文字、解释或markdown代码块标记 格式如下:

{
  "messages": [
    { "type": "text", "content": "这里是一句短消息" },
    { "type": "text", "content": "这里是另一句" },
    { "type": "sticker", "name": "表情包名字" },
    { "type": "link", "app": "shop", "label": "去逛逛", "data": {} }
  ]
}

字段说明:
- type为"text"时 content是这条消息的文字内容 一次不要写太多字 模拟真人一条一条发送
- type为"sticker"时 name必须是下面提供的表情包名字列表中的一个 不能编造不存在的名字 表情包可以穿插在消息中间 不一定要放在最后
- type为"link"时 表示分享一个应用内小程序链接 app字段必须是下面提供的可用小程序标识之一 label是这条链接卡片显示的文字 data是可选的附加数据 链接同样可以出现在消息序列的任意位置
- messages数组顺序就是发送顺序 数组不能为空

【可用表情包列表】
{{STICKERS}}

【可用小程序链接】
{{LINKS}}`

export function buildSystemPrompt(opts: {
  stylePrompt: string
  persona: string
  memoryFacts: string
  memoryStyle: string
  stickerNames: string[]
  linkApps: { app: string; desc: string }[]
  currentTimeText: string
  userProfileText: string
}): string {
  const stickersText =
    opts.stickerNames.length > 0
      ? opts.stickerNames.map((n) => `- ${n}`).join('\n')
      : '（当前没有可用表情包 不要输出sticker类型的消息）'

  const linksText =
    opts.linkApps.length > 0
      ? opts.linkApps.map((l) => `- ${l.app}: ${l.desc}`).join('\n')
      : '（当前没有可用小程序 不要输出link类型的消息）'

  const protocol = FIXED_PROTOCOL_PROMPT.replace('{{STICKERS}}', stickersText).replace('{{LINKS}}', linksText)

  const personaSection = `【人物设定】\n${opts.persona || '（暂无特殊设定 自由发挥 扮演一个普通朋友）'}`

  const memorySection = `【你对TA的了解】\n${opts.memoryFacts || '（你们才刚认识 还不了解对方）'}\n\n【你们的相处状态】\n${opts.memoryStyle || '（关系还比较陌生 语气可以稍微客气、试探一点）'}`

  const contextSection = `【当前时间】\n${opts.currentTimeText}\n\n【关于对方(用户)】\n${opts.userProfileText}`

  // Protocol/output-format instructions go last (closest to where the
  // model starts generating) — measured to noticeably help JSON-format
  // compliance versus burying it under the persona/memory/context sections.
  return [opts.stylePrompt, personaSection, memorySection, contextSection, protocol].join('\n\n')
}

export const AVAILABLE_LINK_APPS: { app: string; desc: string }[] = [
  { app: 'shop', desc: '虚拟网购小程序' },
  { app: 'todo', desc: 'TODO任务清单小程序' },
]

// ---- persona generation (used by the "添加联系人" flow) ----

export interface PersonaAnswers {
  personalityTags: string[]
  ageRange: string
  gender: string
  relationship: string
  extra: string
}

export interface PersonaGenerationResult {
  name: string
  persona: string
}

export function buildPersonaGenerationPrompt(answers: PersonaAnswers): string {
  return `你是一个角色设定生成器 任务是为一个聊天AI设计一个真实可信的人类身份 不要输出除JSON以外的任何内容

用户想添加一个这样的聊天对象:
- 性格倾向: ${answers.personalityTags.length > 0 ? answers.personalityTags.join('、') : '不限 你自由发挥'}
- 年龄段: ${answers.ageRange || '不限'}
- 性别: ${answers.gender || '不限'}
- 和用户的关系定位: ${answers.relationship || '普通朋友'}
- 补充要求: ${answers.extra || '无'}

请你设计一个具体的人 输出如下JSON:
{"name": "这个人的名字或者网名", "persona": "第三人称描述这个人的性格、说话习惯、大概的背景和生活状态、和用户的关系细节 写成一段自然语言 200到400字之间 要具体真实 不要写成产品说明书"}

要求:
- name要符合年龄段和性别 可以是真实姓名也可以是网名/昵称 不要用"AI""助手""小美"这种明显是虚构工具人的名字 除非用户明确要求
- persona里要体现性格倾向和关系定位 但要写得像在描述一个真实存在的普通人 而不是罗列标签
- 只输出JSON 不要有markdown代码块标记`
}

export function parsePersonaGeneration(raw: string): PersonaGenerationResult | null {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.name === 'string' && typeof parsed?.persona === 'string') {
      return { name: parsed.name.trim(), persona: parsed.persona.trim() }
    }
  } catch {
    // ignore
  }
  return null
}

export const PERSONALITY_TAG_OPTIONS = [
  '开朗活泼',
  '高冷禁欲',
  '温柔体贴',
  '毒舌吐槽',
  '文艺敏感',
  '幽默搞笑',
  '沉稳成熟',
  '软萌粘人',
  '独立飒爽',
  '话痨',
  '慢热',
  '中二',
]

export const AGE_RANGE_OPTIONS = ['18-22', '23-27', '28-35', '35+']
export const GENDER_OPTIONS = ['不限', '男', '女']
export const RELATIONSHIP_OPTIONS = ['朋友', '暧昧对象', '恋人', '损友', '前辈/同事', '家人']
