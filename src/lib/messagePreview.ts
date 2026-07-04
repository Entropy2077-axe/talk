import type { Message } from '../types'

/** Short one-line preview text for a message, used in the conversation list and notifications. */
export function previewForMessage(m?: Message): string {
  if (!m) return '暂无消息'
  if (m.type === 'sticker') return '[表情]'
  if (m.type === 'link') return `[链接] ${m.content}`
  if (m.type === 'commission') return `[委托] ${m.content}`
  if (m.type === 'gift') return `[礼物] ${m.content}`
  return m.content
}
