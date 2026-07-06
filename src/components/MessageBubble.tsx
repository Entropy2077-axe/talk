import { forwardRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { Avatar } from './Avatar'
import { formatBubbleTime } from '../lib/time'
import { formatCurrency } from '../lib/wallet'
import { useSettingsStore } from '../store/useSettingsStore'
import type { Message } from '../types'

interface MessageBubbleProps {
  message: Message
  contactName: string
  contactAvatar: string
  contactAvatarColor: string
  userAvatar: string
  stickerUrl?: string
  highlighted?: boolean
  adminMode?: boolean
  onLinkClick?: (label: string) => void
  onCommissionRespond?: (commissionId: string, accept: boolean) => void
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
    adminMode,
    onLinkClick,
    onCommissionRespond,
  },
  ref,
) {
  const isUser = message.role === 'user'
  const [expanded, setExpanded] = useState(false)
  const aiTurnDebug = useLiveQuery(() => (message.debugAiTurnId ? db.aiTurns.get(message.debugAiTurnId) : undefined), [
    message.debugAiTurnId,
  ])
  const debugPayload = aiTurnDebug ?? {
    message,
    parsedBubble: message.debugParsedBubble,
    rawAiResponse: message.debugRawAiResponse,
  }
  return (
    <div ref={ref} className={`px-3 py-1.5 ${highlighted ? 'bg-yellow-50' : ''}`}>
      {!isUser && <p className="mb-1 text-[11px] text-gray-400">{contactName}</p>}
      <div className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
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

          {message.type === 'commission' && message.commission && (
            <CommissionCard commissionId={message.commission.commissionId} onRespond={onCommissionRespond} />
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

          <span className="mt-0.5 px-1 text-[10px] text-gray-300">{formatBubbleTime(message.createdAt)}</span>
          {adminMode && !isUser && (
            <div className="mt-1 w-full">
              <button
                onClick={() => setExpanded((v) => !v)}
                className="rounded bg-gray-100 px-2 py-1 text-[10px] text-gray-500"
              >
                {expanded ? '收起 JSON' : '展开 JSON'}
              </button>
              {expanded && (
                <pre className="mt-1 max-h-64 w-[min(20rem,calc(100vw-6rem))] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-2 font-mono text-[10px] leading-relaxed text-gray-600">
                  {JSON.stringify(debugPayload, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

function CommissionCard({
  commissionId,
  onRespond,
}: {
  commissionId: string
  onRespond?: (commissionId: string, accept: boolean) => void
}) {
  const commission = useLiveQuery(() => db.commissions.get(commissionId), [commissionId])
  const currencySettings = useSettingsStore((s) => ({
    currencyIconMode: s.currencyIconMode,
    customCurrencyEmoji: s.customCurrencyEmoji,
  }))
  if (!commission) return null

  return (
    <div className="w-56 rounded-xl border border-gray-200 bg-white p-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-xs text-gray-400">📋 委托</span>
        <span className="ml-auto text-xs font-medium text-[#aa3bff]">{formatCurrency(commission.reward, currencySettings)}</span>
      </div>
      <p className="mb-1 text-[14px] font-medium text-gray-900">{commission.title}</p>
      <p className="mb-2 text-[12.5px] leading-relaxed text-gray-500">{commission.description}</p>
      {commission.status === 'pending' ? (
        <div className="flex gap-2">
          <button
            onClick={() => onRespond?.(commission.id, false)}
            className="flex-1 rounded-lg bg-gray-100 py-1.5 text-xs text-gray-600"
          >
            不接取
          </button>
          <button
            onClick={() => onRespond?.(commission.id, true)}
            className="flex-1 rounded-lg bg-gray-900 py-1.5 text-xs text-white"
          >
            接取
          </button>
        </div>
      ) : (
        <span className="text-xs text-gray-400">
          {commission.status === 'accepted' && '已接取 · 待完成'}
          {commission.status === 'declined' && '已拒绝'}
          {commission.status === 'completed' && '已完成'}
        </span>
      )}
    </div>
  )
}
