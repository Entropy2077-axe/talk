import { create } from 'zustand'

export interface ChatNotification {
  id: string
  conversationId: string
  contactName: string
  contactAvatar: string
  contactAvatarColor: string
  preview: string
}

interface ChatUiState {
  /** The conversationId currently open in ChatPage, if any — used to suppress notifications for the chat you're already looking at. */
  activeConversationId: string | null
  setActiveConversation: (id: string | null) => void
  notification: ChatNotification | null
  showNotification: (n: ChatNotification) => void
  dismissNotification: () => void
}

/** Deliberately not persisted — this is ephemeral session/session-UI state, not a user setting. */
export const useChatUiStore = create<ChatUiState>((set) => ({
  activeConversationId: null,
  setActiveConversation: (id) => set({ activeConversationId: id }),
  notification: null,
  showNotification: (n) => set({ notification: n }),
  dismissNotification: () => set({ notification: null }),
}))
