/** Single-dimension warmth model, -100 (hostile) to +100 (bonded) — see lib/relationship.ts. */
export interface Contact {
  id: string
  name: string // the persona's own name, chosen by the AI at creation time — not user-renameable
  remark?: string // user's own nickname for this contact, like a real contacts app; overrides name for display
  avatar: string // emoji or data URL
  avatarColor: string // fallback background color
  systemPrompt: string // persona description generated at creation time — never shown to the user, never edited after creation
  /** User-authored requirements, preserved verbatim as a higher-priority persona source. */
  personaConstraints?: string
  /** Structured anchors generated alongside the narrative persona. */
  personaProfile?: PersonaProfile
  speechSamples?: string[] // short scene-labeled examples generated at creation time, used sparingly to stabilize voice
  bio?: string
  createdAt: number
  // ---- adaptive memory ----
  memoryFacts: string // compact known-facts summary about the user, refreshed periodically
  memoryStyle: string // compact notes on how tone/familiarity should adapt to this user over time
  memoryUpdatedAt: number
  memoryMessageCursor: number // number of messages already folded into memory, so updates only look at what's new
  // ---- relationship (single-dimension warmth, -100 hostile ~ +100 bonded) ----
  /** Absent until the 好感度 module is enabled and the first evaluation runs, or a personality trait with an initial value is assigned. */
  warmth?: number
  relationshipBase: string // label the user picked at creation: 恋人/朋友/家人/... — only changes by explicit user action or explicit model assessment (e.g. "已经分手了")
  relationshipDynamic: string // short natural-language summary of what the relationship currently feels like, updated by the utility model on every memory update
  personalityTrait?: string // 病娇/天然呆/傲娇/无. Affects warmth change rate via traitWarmthModifier; missing/无 = normal.
  /** Short-term emotional state, assessed by the model each turn. Expires after ~30 min. Separate from warmth (long-term relationship). */
  mood?: {
    text: string
    expiresAt: number
  }
  // ---- moments (朋友圈) ----
  lastMomentAt?: number // when this contact last posted a moment, used for the "hasn't posted in 10 min" eligibility check
  pendingEvents?: string[] // short notes about notable things to naturally mention next chat (e.g. "对方刚给你的朋友圈点了赞"), cleared once used
  // ---- upcoming plans/appointments (extracted during memory updates, see memory.ts) ----
  upcomingPlans?: PlanItem[]
  intentQueue?: IntentItem[]
  // ---- autonomous behavior (see lib/proactiveChat.ts) ----
  lastProactiveMessageAt?: number // last time this contact proactively opened a chat, used for the per-contact cooldown
  // ---- schedule (see lib/schedule.ts) ----
  schedule?: ScheduleBlock[] // fixed weekly pattern, generated alongside the persona at creation time — optional since contacts created before this feature won't have one
  scheduleOverrides?: ScheduleOverride[] // one-off exceptions negotiated in chat (see the scheduleChange bubble type), pruned once their date passes
  // ---- MBTI (assigned by the persona-generation AI, not user-picked) ----
  mbti?: string // e.g. "INFP" — a stable personality anchor injected into every chat prompt
  // ---- auto-generated photo avatar (see lib/avatarCategory.ts + lib/photoSearch.ts) ----
  avatarPhotographer?: string // Pexels photographer credit, unset for anime avatars (waifu.pics) or manually-picked emoji/uploads
  avatarPhotographerUrl?: string
  /** Contact-specific output of the self-iteration learner: next-user-turn expectation, relationship rules, and surprise history. */
  selfIterationPrompt?: string
  selfIterationUpdatedAt?: number
  occupation?: string
  monthlySalary?: number
  jobStartedDate?: string
  lastSalaryDate?: string
}

/** A recurring weekly time block — generated once at contact creation alongside the persona, not user-editable directly. */
export interface PersonaProfile {
  facts: string[]
  boundaries: string[]
  habits: string[]
  behaviorAnchors: string[]
}

export interface ScheduleBlock {
  id: string
  dayOfWeek: number // 0=Sun..6=Sat
  startHour: number // 0-23
  endHour: number // 1-24, exclusive
  phoneAccess: 'available' | 'unavailable'
  location: string
  activity: string
}

/** A one-off exception to the recurring schedule for a specific date, produced when the AI agrees to (or itself proposes) a changed plan — see the scheduleChange bubble type in chatEngine.ts. */
export interface ScheduleOverride {
  id: string
  date: string // "YYYY-MM-DD"
  startHour: number
  endHour: number
  phoneAccess: 'available' | 'unavailable'
  location: string
  activity: string
  summary: string // short human-facing text shown in the chat bubble, e.g. "周三晚上：一起吃烧烤"
  createdAt: number
}

/** A plan/appointment this contact made with the user, extracted from casual conversation — see memory.ts. Persists across turns until its date passes, unlike pendingEvents which fire once. */
export interface PlanItem {
  id: string
  text: string // short natural-language description, e.g. "周三晚上一起去吃烧烤"
  date?: string // "YYYY-MM-DD" if the model could resolve a concrete date from context, empty/undefined otherwise
  createdAt: number
  confidence?: number
}

export type IntentKind = 'follow_up' | 'care' | 'avoid' | 'relationship' | 'topic'
export type IntentStatus = 'active' | 'used' | 'dismissed'

export interface IntentItem {
  id: string
  text: string
  kind: IntentKind
  createdAt: number
  expiresAt?: number
  status: IntentStatus
  confidence: number
}

/** A directed relationship link between two AI contacts (set up when adding a contact), used to decide who reacts to whose moments. */
export const CONTACT_RELATION_LABELS = [
  '普通朋友',
  '好朋友',
  '损友',
  '暧昧对象',
  '恋人',
  '家人',
  '前辈/同事',
  '点头之交',
  '看不顺眼',
  '对头',
] as const
export type ContactRelationLabel = (typeof CONTACT_RELATION_LABELS)[number]

export const PERSONALITY_TRAIT_OPTIONS = [
  { value: '病娇', description: '初始好感100且无上限 好感只升不降 被温暖双倍心动 极度占有' },
  { value: '天然呆', description: '反应慢半拍 单纯 情绪变化缓慢 不太会读空气' },
  { value: '傲娇', description: '口是心非 越在意越表现得冷淡 防御心强 不擅长坦率' },
  { value: '高冷', description: '冷淡疏离 不轻易被打动 熟了之后才会放下防备' },
  { value: '元气', description: '乐观开朗 情绪恢复快 不记仇 永远活力满满' },
  { value: '腹黑', description: '表面天然呆般人畜无害 心里什么都记着 不轻易被收买' },
  { value: '妹控', description: '对妹妹系的人天然亲近 其他人较难打开心扉' },
  { value: '兄控', description: '对兄长系的人天然亲近 其他人较难打开心扉' },
  { value: '雌小鬼', description: '表面嘲讽捉弄 来拒去留 嘴上不饶人心里怕被丢下' },
  { value: '妈妈', description: '无底线包容 好感度永远不会下降 初始好感度固定为75' },
  { value: '猫系', description: '尊重边界才会亲近 熟了以后嘴硬但黏人' },
  { value: '犬系', description: '热情直球 忠诚爱分享 被回应会特别开心' },
  { value: '爱哭包', description: '情绪外显 容易委屈 被安慰会迅速心软' },
  { value: '撒娇怪', description: '用撒娇索取关注 被回应会更亲近 被忽略会委屈' },
  { value: '小天使', description: '温柔治愈 善于原谅 但仍有自己的边界' },
  { value: '爹系', description: '可靠照顾型 会提醒护短 不以控制代替关心' },
  { value: '三无', description: '低反应少话 高好感后用行动和细节偏爱表达亲近' },
  { value: '机器人', description: '理性精确 情绪表达迟缓 会逐渐学习关心' },
  { value: '社恐', description: '陌生时紧张克制 熟悉后才会主动分享和依赖' },
  { value: '吃货', description: '以美食和投喂作为日常亲近媒介 不强行聊吃' },
  { value: '大小姐', description: '优雅挑剔 带一点优越感 只对亲近的人例外' },
  { value: '无', description: '普通性格 没有特殊的情绪反应模式' },
] as const
export type PersonalityTrait = (typeof PERSONALITY_TRAIT_OPTIONS)[number]['value']

export const HOBBY_TAG_OPTIONS = [
  '养猫', '养狗', '打游戏', '运动健身', '追剧看电影',
  '看书', '美食探店', '旅行', '音乐', '画画', '摄影', '二次元',
] as const

export interface ContactRelationLink {
  id: string
  fromContactId: string
  toContactId: string
  label: ContactRelationLabel
  /** Same value on both directional records of one user-defined relationship. */
  pairId?: string
  createdAt: number
  /** Stable user-authored label is kept above; these values evolve from shared social experiences. */
  affinity?: number // -100..100, shared dynamic tone for this existing undirected link
  familiarity?: number // 0..100, grows through shared/public interactions
  tension?: number // 0..100, grows through conflict and decays through positive interactions
  dynamicSummary?: string
  lastInteractionAt?: number
}

export interface Moment {
  id: string
  /** Either a contactId, or the literal sentinel 'user' for a moment the app's own user posted themselves. */
  contactId: string
  content: string
  createdAt: number
  // ---- optional attached photo (see lib/photoSearch.ts) — not every moment gets one, code decides ----
  imageUrl?: string
  imagePhotographer?: string
  imagePhotographerUrl?: string
}

export interface MomentComment {
  id: string
  momentId: string
  /** Either a contactId, or the literal sentinel 'user' for a comment the app's own user left. */
  authorContactId: string
  /** May end with a "[sticker:名字]" marker appended directly after the text — see lib/moments.ts's parseCommentSticker. Only AI-authored comments ever contain this. */
  content: string
  createdAt: number
  /** Set when this comment is a reply to a specific earlier comment (WeChat-style "A回复B") rather than a fresh top-level comment — id of that earlier MomentComment. */
  replyToCommentId?: string
}

export interface MomentLike {
  id: string
  momentId: string
  /** Either a contactId, or the literal sentinel 'user' for the app's own user liking a moment. */
  likerId: string
  createdAt: number
}

export type SocialEventType =
  | 'moment_posted'
  | 'moment_liked'
  | 'moment_commented'
  | 'group_targeted_message'
  | 'message_feedback'

export interface SocialEvent {
  id: string
  type: SocialEventType
  /** 'user' or a contact id. */
  actorId: string
  /** 'user', a contact id, or omitted for broadcast events. */
  targetId?: string
  relatedContactIds: string[]
  summary: string
  conversationId?: string
  groupId?: string
  momentId?: string
  messageId?: string
  importance: number
  createdAt: number
  /** Events are short-term context, not permanent prompt ballast. */
  expiresAt?: number
}

export interface Conversation {
  id: string
  contactId?: string // set for a 1:1 chat — exactly one of contactId/groupId is set
  groupId?: string // set for a group chat
  pinned: boolean
  updatedAt: number
  createdAt: number
  lastReadAt?: number // stamped whenever ChatPage has this conversation open; unread count = assistant messages newer than this
}

/** A group chat: still just one LLM call per turn simulating multiple personas (see groupChat.ts), not real independent AI-to-AI agents. */
export interface Group {
  id: string
  name: string
  avatar: string // emoji or data URL, like Contact
  avatarColor: string
  memberContactIds: string[]
  memory?: string // group-level shared memory / lore visible to every member in group prompts
  vibe?: string // group atmosphere, e.g. quiet study group, noisy friends, teasing tone
  speakerLimit?: GroupSpeakerLimit // how many AI members may speak in one group turn
  allowAiChatter?: boolean // true: AIs may optionally talk to each other; false: keep replies user-centered
  energyLevel?: GroupEnergyLevel // controls how many bubbles each selected speaker tends to send
  memoryTurnCount?: number // number of AI turns folded into group.memory; used to compress every few turns
  createdAt: number
  memoryMessageCursor?: number // how many of this group's messages have already been folded into members' memory (see memory.ts) — optional since it predates group memory
}

export type MessageRole = 'user' | 'assistant'
export type MessageType = 'text' | 'sticker' | 'image' | 'link' | 'gift' | 'scheduleChange' | 'transfer' | 'redPacket' | 'loanRequest' | 'loanResult' | 'repayment'
export type GroupSpeakerLimit = 2 | 3 | 4 | 5 | 'all'
export type GroupEnergyLevel = 'cold' | 'normal' | 'lively'

export interface LinkPayload {
  app: string // e.g. 'shop' | 'work'
  label: string
  data?: Record<string, unknown>
}

export interface GiftPayload {
  name: string
  icon: string
  description?: string
}

/** Immutable record of an agreed one-off schedule exception, stored directly on the message (no separate mutable status/table — the negotiation already happened in the preceding text bubbles). */
export interface ScheduleChangePayload {
  date: string
  startHour: number
  endHour: number
  phoneAccess: 'available' | 'unavailable'
  location: string
  activity: string
  summary: string
}

export interface Message {
  id: string
  conversationId: string
  role: MessageRole
  type: MessageType
  content: string // text content, sticker name, link/gift label
  mentions?: string[] // group chats: contact ids explicitly @-mentioned by this message
  replyToMessageId?: string // group chats: message id this message is replying to
  link?: LinkPayload
  gift?: GiftPayload
  image?: { url: string; caption?: string; photographer?: string; photographerUrl?: string; query?: string }
  scheduleChange?: ScheduleChangePayload
  finance?: FinanceMessagePayload
  bubbleGroupId?: string // groups bubbles emitted from one AI response
  speakerContactId?: string // group chats only: which member persona spoke this assistant bubble
  debugAiTurnId?: string // admin mode only: links this bubble to the full AI turn debug payload
  debugRawAiResponse?: string // admin mode only: raw JSON/text returned by the AI for the turn that produced this bubble
  debugParsedBubble?: AiBubble | GroupAiBubble // admin mode only: parsed bubble payload used to render this message
  thought?: string // AI's private thought for this turn — only shown when 读心 module is enabled
  createdAt: number
  pending?: boolean // true while an assistant bubble is still "typing" (not yet delivered)
}

export interface AiTurnDebug {
  id: string
  conversationId: string
  raw: string
  parsed: unknown
  knowledgeQueries: string[]
  createdAt: number
}

export interface Sticker {
  id: string
  name: string
  dataUrl: string
  createdAt: number
}

/** A purchased shop item sitting in the user's warehouse until used or gifted away. */
export interface InventoryItem {
  id: string
  name: string
  description: string
  icon: string // emoji
  price: number // what it cost, kept for reference
  acquiredAt: number
}

export interface AppSettings {
  apiKey: string
  baseUrl: string
  model: string
  utilityModel: string // model for secondary tasks: shop generation, warmth scoring / memory updates, worldview drafts, etc.
  globalSystemPrompt: string
  userNickname: string
  userAvatar: string
  userGender: string
  userBirthday: string // "YYYY-MM-DD", empty if unset
  userBio: string
  walletBalance: number // 金币(coins) the user can spend in the shop
  userOccupation: string
  userMonthlySalary: number
  userJobStartedDate?: string
  userLastSalaryDate?: string
  jobBabyMode: boolean
  walletMigrated?: boolean
  momentsCoverPhoto: string // data URL for the 朋友圈 page's cover banner, empty until the user sets one
  momentsLastReadAt?: number // updated when the user opens MomentsPage; drives Discover red dots
  // ---- autonomous behavior (see lib/proactiveChat.ts) ----
  // Master switch moved to enabledModules['proactiveChat'] — see src/features/proactiveChat.ts
  proactiveMessageLog?: { date: string; count: number } // rolling daily counter backing the global cap on proactive chat-opens, keyed by local date
  // was a hardcoded const in lib/proactiveChat.ts, moved to user-configurable settings (with the same defaults) — see SettingsPage's "AI自主行为" section
  proactiveDailyCap: number // max proactive chat-opens per day, all contacts combined
  proactiveProbability: number // 0-1, per-tick chance anything happens at all even when someone's eligible
  proactiveSilenceThresholdMs: number // a conversation must have been quiet at least this long to make its contact eligible
  proactiveCooldownMs: number // a contact won't proactively message again until this long has passed since their last one
  proactiveMomentsMax: number // max moments to auto-post per background tick (default 3)
  proactiveTickIntervalMs: number // how often the background timer fires (default 5 min)
  // ---- web search (see lib/webSearch.ts) ----
  tavilyApiKey: string // used only by the knowledge-base refresh job, not live during normal chat
  // ---- photo avatars/moments images (see lib/photoSearch.ts) ----
  pexelsApiKey: string // used for landscape/pet/person-photo categories; anime category uses waifu.pics which needs no key
  // ---- worldview (see lib/prompt.ts buildWorldviewDraftPrompt) ----
  worldview: string // shared world-setting text injected into every persona's prompt (chat, group chat, moments) once confirmed; empty until the user sets one
  // ---- knowledge base (see lib/knowledgeBase.ts) ----
  knowledgeQueryLog?: { date: string; count: number } // rolling daily counter backing the cap on reactive keyword-triggered knowledge lookups, keyed by local date
  // ---- admin/dev tooling (see lib/consoleCapture.ts + SkyEyePage) ----
  adminModeEnabled: boolean
  // ---- appearance ----
  themeMode?: 'light' | 'dark'
  chatBackground?: string // empty = default; otherwise a CSS color or data URL used behind chat messages
  currencyIconMode?: 'coin' | 'emoji' | 'yen' | 'dollar'
  customCurrencyEmoji?: string
  /** How long an AI mood lasts before expiring (ms). Default 30 min. */
  moodExpiryMs: number
  /** Shared output of the self-iteration learner: expression habits plus decontextualized user boundaries/preferences. */
  selfIterationGlobalPrompt: string
  selfIterationUpdatedAt?: number
  /** Feature-module toggles — see src/features/. Every module id listed here is active. */
  enabledModules: string[]
}

export type WalletOwnerId = 'user' | string
export type WalletTransactionKind = 'migration' | 'salary' | 'purchase' | 'transfer' | 'red_packet' | 'loan' | 'repayment' | 'admin_adjustment'
export interface WalletAccount { ownerId: WalletOwnerId; balance: number; updatedAt: number }
export interface WalletTransaction {
  id: string; idempotencyKey?: string; kind: WalletTransactionKind; fromOwnerId?: WalletOwnerId; toOwnerId?: WalletOwnerId
  amount: number; note?: string; status: 'completed' | 'reserved' | 'cancelled'; createdAt: number; completedAt?: number
}
export interface Loan {
  id: string; lenderId: WalletOwnerId; borrowerId: WalletOwnerId; principal: number; outstanding: number
  note?: string; status: 'pending' | 'active' | 'rejected' | 'repaid'; createdAt: number; resolvedAt?: number
}
export interface FinanceMessagePayload {
  transactionId?: string; loanId?: string; amount: number; note?: string
  status?: 'pending' | 'completed' | 'claimed' | 'accepted' | 'rejected' | 'repaid'
}
export type JobDifficulty = '入门' | '普通' | '竞争激烈'
export interface JobListing {
  id: string; company: string; title: string; description: string; responsibilities: string[]; requirements: string[]
  monthlySalary: number; difficulty: JobDifficulty; interviewer: string
  status: 'open' | 'interviewing' | 'hired' | 'rejected'; sourceQuery?: string; createdAt: number; hiredBySkip?: boolean
}
export interface InterviewMessage { role: 'interviewer' | 'candidate'; content: string; createdAt: number }
export interface InterviewSession {
  id: string; jobId: string; status: 'active' | 'passed' | 'failed'; round: number; messages: InterviewMessage[]
  score?: number; scoreBreakdown?: Record<string, number>; feedback?: string; createdAt: number; updatedAt: number
}

/** A dated fact about current internet culture (memes/anime/games), gathered by the knowledge-base refresh job — see lib/knowledgeBase.ts. */
export interface KnowledgeEntry {
  id: string
  topic: string // LLM-generated short headline for this specific fact (e.g. "匹诺康尼剧情") — NOT the same as the search query that produced it, don't dedup against this
  content: string
  sourceQuery: string // the original search keyword/topic (e.g. "崩坏：星穹铁道") — this is what dedup compares against, since `topic` is an unrelated sub-headline the model invents per fact
  fetchedAt: number // when this was gathered — surfaced in prompts so the model knows how fresh it is
}

/** A worldview the user has saved to their library (WorldSettingsPage) — separate from `settings.worldview`, which is the single currently-active one. Saving one doesn't activate it; the user picks which saved entry (if any) to make active. */
export interface SavedWorldview {
  id: string
  name: string
  content: string
  createdAt: number
}

// ---- Structured memory (see lib/memory.ts) ----

/** Category bucket for a single memory item — maps roughly to what the item is *about*. */
export type MemoryCategory =
  | '关系动态'   // Relationship dynamics
  | '话题历史'   // Topic history
  | '基础信息'   // Basic info
  | '偏好习惯'   // Preferences / habits
  | '人格特质'   // Personality traits
  | '重要事件'   // Important events
  | '四季日常'   // Daily life / seasonal

/** Granular kind tag for a single memory item — more specific than category. */
export type MemoryKind =
  | 'general'
  | 'user_fact'
  | 'user_preference'
  | 'relationship_event'
  | 'character_promise'
  | 'open_thread'
  | 'world_state'

export type ContactMemoryScope = 'private' | 'group' | 'interpersonal'

/** One structured fact / observation extracted from a conversation and stored in its own row. */
export interface ContactMemory {
  id: string
  contactId: string
  /** private=和用户私聊/普通个人记忆；group=群聊交流记忆；interpersonal=AI和其他AI之间的共同经历/关系记忆 */
  scope?: ContactMemoryScope
  groupId?: string
  relatedContactIds?: string[]
  category: MemoryCategory
  kind: MemoryKind
  content: string
  tags: string[]
  importance: number        // 0-1
  emotionalWeight: number   // 0-1
  confidence: number        // 0-1
  sourceConversationId?: string
  sourceMessageIds: string[]
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  usageCount: number
}

// ---- AI JSON output protocol ----
export interface AiBubbleText {
  type: 'text'
  content: string
}
export interface AiBubbleSticker {
  type: 'sticker'
  name: string
}
export interface AiBubbleLink {
  type: 'link'
  app: string
  label: string
  data?: Record<string, unknown>
}
/** Emitted when the AI agrees to (or itself proposes) a one-off exception to its normal schedule — the negotiation itself happens in plain text bubbles beforehand; this is just the structured record of what was agreed. 1:1 only, not supported in the (deliberately simpler) group chat protocol. */
export interface AiBubbleScheduleChange {
  type: 'scheduleChange'
  date: string // "YYYY-MM-DD"
  startHour: number
  endHour: number
  phoneAccess: 'available' | 'unavailable'
  location: string
  activity: string
  summary: string
}
export interface AiBubbleFinance {
  type: 'transfer' | 'redPacket' | 'loanRequest' | 'loanDecision' | 'giftPurchase'
  amount: number
  note?: string
  loanId?: string
  decision?: 'accept' | 'reject'
  name?: string
  icon?: string
  description?: string
}
export interface AiBubbleImage { type: 'image'; query: string; caption?: string }
export type AiBubble = AiBubbleText | AiBubbleSticker | AiBubbleImage | AiBubbleLink | AiBubbleScheduleChange | AiBubbleFinance

export interface AiResponse {
  messages: AiBubble[]
  /** Short emotional-state summary the model assesses about itself this turn. Required. */
  mood: string
  /** Private thought — what the AI really thinks vs what it says. Required. */
  thought: string
  /** Sibling of `messages`, not a bubble — up to 2 short topics the model wants the knowledge base to look up (see lib/knowledgeBase.ts), e.g. a slang term the user just used that it doesn't recognize. Optional; most turns won't set this. */
  knowledgeQueries?: string[]
}

// ---- group chat AI output protocol (see lib/groupChat.ts) ----
// Deliberately a smaller protocol than 1:1 (text/sticker only, no
// link) to keep the multi-persona prompt tractable.
export interface GroupAiBubbleText {
  speakerIndex: number // 1-based index into that turn's selected-speakers list
  speakerName?: string // debug/conversion hint only; speakerIndex remains authoritative
  type: 'text'
  content: string
  thought?: string
  mood?: string
}
export interface GroupAiBubbleSticker {
  speakerIndex: number
  speakerName?: string
  type: 'sticker'
  name: string
  thought?: string
  mood?: string
}
export interface GroupAiBubbleImage { speakerIndex: number; speakerName?: string; type: 'image'; query: string; caption?: string; thought?: string; mood?: string }
export type GroupAiBubble = GroupAiBubbleText | GroupAiBubbleSticker | GroupAiBubbleImage

export interface GroupAiResponse {
  messages: GroupAiBubble[]
  turnSummary?: string
  groupVibe: string
  memoryCandidates?: { contactName: string; content: string }[]
  knowledgeQueries?: string[]
}
