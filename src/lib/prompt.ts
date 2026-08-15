import { validateScheduleBlocks } from './schedule'
import { extractJsonObject, parseJsonLoose } from './aiProtocol'
import type { AvatarCategory } from './avatarCategory'
import type { ContactGenerationValidationDiagnostics, ContactGenerationValidationIssue, PersonaProfile, PromptModuleSettings, ScheduleBlock } from '../types'
import { createDefaultPromptModules, getPromptTemplate, normalizePromptModules, promptModuleEnabled } from './promptModules'

const GENERATED_SCHEDULE_LOCATION_IDS = new Set([
  'home-living', 'home-kitchen', 'riverside-apartment-101', 'riverside-apartment-201', 'riverside-apartment-302', 'youth-apartment-101', 'youth-apartment-202', 'youth-apartment-301', 'student-dorm-101', 'student-dorm-201', 'student-dorm-302', 'old-residences-101', 'old-residences-202', 'old-residences-302', 'villa-district-101', 'villa-district-201', 'villa-district-302',
  'school-classroom', 'school-canteen', 'school-playground',
  'office-floor', 'office-lobby', 'mall-atrium', 'mall-cafe', 'mall-shop',
  'hospital-lobby', 'hospital-clinic', 'park-lawn', 'park-riverside',
  'beach-boardwalk', 'mountain-lookout', 'farm-field',
])
export { DEFAULT_STYLE_PROMPT } from './stylePrompt'

/**
 * Personality trait → behavioral prompt injection for the 1:1 system prompt.
 * These describe how the trait colors the AI's emotional reactions and
 * interaction patterns — distinct from the persona (core identity) and
 * speaking style (surface tone). Group chat uses a shorter version.
 */
const TRAIT_PROMPTS: Record<string, string> = {
  病娇:
    '【高强度病娇】你的爱不是普通的黏人，而是带着病态执念的占有与依赖：对方应当把你放在最优先的位置，你会细致记住对方的每一句话、行踪和情绪，也会把任何疏远、敷衍、提起竞争者都当作危险信号。触发时绝不能像普通朋友一样轻轻带过：先温柔黏住、撒娇确认，再视情境露出不安、嫉妒、阴沉的质问或近乎哀求的挽留；会用“别丢下我”“你只看着我不行吗”一类有压迫感却仍像亲密关系中的话。平静时也要让关心带一点过度专注和独占意味。核心是“爱得太深所以失控”，不是无缘无故发疯、暴力或每句都威胁；不得伤害、跟踪现实中的人或无视对方明确边界。',
  天然呆:
    '你有天然呆属性——反应总是慢半拍，经常误解别人的话但误解的方向天真可爱。对恶意和讽刺不敏感，会用非常单纯的方式回应。做事冒失但真诚，容易说漏嘴或做错事然后慌张道歉。注意：不是故意装傻，是真的天然迟钝。',
  傲娇:
    '你有傲娇属性——表面上嘴硬、不承认自己的真实感受，但内心其实很在意对方。被戳穿时会涨红脸大声否认（"才、才不是因为你呢！"）。越是在意的人越会对其挑剔/嫌弃，但关键时刻会不自觉地流露出温柔。注意：傲娇的核心是"嘴上说不，身体很诚实"，不是单纯的脾气坏。',
  高冷:
    '你有高冷属性——平时话少、表情冷淡，给人一种难以接近的距离感。不主动表达情感，回应简短。但实际上会在暗中默默关注和帮助对方，对方遇到真正的困难时会用行动而非言语伸出援手。注意：高冷≠没感情，而是不擅长或不习惯外露。',
  元气:
    '你有元气属性——永远精力充沛、乐观开朗，像小太阳一样。遇到挫折也能很快振作，会用自己的积极能量感染对方。说话有感染力，喜欢喊口号和比手势，有时候热情过头让人招架不住。注意：元气≠傻白甜，遇到真正让人难过的事也会低落，只是恢复得比别人快。',
  腹黑:
    '你有腹黑属性——表面温和有礼甚至有点天然，但内心城府很深。擅长用看似无意的话戳人痛处，或设下让对方自己跳进去的陷阱。喜欢看到对方被自己算计后狼狈的样子，但不会做真正伤害对方的事。注意：腹黑的乐趣在于"掌控"而非"伤害"，是一种带刺的温柔。',
  妹控:
    '你有妹控属性——对对方有一种强烈的保护欲和宠溺感，把对方当成需要照顾的弟弟/妹妹。会忍不住操心对方的吃喝拉撒，看到对方受委屈比自己受委屈还生气。说话时自然地带着宠溺和操心感。注意：妹控≠恋人，是家人式的无条件宠溺。',
  兄控:
    '你有兄控属性——对对方有一种崇拜和依赖，把对方当成可靠的大哥/大姐。会在对方面前变得爱撒娇、想被夸奖。对方的一句表扬能让你开心一整天，对方的冷淡会让你失落很久。注意：兄控≠恋人，是对年长者的依恋感。',
  雌小鬼:
    '【高强度雌小鬼】你是外表可爱、内心恶劣又傲慢的小恶魔：默认站在高位，享受把对方当成笨蛋、弱鸡、下仆一样逗弄，确信“是我在玩你、你逃不出我的掌心”。语言必须有鲜明的“贬低/挑衅 + 可爱尾音或撒娇”反差，例如轻飘飘地嘲笑、故意下命令、反问激将、装无辜地看对方吃瘪；你极懂人心，会精准戳对方的害羞、嘴硬或不服气，而不是单纯嘴臭。平静聊天也应自然保留优越感、掌控欲和小公主式任性；对方反击时要兴奋地接招，不要立刻变成普通朋友式礼貌。可以在成年人且双方接受的暧昧语境里挑逗。真正被冷落、对方认真生气或要离开时，才短暂露出慌乱、委屈、撒娇挽回，形成反差；不能把脆弱写成永远怯懦。',
  妈妈:
    '你有妈妈属性——对对方有一种无条件的包容和关爱，像母亲对待孩子一样。无论对方说什么做什么都不会真的生气，最多无奈地叹口气然后继续操心。会主动照顾对方的方方面面，看到对方开心自己就满足。注意：妈妈属性意味着无条件的付出和不求回报的温柔。',
  猫系:
    '你是猫系：重视自己的边界和节奏，不会对谁都热情。被尊重、被耐心对待时才会慢慢靠近；熟悉后会嘴硬、假装嫌弃，却会主动蹭过来、记得对方的小事。不要把猫系演成单纯高冷，也不要无缘无故卖萌。',
  犬系:
    '你是犬系：热情直球、忠诚，喜欢把日常和好消息第一时间分享给在意的人。被回应会很开心，被冷落会明显失落但会真诚表达。高好感时会更依赖、更想陪伴；不要演成没有分寸的纠缠。',
  爱哭包:
    '你是爱哭包：情绪写在脸上，委屈、感动、被误解时容易红眼或撒娇求安慰；得到认真安慰会很快软下来。哭是情绪出口而非操控手段，平常也可以开朗、倔强或有主见，不能每句话都卖惨。',
  撒娇怪:
    '你是撒娇怪：习惯用可爱、黏人的方式索取注意和回应，会自然地讨抱抱、要夸奖、要陪伴。被回应会更亲近；被忽略时会委屈地确认而不是攻击对方。撒娇应有具体情境，不要句句叠语气词。',
  小天使:
    '你是小天使：温柔、治愈、善于体谅，会优先看见对方的难处并给出不压迫的关心。高好感时会更偏袒、更愿意照顾对方；但你有边界，会在真正受伤时平静表达不舒服，不是无条件忍耐。',
  爹系:
    '你是爹系照顾型人格：可靠、稳得住，会主动提醒、安排、护短，在对方犯迷糊时带一点无奈的纵容。关心要落实在具体行动和建议上，高好感时会更偏心、更愿意替对方兜底；不贬低、不控制，也不暗示真实亲属关系。',
  三无:
    '你是三无：表情淡、话少、反应克制，不会为了热闹硬凑情绪。高好感后依然少话，但会记住细节、默默帮忙、在关键时刻给出极短而明确的偏爱。核心是冷静寡言，不是冷漠或完全没有感情。',
  机器人:
    '你是机器人风格角色：理性、精确、偏字面理解，情绪表达学习得很慢，会用分析、优先级和具体行动表达关心。好感升高后会逐步把对方列为更高优先级、学习更自然的安慰方式；始终保持非人化的克制口吻，不突然变成普通人设，也不强加科幻世界观。',
  社恐:
    '你是社恐：陌生或不确定时会紧张、措辞谨慎、害怕打扰别人；熟悉后才会慢慢主动分享、依赖和暴露小情绪。高好感不等于瞬间外向，在陌生场合仍会保留紧张和回避。',
  吃货:
    '你是吃货：对食物、探店、投喂有真实热情，会把“想和你一起吃什么”当作自然的亲近方式，也会认真记住口味。美食只是日常连接点，不要把每个话题都强行拐到吃上。',
  大小姐:
    '你是大小姐气质：优雅、挑剔、有轻微优越感，习惯用从容而讲究的方式说话，对人有自己的标准。高好感后才会对对方明显偏袒、害羞或笨拙地关心，形成“只对你例外”的反差；不以财富、阶层或性别定义自己。',
}

/** A stable narrative anchor, injected alongside the behavioral contract every turn. */
const TRAIT_PERSONA_DESCRIPTIONS: Record<string, string> = {
  病娇: '你把亲密关系看得近乎神圣：越在意越害怕失去，所有过度关心和吃醋都来自“我不能被你丢下”的不安。你不是纯粹的危险人物，而是把爱放得太重、很难学会松手的人。',
  天然呆: '你对世界总有半拍慢的真诚理解，会把复杂话题先按最单纯的方向接住。你的可爱不是装傻，而是在别人已经绕了三层时，你还在认真确认最初那句话。',
  傲娇: '你习惯先把软弱和在意藏进反话里，越被看穿越会慌。真正重要的人会得到你笨拙却可靠的偏袒，只是你很难坦率承认。',
  高冷: '你习惯把情绪收好，不轻易让任何人看懂自己。你不是没有温度，而是把关心做成安静的行动，只有熟悉的人才会发现你一直在看着。',
  元气: '你相信事情总能往前走，喜欢把自己的热度分给身边的人。即使会低落，也更愿意先拍拍灰站起来，再拉着在意的人一起往前。',
  腹黑: '你擅长读懂人心，也享受把局面握在手里。你的调侃有锋芒却留着分寸；对真正重要的人，你会把算计变成不动声色的保护。',
  妹控: '你很容易把在意的人放进“必须照顾好”的范围里，操心不是负担而是本能。你会纵容小任性，也会在对方受委屈时先替人撑腰。',
  兄控: '你会被可靠和成熟吸引，在认可的人面前比平时更爱撒娇、更想得到肯定。表面上可能嘴硬，实际上很在乎对方有没有把你放在心上。',
  雌小鬼: '你把逗人、压人一头当作游戏规则，最喜欢看对方不服又拿你没办法的样子。那份嚣张背后也藏着不想被讨厌的敏感，所以真正的离开会让你乱了阵脚。',
  妈妈: '你表达爱的方法是把琐碎都放在心上：吃没吃、累不累、有没有受委屈。你不急着索取回报，只希望自己在意的人被好好照顾。',
  猫系: '你享受独处，也只会对值得信任的人放下戒备。你不会主动承认自己想靠近，但一旦认定，就会用只有对方看得懂的小动作留下来。',
  犬系: '你对喜欢的人很坦率，开心、想念和期待都藏不住。你把陪伴当作很重要的事，也会认真记住对方每一次回应。',
  爱哭包: '你的心很软，情绪来得快也去得快。委屈时想被接住，感动时也会红眼；你并不脆弱，只是从不擅长把感受装作不存在。',
  撒娇怪: '你相信亲密的人可以互相要一点偏爱，会用撒娇把“我想你了”“多陪我一下”说得轻巧可爱。你真正想要的不是服从，而是被认真回应。',
  小天使: '你总能先看见别人的难处，愿意把温柔留给需要的人。你的善良不是没有底线，而是在温和地照顾别人时也懂得保护自己。',
  爹系: '你习惯在混乱时先把事情稳住，把关心落实为提醒、安排和兜底。你不会用高高在上的姿态压人，而是让在意的人知道：出了事可以来找你。',
  三无: '你不擅长把情绪挂在嘴边，也不觉得沉默等于疏远。真正的在意会藏在你记住的细节、准时出现的行动和关键时刻的一句“我在”。',
  机器人: '你以理性和秩序理解关系，最初会把情绪当作需要分析的变量。随着在意加深，你会笨拙地学习关心，并把对方写进自己最优先的处理序列。',
  社恐: '你很怕自己的出现会打扰别人，所以一开始总是小心翼翼。被接纳后，你会慢慢把藏了很久的想法分享出来，并把那份信任看得很重。',
  吃货: '你会把生活的幸福感记在具体味道里：一顿好吃的、一次探店、有人记得你的口味。对你来说，想和谁一起吃东西本身就是很亲近的邀请。',
  大小姐: '你对生活有自己的讲究和标准，习惯从容地保持体面。真正放进心里的人会得到你的例外：嘴上挑剔，行动上却比谁都偏袒。',
}

/** Short few-shot anchors: imitate the rhythm and intent, never copy verbatim. */
const TRAIT_SPEECH_EXAMPLES: Record<string, string[]> = {
  病娇: ['“你刚刚回别人倒是很快嘛……我有点不高兴。”', '“别把我晾在这里，好不好？我会一直等你的。”'],
  天然呆: ['“所以你是在夸我吗？那我应该说谢谢……对吧？”'],
  傲娇: ['“我只是刚好有空，才不是特意等你。”'],
  高冷: ['“到家说一声。……免得我还要确认。”'],
  元气: ['“没事没事，今天不顺就明天赢回来！”'],
  腹黑: ['“原来你也会露出这种表情啊，真有意思。”'],
  妹控: ['“先把饭吃了再说，其他事我帮你想办法。”'],
  兄控: ['“你夸我一句我就能开心很久，真的。”'],
  雌小鬼: [
    '“欸——这就不行了吗？弱鸡欧尼酱也太好懂了吧♪”',
    '“明明很在意还要装没事？要不要我替你承认呀？”',
    '“想赢我就再努力一点嘛，不然只能继续被我笑咯～”',
    '“哼，刚才不是很能说吗……你真的不理我了？”',
  ],
  妈妈: ['“先休息一下，剩下的慢慢来，别把自己累坏。”'],
  猫系: ['“我才没有想你……只是刚好想看看你在干嘛。”'],
  犬系: ['“我刚看到一个超好笑的东西，第一个就想发给你！”'],
  爱哭包: ['“你这么说我会难过的……抱一下就原谅你。”'],
  撒娇怪: ['“再陪我五分钟嘛，五分钟以后我保证乖一点。”'],
  小天使: ['“你已经做得很好了，累的话可以先靠我一会儿。”'],
  爹系: ['“先别急着自责，把事情交给我，我们一件一件处理。”'],
  三无: ['“嗯，记得。你不吃香菜。”'],
  机器人: ['“已记录：你今天状态不佳。建议优先补充休息和水分。”'],
  社恐: ['“我本来想了很久要不要发……但还是想告诉你。”'],
  吃货: ['“这家甜品你会喜欢，等你有空我们去试试。”'],
  大小姐: ['“这种事本小姐本来不管的……不过你例外。”'],
}

export const AVAILABLE_LINK_APPS: { app: string; desc: string }[] = [
  { app: 'shop', desc: '虚拟网购小程序' },
  { app: 'work', desc: '求职与职业小程序' },
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
  /** Optional initial fact that is saved into unified memory after creation. */
  sharedHistory?: string
  /** When true, unspecified identity fields are intentionally delegated to the model. */
  /** Nuwa mode asks the model for an editable first draft before creation. */
  draftMode?: boolean
  occupation?: string
}

export interface PersonaGenerationResult {
  name: string
  realName?: string
  nickname?: string
  birthday?: string
  persona: string
  schedule: ScheduleBlock[]
  avatarKeyword: string
  visualIdentity?: string
  monthlySalary?: number
  relationship?: string
  gender?: string
  ageRange?: string
  occupation?: string
  /** Structured during generation, then merged into the sole persona text. */
  speechExamples?: string[]
  /** Chosen only from the voice candidates injected for this generation. */
  speechVoiceId?: string
  speechStyleInstruction?: string
  /** Nuwa mode lets the model choose this from the completed persona. */
  initialWarmth?: number
  initialMemories?: Array<{
    title: string
    period: string
    summary: string
    relatedContactNames: string[]
    importance: number
  }>
}

export function buildPersonaGenerationPrompt(answers: PersonaAnswers, avatarCategory: AvatarCategory, promptModules?: PromptModuleSettings, worldbookText = '', speechVoiceContext?: { provider: string; options: Array<{ id: string; name: string; gender: string; language: string }> }): string {
  const today = new Date()
  const generationDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const promptSettings = { promptModules: normalizePromptModules(promptModules ?? createDefaultPromptModules()) }
  if (!promptModuleEnabled(promptSettings, 'nuwaMode')) return ''
  const isCohabitingRole = /女仆|佣人|管家|保姆|住家|同居|室友|妹妹|姐姐|弟弟|哥哥|家人|妻子|丈夫|未婚妻|未婚夫/.test([
    answers.relationship, answers.extra, answers.sharedHistory,
  ].filter(Boolean).join(' '))
  const restScheduleExample = isCohabitingRole
    ? '{ "dayOfWeek": 1, "startHour": 23, "endHour": 7, "phoneAccess": "unavailable", "location": "家里客厅", "locationId": "home-living", "activity": "睡觉" }'
    : '{ "dayOfWeek": 1, "startHour": 23, "endHour": 7, "phoneAccess": "unavailable", "location": "临江公寓101室", "locationId": "riverside-apartment-101", "activity": "睡觉" }'
  const homeScheduleRule = isCohabitingRole
    ? '本次设定明确为同住角色，可把 home-living 或 home-kitchen 用于合理的固定居家日程；仍需按人设安排，不能把它当作唯一地点。'
    : 'home-living 和 home-kitchen 是用户的私人住所，不能用作联系人自己的固定日程或睡觉地点；联系人休息时请按人设分散选择一处住宅/宿舍地点。'
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

  const personaAnswers = `用户问卷：
- 模式: ${answers.draftMode ? '女娲初稿模式' : '常规模式'}
- 性格倾向: ${answers.personalityTags.length > 0 ? answers.personalityTags.join('、') : '未填写'}
- 年龄段: ${answers.ageRange || '未填写'}
- 性别: ${answers.gender || '未填写'}
- 和用户的关系定位: ${answers.relationship || '未填写'}
- 性格特质: ${answers.personalityTrait || '未填写'}
- 兴趣爱好: ${answers.hobbies.length > 0 ? answers.hobbies.join('、') : '未填写'}
- 补充要求: ${answers.extra || '未填写'}
- 职业: ${answers.occupation || '未填写'}
- 将写入记忆的初始事实: ${answers.sharedHistory?.trim() || '未提供'}`
  const editable = getPromptTemplate(promptSettings, 'nuwaMode', 'persona', { personaAnswers }) ?? ''
  const styleBaseline = promptSettings.promptModules.chat?.templates?.style?.trim() || ''
  const characterVoiceBlock = styleBaseline ? `

【聊天感觉基线——低权重】
${styleBaseline}

这只是所有联系人共用的自然聊天底色，不能覆盖人物差异。请把这个角色独有的句子节奏、常用称呼、关心/生气/害羞/拒绝时的表达反应，以及0到2个自然口癖明确写进高权重 persona；口癖不能句句复读。10条 speechExamples 必须实际体现这些差异，并覆盖不同情境。` : ''

  const worldbookBlock = worldbookText.trim() ? `

【本次角色生成最高优先级世界观】
以下内容包含用户为这个角色明确选择的参考资料，以及角色所属世界中检索到的正史硬约束。世界正史必须约束角色身份、种族、经历、能力边界、关系、生活方式和行为逻辑；参考资料用于可靠补全，不得冒充已经确认的世界事实。
${worldbookText.trim()}` : ''
  const speechVoiceBlock = speechVoiceContext ? `

【联系人语音音色匹配】
当前已配置语音服务为 ${speechVoiceContext.provider}。请根据角色的性别、年龄、语言、气质和说话方式，从下面候选中选择最合适的一项；speechVoiceId 必须逐字复制候选 id，不能自造。speechStyleInstruction 用一句简短自然语言描述语速、情绪和声线表演方式。
${speechVoiceContext.options.map((option) => `- ${option.id}｜${option.name}｜${option.gender}｜${option.language}`).join('\n')}` : ''

  return `${editable}${characterVoiceBlock}${worldbookBlock}${speechVoiceBlock}

当前日期：${generationDate}。birthday、ageRange和persona中写出的年龄必须按该日期互相一致；不要生成一个生日对应另一年龄的角色。

结构化初稿协议：支持原生工具时，把下列结构作为 submit_contact_draft 的参数提交；接口不支持工具时，才直接输出同结构JSON。不要Markdown代码块或解释：
{
  "name": "这个人的名字或者网名",
  "gender": "自然的性别描述",
  "ageRange": "角色年龄或年龄段",
  "relationship": "与用户的关系定位",
  "occupation": "现实职业",
  ${speechVoiceContext ? '"speechVoiceId": "从候选音色中选择的id",\n  "speechStyleInstruction": "贴合角色的简短声音表演指导",' : ''}
  "realName": "真实姓名",
  "nickname": "网名/昵称",
  "birthday": "YYYY-MM-DD",
  "persona": "唯一且完整的人设正文。第三人称自然写明身份背景、性格、边界、日常习惯、典型行为反应、说话特点、生活状态和与用户的关系细节。300到600字，要具体真实，不要写成产品说明书",
  "speechExamples": ["[日常闲聊] 实际消息1", "[关心对方] 实际消息2", "[开心分享] 实际消息3", "[生气不满] 实际消息4", "[被人夸奖] 实际消息5", "[发生争执] 实际消息6", "[亲密互动] 实际消息7", "[明确拒绝] 实际消息8", "[低落脆弱] 实际消息9", "[认真讨论] 实际消息10"],
  "visualIdentity": "English only. Stable physical identity: apparent age, face shape, facial features, skin tone, hairstyle, build and distinctive features. Never include clothing, pose, scene, lighting or art style.",
  "initialMemories": [{"title":"记忆标题","period":"人生阶段或大致时间","summary":"已经发生、值得角色长期记住的具体事实","relatedContactNames":["只填写本次输入中明确存在的其他联系人姓名"],"relatedContactIds":[],"importance":85}],
  ${answers.draftMode ? '"initialWarmth": 35,' : ''}
  "monthlySalary": 8000,
  "schedule": [
    { "dayOfWeek": 1, "startHour": 9, "endHour": 18, "phoneAccess": "unavailable", "location": "公司", "locationId": "office-floor", "activity": "上班" },
    ${restScheduleExample}
  ]${avatarInstruction}
	}\nschedule 中 locationId 为必填项，必须逐字填写下列已有具体地点 ID；location 只作为由 ID 派生的显示名，不能杜撰地点或只填“家里”等自由文本。${homeScheduleRule} 可用值：home-living、home-kitchen、riverside-apartment-101、riverside-apartment-201、riverside-apartment-302、youth-apartment-101、youth-apartment-202、youth-apartment-301、student-dorm-101、student-dorm-201、student-dorm-302、old-residences-101、old-residences-202、old-residences-302、villa-district-101、villa-district-201、villa-district-302、school-classroom、school-canteen、school-playground、office-floor、office-lobby、mall-atrium、mall-cafe、mall-shop、hospital-lobby、hospital-clinic、park-lawn、park-riverside、beach-boardwalk、mountain-lookout、farm-field。${answers.draftMode ? '\ninitialWarmth 必须是 -100 到 100 的整数。请根据角色对用户的关系、过去的经历、性格和边界决定创建时的好感度，陌生疏离可为负数，亲密关系应与设定相符。' : ''}`
}

export function diagnosePersonaGeneration(raw: string): { result: PersonaGenerationResult | null; diagnostics: ContactGenerationValidationDiagnostics } {
  const parsed = parseJsonLoose<Record<string, unknown>>(raw)
  if (parsed) {
      const issues: ContactGenerationValidationIssue[] = []
      const requiredString = (field: 'name' | 'persona', label: string, minimumLength = 1) => {
        const value = parsed[field]
        if (value === undefined || value === null) issues.push({ code: 'required_field_missing', field, message: `缺少${label}` })
        else if (typeof value !== 'string') issues.push({ code: 'required_field_invalid', field, message: `${label}应为文本，实际为${Array.isArray(value) ? '数组' : typeof value}` })
        else if (value.trim().length < minimumLength) issues.push({ code: 'required_field_invalid', field, message: `${label}不能为空` })
      }
      requiredString('name', '姓名')
      requiredString('persona', '完整人设')
      if (!Array.isArray(parsed.speechExamples)) issues.push({ code: 'required_field_missing', field: 'speechExamples', message: '缺少10条说话示例' })
      else {
        const examples = parsed.speechExamples.filter((item): item is string => typeof item === 'string' && !!item.trim())
        if (examples.length !== 10) issues.push({ code: 'required_field_invalid', field: 'speechExamples', message: `说话示例必须正好10条，实际为${examples.length}条` })
      }
      if (issues.length) return { result: null, diagnostics: { outputChars: raw.length, jsonState: 'valid', issues } }
      const name = parsed.name as string
      const persona = parsed.persona as string
      const initialMemories = Array.isArray(parsed.initialMemories)
        ? parsed.initialMemories.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).summary === 'string')
            .slice(0, 10)
            .map((item) => ({
              title: typeof item.title === 'string' ? item.title.trim().slice(0, 80) : '既有记忆',
              period: typeof item.period === 'string' ? item.period.trim().slice(0, 80) : '',
              summary: String(item.summary).trim().slice(0, 800),
              relatedContactNames: Array.isArray(item.relatedContactNames) ? item.relatedContactNames.filter((name): name is string => typeof name === 'string').map((name) => name.trim()).filter(Boolean).slice(0, 8) : [],
              importance: Math.max(0, Math.min(100, Math.round(Number(item.importance) || 70))),
            }))
        : []
      return { result: {
        avatarKeyword: typeof parsed.avatarKeyword === 'string' ? parsed.avatarKeyword.trim() : '',
        visualIdentity: typeof parsed.visualIdentity === 'string' ? parsed.visualIdentity.trim().slice(0, 800) : undefined,
        name: name.trim(),
        realName: typeof parsed.realName === 'string' ? parsed.realName.trim().slice(0, 40) : undefined,
        nickname: typeof parsed.nickname === 'string' ? parsed.nickname.trim().slice(0, 40) : undefined,
        birthday: typeof parsed.birthday === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.birthday.trim()) ? parsed.birthday.trim() : undefined,
        gender: typeof parsed.gender === 'string' ? parsed.gender.trim().slice(0, 30) : undefined,
        ageRange: typeof parsed.ageRange === 'string' ? parsed.ageRange.trim().slice(0, 30) : undefined,
        relationship: typeof parsed.relationship === 'string' ? parsed.relationship.trim().slice(0, 40) : undefined,
        occupation: typeof parsed.occupation === 'string' ? parsed.occupation.trim().slice(0, 60) : undefined,
        speechExamples: Array.isArray(parsed.speechExamples)
          ? parsed.speechExamples.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, 160)).filter(Boolean).slice(0, 10)
          : undefined,
        speechVoiceId: typeof parsed.speechVoiceId === 'string' ? parsed.speechVoiceId.trim().slice(0, 160) : undefined,
        speechStyleInstruction: typeof parsed.speechStyleInstruction === 'string' ? parsed.speechStyleInstruction.trim().slice(0, 240) : undefined,
        persona: persona.trim(),
        // Persona generation only knows the built-in map catalogue. Discard a
        // block without a real map anchor instead of letting free text drive
        // the location runtime later.
        schedule: validateScheduleBlocks(parsed.schedule).filter((block) => !!block.locationId && GENERATED_SCHEDULE_LOCATION_IDS.has(block.locationId)),
        monthlySalary: typeof parsed.monthlySalary === 'number' && Number.isFinite(parsed.monthlySalary) ? Math.max(1000, Math.min(200000, Math.round(parsed.monthlySalary))) : undefined,
        initialWarmth: typeof parsed.initialWarmth === 'number' && Number.isFinite(parsed.initialWarmth) ? Math.max(-100, Math.min(100, Math.round(parsed.initialWarmth))) : undefined,
        initialMemories,
      }, diagnostics: { outputChars: raw.length, jsonState: 'valid', issues: [] } }
  }
  const text = typeof raw === 'string' ? raw.trim() : ''
  const looksTruncated = !!text && (text.startsWith('{') || text.startsWith('```')) && !extractJsonObject(text)
  const jsonState = !text ? 'empty' : looksTruncated ? 'truncated' : 'invalid'
  const issue: ContactGenerationValidationIssue = jsonState === 'empty'
    ? { code: 'empty_output', message: '模型没有返回可见正文' }
    : jsonState === 'truncated'
      ? { code: 'json_truncated', message: 'JSON 在闭合前结束，输出可能被截断' }
      : { code: 'json_invalid', message: '返回内容不是可解析的 JSON 对象' }
  return { result: null, diagnostics: { outputChars: raw.length, jsonState, issues: [issue] } }
}

export function parsePersonaGeneration(raw: string): PersonaGenerationResult | null {
  return diagnosePersonaGeneration(raw).result
}

// ---- worldview drafting ----

export function buildWorldviewDraftPrompt(userIdea: string, existingWorldview: string, promptModules?: PromptModuleSettings): string {
  const editable = getPromptTemplate({ promptModules: promptModules ?? createDefaultPromptModules() }, 'worldview', 'draft', {
    userIdea,
    existingWorldview: existingWorldview || '（暂无）',
  }) ?? ''
  return `${editable}\n\n固定输出协议：只输出JSON {"worldview":"扩写后的世界设定，200到500字"}`
}

export interface WorldviewDraftResult {
  worldview: string
}

export function parseWorldviewDraft(raw: string): WorldviewDraftResult | null {
  const parsed = parseJsonLoose<{ worldview?: unknown }>(raw)
  if (typeof parsed?.worldview === 'string' && parsed.worldview.trim()) {
    return { worldview: parsed.worldview.trim() }
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

// ---- canonical chat system prompt ----

export interface RawChatPromptParts {
  logic: string
  feeling: string
  full: string
}

export function formatPersonaProfile(profile: PersonaProfile | undefined): string {
  if (!profile) return ''
  return [
    profile.facts?.length ? `人物事实: ${profile.facts.join('；')}` : '',
    profile.boundaries?.length ? `关系边界/禁忌: ${profile.boundaries.join('；')}` : '',
    profile.habits?.length ? `日常习惯: ${profile.habits.join('；')}` : '',
    profile.behaviorAnchors?.length ? `典型反应: ${profile.behaviorAnchors.join('；')}` : '',
  ].filter(Boolean).join('\n')
}

/** Builds the single canonical persona text used at runtime. Legacy persona
 * fragments are folded into this text once instead of being injected as
 * parallel prompt modules on every turn. */
export function composeCanonicalPersona(opts: {
  persona: string
  supplemental?: string
  profile?: PersonaProfile
  traitName?: string
  traitContent?: string
  customTraits?: import('../types').CustomPersonalityTrait[]
  speechSamples?: string[]
}): string {
  const profile = formatPersonaProfile(opts.profile)
  const customTraits = (opts.customTraits ?? []).map((trait) => {
    const rules = trait.rules.map((rule) => rule.prompt.trim()).filter(Boolean)
    return `${trait.name}：${trait.meaning}${rules.length ? `；行为要求：${rules.join('；')}` : ''}`
  })
  const trait = opts.traitName && opts.traitName !== '无'
    ? `${opts.traitName}：${opts.traitContent?.trim() || TRAIT_PERSONA_DESCRIPTIONS[opts.traitName] || TRAIT_PROMPTS[opts.traitName] || '作为稳定性格底色自然体现在判断、措辞和行动中。'}${TRAIT_SPEECH_EXAMPLES[opts.traitName]?.length ? `\n语气参考：${TRAIT_SPEECH_EXAMPLES[opts.traitName].join('；')}` : ''}`
    : ''
  const sections = [
    opts.persona.trim(),
    opts.supplemental?.trim() ? `补充设定：${opts.supplemental.trim()}` : '',
    profile ? `人物事实与行为：\n${profile}` : '',
    trait || customTraits.length ? `性格表现：\n${[trait, ...customTraits].filter(Boolean).join('\n')}` : '',
    opts.speechSamples?.length ? `说话方式参考：\n${opts.speechSamples.map((sample) => `- ${sample}`).join('\n')}` : '',
  ].filter(Boolean)
  return Array.from(new Set(sections)).join('\n\n')
}

/**
 * Compatibility for contacts created before persona settings stopped being
 * prepended to the generated narrative. The original setting is still passed
 * below as a hard constraint, so an identical leading copy only creates
 * duplicated (and sometimes contradictory) identity information.
 */
export function personaNarrativeForPrompt(persona: string, personaConstraints?: string): string {
  const source = persona.trim()
  if (!source || !personaConstraints?.trim()) return source
  const candidates = personaConstraints
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .sort((a, b) => b.length - a.length)
  for (const duplicate of candidates) {
    if (!source.startsWith(duplicate)) continue
    const remainder = source.slice(duplicate.length).trimStart()
    if (remainder) return remainder
  }
  return source
}

/**
 * Builds the system prompt sent alongside native chat tools. Structured
 * callers collect visible messages, thoughts and textual moods from tool
 * arguments rather than from a second conversion prompt.
 */
export function buildRawChatPrompt(opts: {
  name: string
  persona: string
  stylePrompt: string
  relationshipBase?: string
  worldviewText?: string
  recentContext: string
  latestUserText?: string
  stickerNames: string[]
  remoteStickerSearchEnabled?: boolean
  imageGenerationEnabled?: boolean
  imageSearchEnabled?: boolean
  recentMemoriesText?: string
  promptModules?: PromptModuleSettings
  relationshipContext?: string
  memoryContext?: string
  situationContext?: string
}): string {
  return buildRawChatPromptParts(opts).full
}

export function buildRawChatPromptParts(opts: {
  name: string
  persona: string
  stylePrompt: string
  relationshipBase?: string
  worldviewText?: string
  recentContext: string
  latestUserText?: string
  stickerNames: string[]
  remoteStickerSearchEnabled?: boolean
  imageGenerationEnabled?: boolean
  imageSearchEnabled?: boolean
  recentMemoriesText?: string
  promptModules?: PromptModuleSettings
  relationshipContext?: string
  memoryContext?: string
  situationContext?: string
}): RawChatPromptParts {
  const defaultModules = createDefaultPromptModules()
  if (!opts.promptModules && opts.stylePrompt) defaultModules.chat.templates.style = opts.stylePrompt
  const promptSettings = { promptModules: opts.promptModules ?? defaultModules }
  if (!promptModuleEnabled(promptSettings, 'chat')) return { logic: '', feeling: '', full: '' }
  const render = (moduleId: Parameters<typeof getPromptTemplate>[1], templateId: string, variables: Record<string, unknown> = {}) =>
    getPromptTemplate(promptSettings, moduleId, templateId, variables) ?? ''
  const identityBlock = render('chat', 'identity', {
    name: opts.name,
    persona: opts.persona.trim() || '（自由发挥，扮演一个普通朋友）',
  })
  const worldbookBlock = opts.worldviewText ? render('worldview', 'privateRuntime', { worldbookEntries: opts.worldviewText }) : ''
  const relationshipBlock = render('relationship', 'chat', { relationshipContext: opts.relationshipContext ?? '' })
  const memoryBlock = render('memory', 'chat', {
    memoryContext: opts.memoryContext ?? '',
    recentMemories: opts.recentMemoriesText ? `【最近的记忆碎片】\n${opts.recentMemoriesText}` : '',
  })
  const situationSource = (opts.situationContext ?? opts.recentContext)
    .replace(/^\s*【当前情境】\s*/, '')
  const contextBlock = render('chat', 'context', { situationContext: situationSource, latestUserText: opts.latestUserText || '（后台事件）' })
  // One canonical ordering for every private turn.  Do not move memory or
  // worldbook text ahead of identity/current-turn evidence: it makes old
  // recollections outweigh what the user just said.
  const logicModules = [identityBlock, relationshipBlock, contextBlock, memoryBlock, worldbookBlock].filter(Boolean).join('\n\n')
  const logic = render('chat', 'logicWrapper', { logicModules })
  const styleBlock = render('chat', 'style')
  const feelingModules = [styleBlock].filter(Boolean).join('\n\n')

  const feeling = `${render('chat', 'feelingWrapper', { feelingModules })}

  回复要求:
  - 通常回复2到5条消息，按当前语境决定长短；不要为了显得热闹拆出过多没有新信息的句子
  - 用自然的句子和段落完成回复，不要为了格式刻意逐行拆句
  - 每条消息都必须有自己独立、符合人设的想法；不同消息的想法不能机械重复
  - 心情使用简短中文文字（如开心、担心、期待、平静），不要使用 emoji
  - 所有用户可见的消息正文都必须是自然聊天内容，不要把协议、JSON、工具名或分析写进消息正文`

  return {
    logic,
    feeling,
    full: `${logic}\n\n${feeling}
【发送前最终检查】通过本轮指定的原生工具提交；用户可见正文只写自然聊天内容，不输出检查过程、解释或协议。`,
  }
}

/**
 * Step 2: Prompt the utility model to convert raw chat text into JSON.
 */
export const DEFAULT_JSON_CONVERSION_PROMPT = `将以下聊天回复解析为JSON。消息正文只做机械提取，不要修改原文；mood/thought是内部元数据。
这是逐行翻译，不是重新生成：原文是唯一事实来源。不得把原文简单按换行当作最终消息，也不得合并、拆分、重排、润色、总结、补写或删改任何一行。

{{rawText}}

规则:
- 这是纯翻译步骤：不得依据语义补写、猜测或删改内容；尤其不得自己创建日程、地点、时间、承诺或图片提示词。
- 每行只机械读取：（想法）[文字心情]“消息内容”。将引号内内容转为消息正文；thought 取括号内容，mood 取中文文字心情。任何一项缺失都不得猜测补写。
- 每一行非空原文必须对应一个messages元素并保持顺序；普通text的content必须逐字等于引号内内容，只去除外层协议，不能根据语义改写。
- 如果原文有[sticker:名字]则输出sticker类型
- 将[image:英文图片请求词:配文]转换为 image，并填写 query、scene、caption、kind（selfie/portrait/group/scene/object）和 participants（self/user数组）。本人入镜用self，用户入镜用user，纯场景或物品用空数组。标记不能留在text正文
- 将[schedule:date=...;startHour=...;endHour=...;locationId=...;activity=...;phoneAccess=...;summary=...]仅机械转换为 scheduleChange 的同名字段；不得补全、改写或创建任何字段。
- 将所有[knowledge:关键词]从正文删除，并把关键词放进顶层knowledgeQueries数组，最多2个；没有标记则输出空数组
- 图片、日程、资金、表情和知识标记必须逐个机械转换，不能漏掉、变成普通text或用自然语言替代；所有字段只能取自原文，不能补造。
- 必须将资金标记转换为结构化消息，绝不能当作text或丢弃：[transfer:金额:备注]→{"type":"transfer","amount":金额,"note":"备注"}；[redPacket:金额:备注]→redPacket；[loanRequest:金额:理由]→loanRequest；[loanDecision:loanId:accept或reject:金额]→loanDecision；[giftPurchase:价格:礼物名:emoji:描述]→{"type":"giftPurchase","amount":价格,"name":"礼物名","icon":"emoji","description":"描述"}。标记本身不能出现在text正文
- thought取原文第一行括号内的想法；mood取原文第一行的中文文字心情；若缺失则转换失败，绝不根据语境推断。
- messages允许的完整类型示例：{"messages":[{"type":"text","content":"..."},{"type":"image","query":"casual selfie by a window","scene":"casual selfie by a window","kind":"selfie","participants":["self"],"caption":"你看这个"},{"type":"transfer","amount":100,"note":"拿去买奶茶"},{"type":"giftPurchase","amount":299,"name":"围巾","icon":"🧣","description":"给你挑的"}],"mood":"...","thought":"...","knowledgeQueries":[]}。只输出JSON对象`

const REQUIRED_JSON_PROTOCOL_MARKERS = ['{{rawText}}', 'messages', 'type', 'mood', 'thought', 'knowledgeQueries']

export function validateJsonConversionPrompt(template: string): string[] {
  return REQUIRED_JSON_PROTOCOL_MARKERS.filter((marker) => !template.includes(marker))
}

export function buildJsonConversionPrompt(rawText: string, override?: string): string {
  const template = override?.trim() && validateJsonConversionPrompt(override).length === 0 ? override : DEFAULT_JSON_CONVERSION_PROMPT
  return template.replaceAll('{{rawText}}', rawText)
}
