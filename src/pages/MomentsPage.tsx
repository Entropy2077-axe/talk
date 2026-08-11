import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { isAiTestId } from '../lib/aiTestIsolation'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { useSettingsStore } from '../store/useSettingsStore'
import { displayName } from '../lib/contact'
import { deleteMomentCompletely, generateMomentDiscussion, parseCommentSticker, postUserMoment, refreshMoments, regenerateMoment, regenerateMomentComment } from '../lib/moments'
import { recordSocialEvent } from '../lib/socialEvents'
import { resizeImageDataUrl } from '../lib/image'
import { formatListTime } from '../lib/time'
import type { Contact, MomentComment, MomentLike } from '../types'
import { Heart, Pencil, RefreshCw } from 'lucide-react'
import { retryMediaAsset } from '../lib/imageAssets'

const EMPTY_ARRAY: never[] = []

export function MomentsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const focusMomentId = searchParams.get('focus')
  const filterContactId = searchParams.get('contact')
  const settings = useSettingsStore()
  const moments = useLiveQuery(() => db.moments.orderBy('createdAt').reverse().toArray(), []) ?? EMPTY_ARRAY
  const contacts = (useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_ARRAY).filter((item) => !isAiTestId(item.id))
  const likes = useLiveQuery(() => db.momentLikes.toArray(), []) ?? EMPTY_ARRAY
  const comments = useLiveQuery(() => db.momentComments.toArray(), []) ?? EMPTY_ARRAY
  const stickers = useLiveQuery(() => db.stickers.toArray(), []) ?? EMPTY_ARRAY
  const mediaAssets = useLiveQuery(() => db.mediaAssets.where('origin').equals('moment').toArray(), []) ?? EMPTY_ARRAY
  const mediaAssetById = useMemo(() => new Map(mediaAssets.map((asset) => [asset.id, asset])), [mediaAssets])
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState('')
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerText, setComposerText] = useState('')
  const [posting, setPosting] = useState(false)
  const [commentingId, setCommentingId] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [regenerateTarget, setRegenerateTarget] = useState<{ kind: 'moment' | 'comment'; id: string; label: string } | null>(null)
  const [regenerateRequirement, setRegenerateRequirement] = useState('')
  const [regenerating, setRegenerating] = useState(false)
  const [replyTarget, setReplyTarget] = useState<{ commentId: string; authorLabel: string } | null>(null)
  const coverInput = useRef<HTMLInputElement>(null)
  const longPressTimer = useRef<number | null>(null)

  function openRegeneration(target: { kind: 'moment' | 'comment'; id: string; label: string }) {
    setRegenerateRequirement('')
    setRegenerateTarget(target)
  }

  function beginLongPress(target: { kind: 'moment' | 'comment'; id: string; label: string }) {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current)
    longPressTimer.current = window.setTimeout(() => openRegeneration(target), 550)
  }

  function cancelLongPress() {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current)
    longPressTimer.current = null
  }

  useEffect(() => {
    if (filterContactId) return
    settings.setSettings({ momentsLastReadAt: Date.now() })
    // only mark read when entering the page; new items arriving while here
    // are visible immediately through live queries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterContactId])

  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts])
  const stickerByName = useMemo(() => new Map(stickers.map((s) => [s.name, s])), [stickers])
  const stickerNames = useMemo(() => stickers.map((s) => s.name), [stickers])
  const filterContact = filterContactId ? contactById.get(filterContactId) : undefined
  const visibleMoments = filterContactId ? moments.filter((moment) => moment.contactId === filterContactId) : moments

  const likesByMoment = useMemo(() => {
    const map = new Map<string, MomentLike[]>()
    for (const l of likes) {
      const arr = map.get(l.momentId) ?? []
      arr.push(l)
      map.set(l.momentId, arr)
    }
    return map
  }, [likes])

  const commentsByMoment = useMemo(() => {
    const map = new Map<string, MomentComment[]>()
    for (const c of comments) {
      const arr = map.get(c.momentId) ?? []
      arr.push(c)
      map.set(c.momentId, arr)
    }
    // db.momentComments.toArray() orders by the random uuid primary key, not
    // insertion time — sort explicitly so the thread reads chronologically
    // (this matters a lot now that "A回复B" needs to visibly follow A's comment).
    for (const arr of map.values()) arr.sort((a, b) => a.createdAt - b.createdAt)
    return map
  }, [comments])

  const commentsById = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments])

  function nameFor(contact: Contact | undefined): string {
    return contact ? displayName(contact) : '一个朋友'
  }

  function likerName(likerId: string): string {
    return likerId === 'user' ? settings.userNickname : nameFor(contactById.get(likerId))
  }

  function commentAuthorName(authorContactId: string): string {
    return authorContactId === 'user' ? settings.userNickname : nameFor(contactById.get(authorContactId))
  }

  async function submitComment(momentId: string, posterContactId?: string) {
    const text = commentDraft.trim()
    if (!text) return
    const newId = uuid()
    await db.momentComments.add({
      id: newId,
      momentId,
      authorContactId: 'user',
      content: text,
      createdAt: Date.now(),
      replyToCommentId: replyTarget?.commentId,
    })
    if (posterContactId) {
      const poster = contactById.get(posterContactId)
      await recordSocialEvent({
        type: 'moment_commented',
        actorId: 'user',
        targetId: posterContactId,
        relatedContactIds: [posterContactId],
        momentId,
        summary: `用户评论了${poster ? displayName(poster) : '对方'}的朋友圈: ${text}`,
        importance: 2,
      })
    }
    setCommentDraft('')
    setCommentingId(null)
    setReplyTarget(null)

    // One bounded batch lets the directly addressed person and at most two
    // relevant friends reply. AI-authored replies never trigger another batch.
    void generateMomentDiscussion(momentId, posterContactId, newId, settings)
  }

  async function handleRefresh() {
    setRefreshing(true)
    setMessage('')
    try {
      const result = await refreshMoments(settings)
      setMessage(result.message ?? (result.postedCount > 0 ? `刷出了${result.postedCount}条新动态` : ''))
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  function handleCoverFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      const resized = await resizeImageDataUrl(reader.result as string, 960)
      settings.setSettings({ momentsCoverPhoto: resized })
    }
    reader.readAsDataURL(file)
  }

  async function handlePost() {
    const content = composerText.trim()
    if (!content || posting) return
    setPosting(true)
    try {
      await postUserMoment(content, settings)
      setComposerText('')
      setComposerOpen(false)
    } finally {
      setPosting(false)
    }
  }

  async function toggleUserLike(momentId: string, posterContactId?: string) {
    const existing = likesByMoment.get(momentId)?.find((l) => l.likerId === 'user')
    if (existing) {
      await db.momentLikes.delete(existing.id)
      return
    }
    await db.momentLikes.add({ id: uuid(), momentId, likerId: 'user', createdAt: Date.now() })
    const contact = posterContactId ? contactById.get(posterContactId) : undefined
    if (contact) {
      await recordSocialEvent({
        type: 'moment_liked',
        actorId: 'user',
        targetId: posterContactId,
        relatedContactIds: [posterContactId!],
        momentId,
        summary: `用户赞了${displayName(contact)}的朋友圈`,
        importance: 1,
      })
    }
  }

  async function handleDeleteMoment(momentId: string) {
    if (!window.confirm('确定撤销这条朋友圈吗？点赞、评论和相关动态也会一起删除。')) return
    await deleteMomentCompletely(momentId)
    setCommentingId((current) => current === momentId ? null : current)
  }

  async function submitRegeneration() {
    if (!regenerateTarget || regenerating) return
    const isMoment = regenerateTarget.kind === 'moment'
    const warning = isMoment
      ? '重新生成动态会清空这条动态下的点赞和评论（包括你的评论），以免旧互动和新内容不一致。确定继续吗？'
      : '重新生成跟评会清空这条跟评下的后续回复，以免上下文不一致。确定继续吗？'
    if (!window.confirm(warning)) return
    setRegenerating(true)
    try {
      if (isMoment) await regenerateMoment(regenerateTarget.id, regenerateRequirement, settings)
      else await regenerateMomentComment(regenerateTarget.id, regenerateRequirement, settings)
      setRegenerateTarget(null)
      setRegenerateRequirement('')
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '重新生成失败，请稍后再试')
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <div data-page-kind="moments" className="ui-page relative">
      <TopBar
        title={filterContact ? `${displayName(filterContact)}的朋友圈` : '朋友圈'}
        showBack
        right={
          !filterContactId ? <div className="flex items-center">
            <button
              onClick={() => setComposerOpen((v) => !v)}
              aria-label="发一条朋友圈"
              className="flex h-9 w-9 items-center justify-center text-gray-500"
            >
              <Pencil size={18} />
            </button>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              aria-label="刷新朋友圈"
              className="flex h-9 w-9 items-center justify-center text-gray-500 disabled:opacity-40"
            >
              <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div> : undefined
        }
      />
      <div className="moments-scroll flex-1 overflow-y-auto">

      {filterContact ? <div className="flex items-center gap-3 bg-white px-4 py-5"><Avatar avatar={filterContact.avatar} color={filterContact.avatarColor} size={56} /><div><p className="ui-font-display text-base font-medium text-gray-900">{displayName(filterContact)}</p><p className="mt-1 text-xs text-gray-400">共 {visibleMoments.length} 条动态</p></div></div> : <div className="moments-cover relative shrink-0" style={{ height: '40vh' }} onClick={() => coverInput.current?.click()}>
        {settings.momentsCoverPhoto ? (
          <img src={settings.momentsCoverPhoto} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="ui-cover-gradient h-full w-full" />
        )}
        <div className="absolute bottom-3 right-3 flex items-center gap-2">
          <span className="text-[15px] font-medium text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.4)]">
            {settings.userNickname}
          </span>
          <button
            type="button"
            aria-label="编辑个人信息"
            onClick={(event) => {
              event.stopPropagation()
              void navigate('/profile/edit')
            }}
          >
            <Avatar avatar={settings.userAvatar} size={44} />
          </button>
        </div>
        <input ref={coverInput} type="file" accept="image/*" onChange={handleCoverFile} className="hidden" />
      </div>}

      {composerOpen && (
        <div className="border-b border-[var(--ui-border-soft)] bg-[var(--ui-surface)] px-4 py-3">
          <div className="mb-3"><p className="ui-section-title">分享此刻</p><p className="ui-section-summary">发布后会进入你和联系人共同可见的动态流。</p></div>
          <textarea
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            placeholder="分享一下此刻的想法…"
            rows={3}
            className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={() => {
                setComposerOpen(false)
                setComposerText('')
              }}
              className="rounded-lg px-3 py-1.5 text-sm text-gray-400"
            >
              取消
            </button>
            <button
              onClick={handlePost}
              disabled={!composerText.trim() || posting}
              className="rounded-lg bg-gray-900 px-4 py-1.5 text-sm text-white disabled:opacity-40"
            >
              {posting ? '发布中…' : '发布'}
            </button>
          </div>
        </div>
      )}

      {message && <p className="bg-white px-4 py-2 text-center text-xs text-gray-400">{message}</p>}

      <div className="flex-1">
        {visibleMoments.length === 0 ? (
          <div className="ui-empty-state">{filterContact ? 'TA 还没有发布过朋友圈。' : '还没有动态，可以发布一条或点击右上角刷新。'}</div>
        ) : (
          visibleMoments.map((m) => {
            const isUserPost = m.contactId === 'user'
            const poster = isUserPost ? undefined : contactById.get(m.contactId)
            if (!isUserPost && !poster) return null
            const posterName = isUserPost ? settings.userNickname : displayName(poster!)
            const posterAvatar = isUserPost ? settings.userAvatar : poster!.avatar
            const posterAvatarColor = isUserPost ? undefined : poster!.avatarColor
            const momentLikes = likesByMoment.get(m.id) ?? []
            const momentComments = commentsByMoment.get(m.id) ?? []
            const userLiked = momentLikes.some((l) => l.likerId === 'user')
            return (
              <div key={m.id} className={`border-b border-gray-100 bg-white px-4 py-3 ${m.id === focusMomentId ? 'ring-2 ring-inset ring-[var(--ui-success)]' : ''}`}>
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    aria-label={isUserPost ? '编辑个人信息' : `查看${posterName}资料`}
                    onClick={() => navigate(isUserPost ? '/profile/edit' : `/contact/${poster!.id}`)}
                    className="shrink-0 self-start"
                  >
                    <Avatar avatar={posterAvatar} color={posterAvatarColor} size={40} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="ui-font-display text-[14px] font-medium text-[#576b95]">{posterName}</p>
                    <p
                      onContextMenu={(event) => {
                        if (isUserPost) return
                        event.preventDefault()
                        openRegeneration({ kind: 'moment', id: m.id, label: `${posterName}的动态` })
                      }}
                      onTouchStart={() => !isUserPost && beginLongPress({ kind: 'moment', id: m.id, label: `${posterName}的动态` })}
                      onTouchEnd={cancelLongPress}
                      onTouchMove={cancelLongPress}
                      className="ui-font-reading mt-1 whitespace-pre-wrap text-[14.5px] leading-relaxed text-gray-900"
                    >
                      {m.content}
                    </p>
                    {m.imageAssetId && mediaAssetById.get(m.imageAssetId)?.status !== 'completed' && mediaAssetById.get(m.imageAssetId)?.status !== 'failed' && <div className="mt-2 flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-lg bg-gray-100 text-xs text-gray-400"><span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-[var(--ui-special)]"/>图片生成中…</div>}
                    {m.imageAssetId && mediaAssetById.get(m.imageAssetId)?.status === 'failed' && <div className="mt-2 flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg bg-gray-50 px-4 text-center"><p className="text-xs text-red-500">{mediaAssetById.get(m.imageAssetId)?.error || '图片生成失败'}</p><button type="button" onClick={() => void retryMediaAsset(m.imageAssetId!)} className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs text-white">重新生成</button></div>}
                    {(m.imageUrl || (m.imageAssetId && mediaAssetById.get(m.imageAssetId)?.status === 'completed' && (mediaAssetById.get(m.imageAssetId)?.dataUrl || mediaAssetById.get(m.imageAssetId)?.remoteUrl))) && (
                      <img
                        src={m.imageAssetId ? mediaAssetById.get(m.imageAssetId)?.dataUrl || mediaAssetById.get(m.imageAssetId)?.remoteUrl || m.imageUrl : m.imageUrl}
                        alt=""
                        className="mt-2 max-h-64 w-full rounded-lg object-cover"
                        title={m.imagePhotographer ? `照片来自 Pexels · ${m.imagePhotographer}` : undefined}
                      />
                    )}
                    <div className="mt-2 flex items-center justify-between">
                      <div className="flex items-center gap-2"><span className="text-[11px] text-gray-400">{formatListTime(m.createdAt)}</span><button type="button" onClick={() => void handleDeleteMoment(m.id)} className="text-[11px] text-red-500">撤销</button></div>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => {
                            setCommentDraft('')
                            setReplyTarget(null)
                            setCommentingId(commentingId === m.id ? null : m.id)
                          }}
                          aria-label="评论"
                          className="text-[13px] text-gray-400"
                        >
                          评论
                        </button>
                        <button
                          onClick={() => toggleUserLike(m.id, poster?.id)}
                          aria-label="点赞"
                          className={userLiked ? 'text-[var(--ui-danger)]' : 'text-gray-400'}
                        >
                          <Heart size={17} fill={userLiked ? 'currentColor' : 'none'} />
                        </button>
                      </div>
                    </div>

                    {commentingId === m.id && (
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          value={commentDraft}
                          onChange={(e) => setCommentDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void submitComment(m.id, poster?.id)
                          }}
                          placeholder={replyTarget ? `回复${replyTarget.authorLabel}：` : '说点什么…'}
                          autoFocus
                          className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm"
                        />
                        <button
                          onClick={() => submitComment(m.id, poster?.id)}
                          disabled={!commentDraft.trim()}
                          className="shrink-0 rounded-lg bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
                        >
                          发送
                        </button>
                      </div>
                    )}

                    {(momentLikes.length > 0 || momentComments.length > 0) && (
                      <div className="mt-2 rounded-lg bg-gray-50 px-2.5 py-2 text-[13px] leading-relaxed">
                        {momentLikes.length > 0 && (
                          <p className="flex items-center gap-1.5 text-[#576b95]">
                            <Heart size={13} fill="currentColor" />{momentLikes.map((l) => likerName(l.likerId)).join('、')}
                          </p>
                        )}
                        {momentComments.length > 0 && (
                          <div className={momentLikes.length > 0 ? 'mt-1 border-t border-gray-200 pt-1' : ''}>
                            {momentComments.map((c) => {
                              const { text, stickerName } = parseCommentSticker(c.content, stickerNames)
                              const sticker = stickerName ? stickerByName.get(stickerName) : undefined
                              const replyTo = c.replyToCommentId ? commentsById.get(c.replyToCommentId) : undefined
                              const authorLabel = commentAuthorName(c.authorContactId)
                              return (
                                <p
                                  key={c.id}
                                  onContextMenu={(event) => {
                                    if (c.authorContactId === 'user') return
                                    event.preventDefault()
                                    openRegeneration({ kind: 'comment', id: c.id, label: `${authorLabel}的跟评` })
                                  }}
                                  onTouchStart={() => c.authorContactId !== 'user' && beginLongPress({ kind: 'comment', id: c.id, label: `${authorLabel}的跟评` })}
                                  onTouchEnd={cancelLongPress}
                                  onTouchMove={cancelLongPress}
                                >
                                  <span className="text-[#576b95]">{authorLabel}</span>
                                  {replyTo && (
                                    <>
                                      {' 回复 '}
                                      <span className="text-[#576b95]">{commentAuthorName(replyTo.authorContactId)}</span>
                                    </>
                                  )}
                                  {'：'}
                                  {text}
                                  {sticker && (
                                    <img
                                      src={sticker.dataUrl}
                                      alt={stickerName}
                                      className="ml-1 inline-block h-6 w-6 rounded object-cover align-text-bottom"
                                    />
                                  )}
                                  <button
                                    onClick={() => {
                                      setCommentDraft('')
                                      setReplyTarget({ commentId: c.id, authorLabel })
                                      setCommentingId(m.id)
                                    }}
                                    className="ml-1.5 text-[11px] text-gray-400"
                                  >
                                    回复
                                  </button>
                                </p>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
      {regenerateTarget && (
        <div className="absolute inset-0 z-30 flex items-end bg-black/30 p-3" onClick={() => !regenerating && setRegenerateTarget(null)}>
          <div className="w-full rounded-2xl bg-white p-4 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <h2 className="text-base font-medium text-gray-900">重新生成{regenerateTarget.label}</h2>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">可以告诉 AI 希望内容怎样展开；会优先遵守你的要求并保持人物人设。</p>
            <textarea value={regenerateRequirement} onChange={(event) => setRegenerateRequirement(event.target.value)} placeholder="例如：不要写工作，更像 TA 平时的兴趣；语气自然一点，不要 OOC" className="mt-3 h-24 w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400" />
            <div className="mt-3 flex justify-end gap-2"><button type="button" disabled={regenerating} onClick={() => setRegenerateTarget(null)} className="rounded-lg px-3 py-2 text-sm text-gray-500">取消</button><button type="button" disabled={regenerating} onClick={() => void submitRegeneration()} className="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-50">{regenerating ? '生成中…' : '重新生成'}</button></div>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
