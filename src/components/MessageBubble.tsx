import { memo, useMemo } from 'react'
import type React from 'react'
import { Avatar } from './Avatar'
import { useLongPress } from '../hooks/useLongPress'
import { displayName } from '../lib/contact'
import type { Contact, Message } from '../types'
import { Check } from 'lucide-react'
import { UiIcon } from './UiIcon'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { retryMediaAsset } from '../lib/imageAssets'

interface MessageBubbleProps {
  message: Message
  contactName: string
  contactAvatar: string
  contactAvatarColor: string
  userAvatar: string
  stickerUrl?: string
  highlighted?: boolean
  /** Stable map used to resolve @mention ids → names inside the bubble (keeps props referentially stable for memo). */
  memberById?: Map<string, Contact>
  replyPreview?: string
  selecting?: boolean
  selected?: boolean
  /** All callbacks receive the message id/object so the parent can pass a single stable handler (no per-item closures). */
  onReply?: (id: string) => void
  onLongPress?: (id: string) => void
  onSelect?: (id: string) => void
  onLinkClick?: (message: Message) => void
  onFinanceClick?: (message: Message) => void
  onInternalTaskUndo?: (message: Message) => void
  speechAvailable?: boolean
  speechLoading?: boolean
  speechPlaying?: boolean
  speechDurationMs?: number
  onSpeechClick?: (message: Message) => void
  onAvatarClick?: (message: Message) => void
  /** Stable ref registrar: called with (id, el) so the parent can track bubble DOM nodes without a per-item ref closure. */
  registerRef?: (id: string, el: HTMLDivElement | null) => void
  showName?: boolean
}

export const MessageBubble = memo(function MessageBubble({
  message,
  contactName,
  contactAvatar,
  contactAvatarColor,
  userAvatar,
  stickerUrl,
  highlighted,
  memberById,
  replyPreview,
  selecting,
  selected,
  onReply,
  onLongPress,
  onSelect,
  onLinkClick,
  onFinanceClick,
  onInternalTaskUndo,
  speechAvailable,
  speechLoading,
  speechPlaying,
  speechDurationMs,
  onSpeechClick,
  onAvatarClick,
  registerRef,
  showName = false,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const imageAsset = useLiveQuery(
    () => message.image?.assetId ? db.mediaAssets.get(message.image.assetId) : undefined,
    [message.image?.assetId],
    null,
  )
  const longPress = useLongPress(() => onLongPress?.(message.id))
  const mentionNames = useMemo(
    () =>
      (message.mentions ?? [])
        .map((id) => memberById?.get(id))
        .filter((c): c is Contact => !!c)
        .map(displayName),
    [message.mentions, memberById],
  )
  return (
    <div
      ref={(el) => registerRef?.(message.id, el)}
      data-message-id={message.id}
      {...(selecting ? {} : longPress)}
      onClick={selecting ? () => onSelect?.(message.id) : undefined}
      className={`relative select-none [-webkit-touch-callout:none] px-3 py-1.5 ${selecting ? 'cursor-pointer pl-12' : ''} ${
        selected ? 'bg-gray-200' : highlighted ? 'bg-yellow-50' : ''
      }`}
    >
      {selecting && (
        <span
          className={`absolute left-4 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border text-[12px] ${
            selected ? 'border-[var(--ui-info)] bg-[var(--ui-info)] text-white' : 'border-gray-300 bg-white text-transparent'
          }`}
          aria-hidden="true"
        >
          <Check size={13} />
        </span>
      )}
      {!isUser && showName && <p className="ui-font-display mb-1 pl-10 text-[11px] text-gray-400">{contactName}</p>}
      <div className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
        <button type="button" onClick={() => onAvatarClick?.(message)} aria-label={isUser ? '编辑个人信息' : `查看${contactName}资料`}>
          {isUser ? (
            <Avatar avatar={userAvatar} size={32} />
          ) : (
            <Avatar avatar={contactAvatar} color={contactAvatarColor} size={32} />
          )}
        </button>

        <div className={`flex max-w-[68%] flex-col ${isUser ? 'items-end' : 'items-start'}`}>
          {replyPreview && (
            <div className="mb-1 max-w-full truncate rounded-lg bg-black/5 px-2 py-1 text-[11px] text-gray-500">
              {replyPreview}
            </div>
          )}
          {message.type === 'text' && (
            <>
              <div
                className={`ui-font-reading whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[14.5px] leading-relaxed ${
                  isUser ? 'bg-[#95ec69] text-gray-900' : 'bg-white text-gray-900'
                }`}
              >
                <TextWithMentions text={message.content} names={mentionNames} />
              </div>
              {(speechAvailable || speechLoading) && (
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); if (!speechLoading) onSpeechClick?.(message) }}
                  className={`mt-1 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ${isUser ? 'bg-[#7bd957] text-gray-800' : 'bg-white text-gray-500'}`}
                  aria-label={speechLoading ? '语音生成中' : speechPlaying ? '暂停语音' : '播放语音'}
                >
                  <span aria-hidden="true">{speechLoading ? '◌' : speechPlaying ? 'Ⅱ' : '▶'}</span>
                  <span>{speechLoading ? '正在生成语音…' : speechDurationMs ? `语音 · ${Math.max(1, Math.round(speechDurationMs / 1000))} 秒` : '播放语音'}</span>
                </button>
              )}
            </>
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
              onClick={() => onLinkClick?.(message)}
              className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-left"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ui-special-soft)] text-[var(--ui-special-ink)]">
                <UiIcon name="link" size={16} />
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
                <span className="flex items-center gap-1 text-xs text-gray-400"><UiIcon name="calendar" size={13} />日程变更</span>
                <span className="ml-auto text-xs text-gray-400">{message.scheduleChange.date}</span>
              </div>
              <p className="mb-1 text-[14px] font-medium text-gray-900">{message.scheduleChange.summary}</p>
              <p className="text-[12.5px] leading-relaxed text-gray-500">
                {message.scheduleChange.startHour}:00-{message.scheduleChange.endHour}:00 · {message.scheduleChange.location}
              </p>
            </div>
          )}
          {message.type === 'internalTask' && message.internalTask && (
            <div className="w-56 rounded-xl border border-[var(--ui-special-border)] bg-[var(--ui-special-soft)] p-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs text-[var(--ui-special-ink)]"><UiIcon name="calendar" size={13} />安排已生效</div>
              <p className="text-[14px] font-medium text-gray-900">{message.internalTask.presentation.activity}</p>
              {message.internalTask.presentation.changedSections.includes('schedule') && <p className="mt-1 text-[12px] text-gray-600">日程：{message.internalTask.presentation.date} · {message.internalTask.presentation.startTime}–{message.internalTask.presentation.endTime}</p>}
              {message.internalTask.presentation.changedSections.includes('location') && <p className="mt-1 text-[12px] text-gray-600">地点已变更至：{message.internalTask.presentation.locationName}</p>}
              {!message.internalTask.presentation.changedSections.includes('location') && <p className="mt-1 text-[12px] text-gray-600">地点：{message.internalTask.presentation.locationName}</p>}
              {message.internalTask.presentation.cancelledDefaultActivities.length > 0 && <p className="mt-1 text-[11px] text-gray-500">已覆盖：{message.internalTask.presentation.cancelledDefaultActivities.join('、')}</p>}
              {message.internalTask.status === 'active' ? <button type="button" onClick={() => onInternalTaskUndo?.(message)} className="mt-3 w-full rounded-lg border border-[var(--ui-special-border)] bg-white py-1.5 text-xs text-[var(--ui-special-ink)]">撤销这次安排</button> : <p className="mt-3 text-center text-xs text-gray-400">已撤销，原日程已恢复</p>}
            </div>
          )}
          {message.type === 'groupPlan' && (
            <div className="w-56 rounded-xl border border-[var(--ui-success)] bg-[#f0fff5] p-3">
              <p className="flex items-center gap-1 text-xs text-[#07a651]"><UiIcon name="calendar" size={13} />共同计划 · 待确认</p>
              <p className="mt-1 text-[14px] font-medium text-gray-900">{message.content}</p>
              <p className="mt-1 text-[11px] text-gray-500">可在群聊信息中确认、取消或标记成行</p>
            </div>
          )}
          {message.type === 'image' && message.image && <div data-ui-scope="special" className="w-[240px] overflow-hidden rounded-xl bg-white">
            {message.image.assetId && (imageAsset === null || (imageAsset && imageAsset.status !== 'completed' && imageAsset.status !== 'failed')) ? <div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 bg-gray-100 text-xs text-gray-400"><span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-[var(--ui-special)]"/><span>图片生成中…</span></div> : null}
            {imageAsset?.status === 'failed' ? <div className="flex min-h-36 flex-col items-center justify-center gap-2 bg-gray-50 px-4 text-center"><UiIcon name="image" size={24}/><p className="text-xs text-red-500">{imageAsset.error || '图片生成失败'}</p><button type="button" onClick={() => void retryMediaAsset(imageAsset.id)} className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs text-white">重新生成</button></div> : null}
            {(imageAsset?.status === 'completed' ? imageAsset.dataUrl || imageAsset.remoteUrl : message.image.url) && <img src={imageAsset?.status === 'completed' ? imageAsset.dataUrl || imageAsset.remoteUrl : message.image.url} alt="聊天图片" className="max-h-72 w-full object-cover"/>}
            {message.image.photographer&&<p className="px-3 pb-2 pt-1 text-[10px] text-gray-300">Photo: {message.image.photographer}</p>}
          </div>}
          {['transfer','redPacket','loanRequest','loanResult','repayment'].includes(message.type) && message.finance && (
            <button data-ui-scope="special" onClick={()=>onFinanceClick?.(message)} className="finance-card w-56 rounded-xl border border-orange-200 p-3 text-left text-white">
              <p className="flex items-center gap-1.5 text-sm font-medium"><UiIcon name={message.type==='transfer'?'finance':message.type==='redPacket'?'gift':message.type==='loanRequest'?'loan':message.type==='repayment'?'check':'archive'} size={16} />{message.type==='transfer'?'转账':message.type==='redPacket'?'红包':message.type==='loanRequest'?'借款申请':message.type==='repayment'?'已还款':'借款结果'}</p>
              <p className="mt-2 text-xl font-bold">{message.type==='redPacket'&&message.finance.status==='pending'?'点击领取':message.finance.amount}</p>
              <p className="mt-1 text-xs text-white/80">{message.finance.note || message.finance.status}</p>
            </button>
          )}

          <div className={`mt-0.5 flex items-center gap-2 px-1 ${isUser ? 'flex-row-reverse' : ''}`}>
            {onReply && (
              <button onClick={() => onReply(message.id)} className="text-[10px] text-gray-400">
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
