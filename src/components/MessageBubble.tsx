import { forwardRef } from 'react'
import type React from 'react'
import { Avatar } from './Avatar'
import { formatBubbleTime } from '../lib/time'
import { useLongPress } from '../hooks/useLongPress'
import type { Message } from '../types'

interface MessageBubbleProps {
  message: Message
  contactName: string
  contactAvatar: string
  contactAvatarColor: string
  userAvatar: string
  stickerUrl?: string
  highlighted?: boolean
  mentionNames?: string[]
  replyPreview?: string
  onReply?: () => void
  onLongPress?: () => void
  onLinkClick?: (label: string) => void
}

export const MessageBubble = forwardRef<HTMLDivElement, MessageBubbleProps>(function MessageBubble(
  {
    message,
    contactName,
    contactAvatar,
    contactAvatarColor,
    userAvatar,
    stickerUrl,
    highlighted,
    mentionNames = [],
    replyPreview,
    onReply,
    onLongPress,
    onLinkClick,
  },
  ref,
) {
  const isUser = message.role === 'user'
  const longPress = useLongPress(() => onLongPress?.())
  return (
    <div ref={ref} {...longPress} className={`px-3 py-1.5 ${highlighted ? 'bg-yellow-50' : ''}`}>
      {!isUser && <p className="mb-1 text-[11px] text-gray-400">{contactName}</p>}
      <div className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
        {isUser ? (
          <Avatar avatar={userAvatar} size={32} />
        ) : (
          <Avatar avatar={contactAvatar} color={contactAvatarColor} size={32} />
        )}

        <div className={`flex max-w-[68%] flex-col ${isUser ? 'items-end' : 'items-start'}`}>
          {replyPreview && (
            <div className="mb-1 max-w-full truncate rounded-lg bg-black/5 px-2 py-1 text-[11px] text-gray-500">
              {replyPreview}
            </div>
          )}
          {message.type === 'text' && (
            <div
              className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[14.5px] leading-relaxed ${
                isUser ? 'bg-[#95ec69] text-gray-900' : 'bg-white text-gray-900'
              }`}
            >
              <TextWithMentions text={message.content} names={mentionNames} />
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

          {message.type === 'gift' && message.gift && (
            <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5">
              <span className="text-2xl">{message.gift.icon}</span>
              <div>
                <p className="text-[13.5px] text-gray-800">送出了「{message.gift.name}」</p>
                {message.gift.description && <p className="text-[11px] text-gray-400">{message.gift.description}</p>}
              </div>
            </div>
          )}

          {message.type === 'scheduleChange' && message.scheduleChange && (
            <div className="w-56 rounded-xl border border-gray-200 bg-white p-3">
              <div className="mb-1.5 flex items-center gap-1.5">
                <span className="text-xs text-gray-400">📅 日程变更</span>
                <span className="ml-auto text-xs text-gray-400">{message.scheduleChange.date}</span>
              </div>
              <p className="mb-1 text-[14px] font-medium text-gray-900">{message.scheduleChange.summary}</p>
              <p className="text-[12.5px] leading-relaxed text-gray-500">
                {message.scheduleChange.startHour}:00-{message.scheduleChange.endHour}:00 · {message.scheduleChange.location}
              </p>
            </div>
          )}

          <div className={`mt-0.5 flex items-center gap-2 px-1 ${isUser ? 'flex-row-reverse' : ''}`}>
            <span className="text-[10px] text-gray-300">{formatBubbleTime(message.createdAt)}</span>
            {onReply && (
              <button onClick={onReply} className="text-[10px] text-gray-400">
                回复
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

function TextWithMentions({ text, names }: { text: string; names: string[] }) {
  if (names.length === 0) return <>{text}</>

  const escaped = names
    .filter(Boolean)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (escaped.length === 0) return <>{text}</>

  const pattern = new RegExp(`@(${escaped.join('|')})`, 'g')
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index))
    parts.push(
      <span key={`${match[0]}-${match.index}`} className="font-medium text-[#576b95]">
        {match[0]}
      </span>,
    )
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return <>{parts}</>
}
