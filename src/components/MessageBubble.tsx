import { forwardRef } from 'react'
import { Avatar } from './Avatar'
import { formatBubbleTime } from '../lib/time'
import type { Message } from '../types'

interface MessageBubbleProps {
  message: Message
  contactAvatar: string
  contactAvatarColor: string
  userAvatar: string
  stickerUrl?: string
  highlighted?: boolean
  onLinkClick?: (label: string) => void
}

export const MessageBubble = forwardRef<HTMLDivElement, MessageBubbleProps>(function MessageBubble(
  { message, contactAvatar, contactAvatarColor, userAvatar, stickerUrl, highlighted, onLinkClick },
  ref,
) {
  const isUser = message.role === 'user'
  return (
    <div
      ref={ref}
      className={`flex items-end gap-2 px-3 py-1.5 ${isUser ? 'flex-row-reverse' : ''} ${
        highlighted ? 'bg-yellow-50' : ''
      }`}
    >
      {isUser ? (
        <Avatar avatar={userAvatar} size={32} />
      ) : (
        <Avatar avatar={contactAvatar} color={contactAvatarColor} size={32} />
      )}

      <div className={`flex max-w-[68%] flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        {message.type === 'text' && (
          <div
            className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[14.5px] leading-relaxed ${
              isUser ? 'bg-[#95ec69] text-gray-900' : 'bg-white text-gray-900'
            }`}
          >
            {message.content}
          </div>
        )}

        {message.type === 'sticker' && (
          <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-xl bg-white">
            {stickerUrl ? (
              <img src={stickerUrl} alt={message.content} className="h-full w-full object-cover" />
            ) : (
              <span className="text-xs text-gray-400">[{message.content}]</span>
            )}
          </div>
        )}

        {message.type === 'link' && (
          <button
            onClick={() => onLinkClick?.(message.link?.label ?? message.content)}
            className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-left"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#aa3bff]/10 text-sm">
              🔗
            </span>
            <span className="text-[13.5px] text-gray-800">{message.link?.label ?? message.content}</span>
          </button>
        )}

        <span className="mt-0.5 px-1 text-[10px] text-gray-300">{formatBubbleTime(message.createdAt)}</span>
      </div>
    </div>
  )
})
