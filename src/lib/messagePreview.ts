import type { Message } from '../types'

/**
 * Short one-line preview text for a message, used in the conversation list
 * and notifications. `speakerName` is only meaningful for group chats (a
 * given assistant bubble could be any member) — omit it for 1:1 chats.
 */
export function previewForMessage(m?: Message, speakerName?: string): string {
  if (!m) return '暂无消息'
  const body = (() => {
    if (m.type === 'sticker') return '[表情]'
    if (m.type === 'link') return `[链接] ${m.content}`
    if (m.type === 'gift') return `[礼物] ${m.content}`
    if (m.type === 'scheduleChange') return `[日程] ${m.content}`
    return m.content
  })()
  return speakerName ? `${speakerName}: ${body}` : body
}
