/** Five-dimension relationship model, scored 0-100 like a lightweight MBTI-style profile. */
export interface RelationshipDimensions {
  familiarity: number // 熟悉度 — how much history/context they share
  affection: number // 好感度 — warmth, fondness
  trust: number // 信任度 — willingness to be open/vulnerable
  romance: number // 暧昧度 — romantic/flirtatious charge
  friction: number // 摩擦感 — accumulated tension/annoyance
}

/** A recurring block in a contact's default weekly routine. */
export type ScheduleDayType = 'weekday' | 'weekend' | 'daily'

export interface ScheduleBlock {
  id: string
  dayType: ScheduleDayType
  startTime: string // "HH:mm"
  endTime: string // "HH:mm", may wrap past midnight (e.g. 23:00-07:00)
  locationId: string
  label?: string // what they're doing there, e.g. "上班"
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
  // ---- map / schedule ----
  dailySchedule: ScheduleBlock[] // recurring routine, authored once at creation time
  currentLocationId: string // last confirmed location; updated only when the AI actually announces a move
}

export interface Conversation {
  id: string
  contactId: string
  pinned: boolean
  updatedAt: number
  createdAt: number
}

export type MessageRole = 'user' | 'assistant'
export type MessageType = 'text' | 'sticker' | 'link' | 'location' | 'schedule_task'

export interface LinkPayload {
  app: string // e.g. 'shop' | 'map' | 'todo'
  label: string
  data?: Record<string, unknown>
}

export interface LocationPayload {
  locationId: string
}

export interface ScheduleTaskPayload {
  date: string
  startTime: string
  endTime: string
  locationId: string
}

export interface Message {
  id: string
  conversationId: string
  role: MessageRole
  type: MessageType
  content: string // text content, sticker name, link/location/task label
  link?: LinkPayload
  location?: LocationPayload
  scheduleTask?: ScheduleTaskPayload
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

export interface Location {
  id: string
  name: string
  icon: string // emoji
  isPreset: boolean
}

/** A one-off schedule override — takes priority over the daily routine for its date/time window. */
export interface ScheduleTask {
  id: string
  contactId: string
  date: string // "YYYY-MM-DD"
  startTime: string // "HH:mm"
  endTime: string // "HH:mm"
  locationId: string
  label: string
  createdAt: number
  source: 'user' | 'ai'
}

export interface AppSettings {
  apiKey: string
  baseUrl: string
  model: string
  globalSystemPrompt: string
  userNickname: string
  userAvatar: string
  userGender: string
  userBirthday: string // "YYYY-MM-DD", empty if unset
  userBio: string
  userLocationId: string
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
/** The AI announcing it has moved to (or is heading to) a location right now. */
export interface AiBubbleLocation {
  type: 'location'
  locationId: string
  label: string
}
/** The AI arranging a one-off event that overrides its normal routine for that date/time. */
export interface AiBubbleScheduleTask {
  type: 'schedule_task'
  date: string // "YYYY-MM-DD"
  startTime: string // "HH:mm"
  endTime: string // "HH:mm"
  locationId: string
  label: string
}
export type AiBubble =
  | AiBubbleText
  | AiBubbleSticker
  | AiBubbleLink
  | AiBubbleLocation
  | AiBubbleScheduleTask

export interface AiResponse {
  messages: AiBubble[]
}
