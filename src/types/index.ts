export interface Contact {
  id: string
  name: string
  avatar: string // emoji or data URL
  avatarColor: string // fallback background color
  systemPrompt: string
  bio?: string
  createdAt: number
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
