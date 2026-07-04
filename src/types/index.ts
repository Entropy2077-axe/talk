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
}

export interface Conversation {
  id: string
  contactId: string
  pinned: boolean
  updatedAt: number
  createdAt: number
}

export type MessageRole = 'user' | 'assistant'
export type MessageType = 'text' | 'sticker' | 'link' | 'commission' | 'gift'

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

export interface Message {
  id: string
  conversationId: string
  role: MessageRole
  type: MessageType
  content: string // text content, sticker name, link/commission/gift label
  link?: LinkPayload
  commission?: CommissionPayload
  gift?: GiftPayload
  bubbleGroupId?: string // groups bubbles emitted from one AI response
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
export type AiBubble = AiBubbleText | AiBubbleSticker | AiBubbleLink | AiBubbleCommission

export interface AiResponse {
  messages: AiBubble[]
}
