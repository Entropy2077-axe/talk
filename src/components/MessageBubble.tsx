import { forwardRef } from 'react'
import type React from 'react'
import { Avatar } from './Avatar'
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
  selecting?: boolean
  selected?: boolean
  onReply?: () => void
  onLongPress?: () => void
  onSelect?: () => void
  onLinkClick?: (label: string) => void
  onFinanceClick?: (message: Message) => void
  showName?: boolean
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
    selecting,
    selected,
    onReply,
    onLongPress,
    onSelect,
    onLinkClick, onFinanceClick,
    showName = false,
  },
  ref,
) {
  const isUser = message.role === 'user'
  const longPress = useLongPress(() => onLongPress?.())
  return (
    <div
      ref={ref}
      {...(selecting ? {} : longPress)}
      onClick={selecting ? onSelect : undefined}
      className={`relative px-3 py-1.5 ${selecting ? 'cursor-pointer pl-12' : ''} ${
        selected ? 'bg-gray-200' : highlighted ? 'bg-yellow-50' : ''
      }`}
    >
      {selecting && (
        <span
          className={`absolute left-4 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border text-[12px] ${
            selected ? 'border-[#1296db] bg-[#1296db] text-white' : 'border-gray-300 bg-white text-transparent'
          }`}
          aria-hidden="true"
        >
          ✓
        </span>
      )}
      {!isUser && showName && <p className="mb-1 pl-10 text-[11px] text-gray-400">{contactName}</p>}
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
          {message.type === 'groupPlan' && (
            <div className="w-56 rounded-xl border border-[#07c160]/30 bg-[#f0fff5] p-3">
              <p className="text-xs text-[#07a651]">📅 共同计划 · 待确认</p>
              <p className="mt-1 text-[14px] font-medium text-gray-900">{message.content}</p>
              <p className="mt-1 text-[11px] text-gray-500">可在群聊信息中确认、取消或标记成行</p>
            </div>
          )}
          {message.type === 'image' && message.image && <div className="max-w-[240px] overflow-hidden rounded-xl bg-white"><img src={message.image.url} alt={message.image.caption||'聊天图片'} className="max-h-72 w-full object-cover"/>{message.image.caption&&<p className="px-3 py-2 text-xs text-gray-600">{message.image.caption}</p>}{message.image.photographer&&<p className="px-3 pb-2 text-[10px] text-gray-300">Photo: {message.image.photographer}</p>}</div>}
          {['transfer','redPacket','loanRequest','loanResult','repayment'].includes(message.type) && message.finance && (
            <button onClick={()=>onFinanceClick?.(message)} className="w-56 rounded-xl border border-orange-200 bg-gradient-to-br from-orange-400 to-red-500 p-3 text-left text-white">
              <p className="text-sm font-medium">{message.type==='transfer'?'💸 转账':message.type==='redPacket'?'🧧 红包':message.type==='loanRequest'?'🤝 借款申请':message.type==='repayment'?'✅ 已还款':'📋 借款结果'}</p>
              <p className="mt-2 text-xl font-bold">{message.type==='redPacket'&&message.finance.status==='pending'?'点击领取':message.finance.amount}</p>
              <p className="mt-1 text-xs text-white/80">{message.finance.note || message.finance.status}</p>
            </button>
          )}

          <div className={`mt-0.5 flex items-center gap-2 px-1 ${isUser ? 'flex-row-reverse' : ''}`}>
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
