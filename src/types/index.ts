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
export type MessageType = 'text' | 'sticker' | 'link'

export interface LinkPayload {
  app: string // e.g. 'shop' | 'map' | 'todo'
  label: string
  data?: Record<string, unknown>
}

export interface Message {
  id: string
  conversationId: string
  role: MessageRole
  type: MessageType
  content: string // text content, sticker name, or link label
  link?: LinkPayload
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

export interface AppSettings {
  apiKey: string
  baseUrl: string
  model: string
  globalSystemPrompt: string
  userNickname: string
  userAvatar: string
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
export type AiBubble = AiBubbleText | AiBubbleSticker | AiBubbleLink

export interface AiResponse {
  messages: AiBubble[]
}
