import type { Message } from '../types'

/** Only incoming (assistant) messages count as unread — the user's own sent messages never do, regardless of lastReadAt. */
export function unreadCountFor(lastReadAt: number | undefined, messages: Message[]): number {
  const since = lastReadAt ?? 0
  return messages.filter((m) => m.role === 'assistant' && m.createdAt > since).length
}
