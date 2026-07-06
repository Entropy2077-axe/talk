/** Five-dimension relationship model, scored 0-100 like a lightweight MBTI-style profile. */
export interface RelationshipDimensions {
  familiarity: number // 熟悉度 — how much history/context they share
  affection: number // 好感度 — warmth, fondness
  trust: number // 信任度 — willingness to be open/vulnerable
  romance: number // 暧昧度 — romantic/flirtatious charge
  friction: number // 摩擦感 — accumulated tension/annoyance
}

export interface Contact {
  id: string
  name: string // the persona's own name, chosen by the AI at creation time — not user-renameable
  remark?: string // user's own nickname for this contact, like a real contacts app; overrides name for display
  avatar: string // emoji or data URL
  avatarColor: string // fallback background color
  systemPrompt: string // persona description generated at creation time — never shown to the user, never edited after creation
  bio?: string
  createdAt: number
  // ---- adaptive memory ----
  memoryFacts: string // compact known-facts summary about the user, refreshed periodically
  memoryStyle: string // compact notes on how tone/familiarity should adapt to this user over time
  memoryUpdatedAt: number
  memoryMessageCursor: number // number of messages already folded into memory, so updates only look at what's new
  // ---- relationship network (contact's relationship toward the user) ----
  relationship: RelationshipDimensions
  // ---- moments (朋友圈) ----
  lastMomentAt?: number // when this contact last posted a moment, used for the "hasn't posted in 10 min" eligibility check
  pendingEvents?: string[] // short notes about notable things to naturally mention next chat (e.g. "对方刚给你的朋友圈点了赞"), cleared once used
  // ---- upcoming plans/appointments (extracted during memory updates, see memory.ts) ----
  upcomingPlans?: PlanItem[]
  // ---- autonomous behavior (see lib/proactiveChat.ts) ----
  lastProactiveMessageAt?: number // last time this contact proactively opened a chat, used for the per-contact cooldown
  // ---- schedule (see lib/schedule.ts) ----
  schedule?: ScheduleBlock[] // fixed weekly pattern, generated alongside the persona at creation time — optional since contacts created before this feature won't have one
  scheduleOverrides?: ScheduleOverride[] // one-off exceptions negotiated in chat (see the scheduleChange bubble type), pruned once their date passes
  // ---- auto-generated photo avatar (see lib/avatarCategory.ts + lib/photoSearch.ts) ----
  avatarPhotographer?: string // Pexels photographer credit, unset for anime avatars (waifu.pics) or manually-picked emoji/uploads
  avatarPhotographerUrl?: string
  // ---- relationship type label (恋人/朋友/家人 etc., see RELATIONSHIP_OPTIONS in prompt.ts) ----
  // Picked during the creation questionnaire and previously only used as a
  // one-time hint fed into persona generation, then discarded — meaning
  // nothing persistently told the model "you two are dating" on every
  // subsequent turn, just whatever the generated persona text happened to
  // imply. Now persisted and re-injected into the system prompt every turn
  // (see buildSystemPrompt's relationshipType param) so the dynamic doesn't
  // fade over a long conversation. Optional since contacts created before
  // this existed won't have it — editable afterward on ContactCardPage
  // (unlike name/persona, which stay locked after creation) so those can be
  // corrected retroactively.
  relationshipType?: string
}

/** A recurring weekly time block — generated once at contact creation alongside the persona, not user-editable directly. */
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

/** A plan/appointment this contact made with the user, extracted from casual conversation (not the formal paid Commission system) — see memory.ts. Persists across turns until its date passes, unlike pendingEvents which fire once. */
export interface PlanItem {
  id: string
  text: string // short natural-language description, e.g. "周三晚上一起去吃烧烤"
  date?: string // "YYYY-MM-DD" if the model could resolve a concrete date from context, empty/undefined otherwise
  createdAt: number
}

/** A directed relationship link between two AI contacts (set up when adding a contact), used to decide who reacts to whose moments. */
export const CONTACT_RELATION_LABELS = [
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

export interface ContactRelationLink {
  id: string
  fromContactId: string
  toContactId: string
  label: ContactRelationLabel
  createdAt: number
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
  createdAt: number
  memoryMessageCursor?: number // how many of this group's messages have already been folded into members' memory (see memory.ts) — optional since it predates group memory
}

export type MessageRole = 'user' | 'assistant'
export type MessageType = 'text' | 'sticker' | 'link' | 'commission' | 'gift' | 'scheduleChange'

export interface LinkPayload {
  app: string // e.g. 'shop' | 'todo'
  label: string
  data?: Record<string, unknown>
}

export interface CommissionPayload {
  commissionId: string
}

export interface GiftPayload {
  name: string
  icon: string
  description?: string
}

/** Immutable record of an agreed one-off schedule exception, stored directly on the message (no separate mutable status/table — unlike Commission, there's nothing to accept/decline after the fact, the negotiation already happened in the preceding text bubbles). */
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
  content: string // text content, sticker name, link/commission/gift label
  link?: LinkPayload
  commission?: CommissionPayload
  gift?: GiftPayload
  scheduleChange?: ScheduleChangePayload
  bubbleGroupId?: string // groups bubbles emitted from one AI response
  speakerContactId?: string // group chats only: which member persona spoke this assistant bubble
  debugRawAiResponse?: string // admin mode only: raw JSON/text returned by the AI for the turn that produced this bubble
  debugParsedBubble?: AiBubble | GroupAiBubble // admin mode only: parsed bubble payload used to render this message
  createdAt: number
  pending?: boolean // true while an assistant bubble is still "typing" (not yet delivered)
}

export interface Sticker {
  id: string
  name: string
  dataUrl: string
  createdAt: number
}

/** A paid task a contact offers the user in chat — accept/decline is itself sent back as a chat message. */
export type CommissionStatus = 'pending' | 'accepted' | 'declined' | 'completed'

export interface Commission {
  id: string
  contactId: string
  title: string
  description: string
  reward: number // in 金币(coins), set by the AI when it issues the commission, clamped to a sane range
  status: CommissionStatus
  createdAt: number
  respondedAt?: number
  completedAt?: number
}

export interface Todo {
  id: string
  title: string
  note?: string
  done: boolean
  createdAt: number
  completedAt?: number
  source: 'user' | 'commission'
  commissionId?: string // set when source === 'commission'
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
  shopModel: string // separate model selection for shop product generation
  globalSystemPrompt: string
  userNickname: string
  userAvatar: string
  userGender: string
  userBirthday: string // "YYYY-MM-DD", empty if unset
  userBio: string
  walletBalance: number // 金币(coins) the user can spend in the shop
  momentsCoverPhoto: string // data URL for the 朋友圈 page's cover banner, empty until the user sets one
  // ---- autonomous behavior (see lib/proactiveChat.ts) ----
  autonomousBehaviorEnabled: boolean // master switch: AI can post moments / proactively open a chat on a timer while the app is open. Off by default — it makes real API calls without a direct user action.
  proactiveMessageLog?: { date: string; count: number } // rolling daily counter backing the global cap on proactive chat-opens, keyed by local date
  // was a hardcoded const in lib/proactiveChat.ts, moved to user-configurable settings (with the same defaults) — see SettingsPage's "AI自主行为" section
  proactiveDailyCap: number // max proactive chat-opens per day, all contacts combined
  proactiveProbability: number // 0-1, per-tick chance anything happens at all even when someone's eligible
  proactiveSilenceThresholdMs: number // a conversation must have been quiet at least this long to make its contact eligible
  proactiveCooldownMs: number // a contact won't proactively message again until this long has passed since their last one
  // ---- web search (see lib/webSearch.ts) ----
  tavilyApiKey: string // used only by the knowledge-base refresh job, not live during normal chat
  // ---- photo avatars/moments images (see lib/photoSearch.ts) ----
  pexelsApiKey: string // used for landscape/pet/person-photo categories; anime category uses waifu.pics which needs no key
  // ---- worldview (see lib/prompt.ts buildWorldviewDraftPrompt) ----
  worldview: string // shared world-setting text injected into every persona's prompt (chat, group chat, moments) once confirmed; empty until the user sets one
  // ---- knowledge base (see lib/knowledgeBase.ts) ----
  knowledgeQueryLog?: { date: string; count: number } // rolling daily counter backing the cap on reactive keyword-triggered knowledge lookups, keyed by local date
  // ---- admin/dev tooling (see lib/consoleCapture.ts + SkyEyePage) ----
  adminModeEnabled: boolean // master switch for the "天眼" debug page; off by default, entry disappears from DiscoverPage when off
  // ---- appearance ----
  themeMode?: 'light' | 'dark'
  chatBackground?: string // empty = default; otherwise a CSS color or data URL used behind chat messages
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
/** The contact offering the user a paid commission/errand. */
export interface AiBubbleCommission {
  type: 'commission'
  title: string
  description: string
  reward: number
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
export type AiBubble = AiBubbleText | AiBubbleSticker | AiBubbleLink | AiBubbleCommission | AiBubbleScheduleChange

export interface AiResponse {
  messages: AiBubble[]
  /** Sibling of `messages`, not a bubble — up to 2 short topics the model wants the knowledge base to look up (see lib/knowledgeBase.ts), e.g. a slang term the user just used that it doesn't recognize. Optional; most turns won't set this. */
  knowledgeQueries?: string[]
}

// ---- group chat AI output protocol (see lib/groupChat.ts) ----
// Deliberately a smaller protocol than 1:1 (text/sticker only, no
// commission/link) to keep the multi-persona prompt tractable.
export interface GroupAiBubbleText {
  speakerIndex: number // 1-based index into that turn's selected-speakers list
  type: 'text'
  content: string
}
export interface GroupAiBubbleSticker {
  speakerIndex: number
  type: 'sticker'
  name: string
}
export type GroupAiBubble = GroupAiBubbleText | GroupAiBubbleSticker

export interface GroupAiResponse {
  messages: GroupAiBubble[]
  knowledgeQueries?: string[]
}
