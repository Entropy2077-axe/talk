import { useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { useSettingsStore } from '../store/useSettingsStore'
import { displayName } from '../lib/contact'
import { generateMomentReply, parseCommentSticker, postUserMoment, refreshMoments } from '../lib/moments'
import { resizeImageDataUrl } from '../lib/image'
import { formatListTime } from '../lib/time'
import type { Contact, MomentComment, MomentLike } from '../types'

export function MomentsPage() {
  const settings = useSettingsStore()
  const moments = useLiveQuery(() => db.moments.orderBy('createdAt').reverse().toArray(), []) ?? []
  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? []
  const likes = useLiveQuery(() => db.momentLikes.toArray(), []) ?? []
  const comments = useLiveQuery(() => db.momentComments.toArray(), []) ?? []
  const stickers = useLiveQuery(() => db.stickers.toArray(), []) ?? []
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState('')
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerText, setComposerText] = useState('')
  const [posting, setPosting] = useState(false)
  const [commentingId, setCommentingId] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [replyTarget, setReplyTarget] = useState<{ commentId: string; authorLabel: string } | null>(null)
  const coverInput = useRef<HTMLInputElement>(null)

  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts])
  const stickerByName = useMemo(() => new Map(stickers.map((s) => [s.name, s])), [stickers])
  const stickerNames = useMemo(() => stickers.map((s) => s.name), [stickers])

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
    setCommentDraft('')
    setCommentingId(null)
    setReplyTarget(null)

    // The poster answers directly in the comment thread (background,
    // fire-and-forget) instead of the old pendingEvents-to-next-chat detour.
    const poster = posterContactId ? contactById.get(posterContactId) : undefined
    if (poster) {
      generateMomentReply(momentId, poster, newId, settings)
    }
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
      const events = contact.pendingEvents ?? []
      await db.contacts.update(posterContactId!, { pendingEvents: [...events, '你发的朋友圈刚被对方点赞了'] })
    }
  }

  return (
    <div className="relative flex min-h-full flex-col bg-[#ededed]">
      <TopBar
        title="朋友圈"
        showBack
        right={
          <div className="flex items-center">
            <button
              onClick={() => setComposerOpen((v) => !v)}
              aria-label="发一条朋友圈"
              className="flex h-9 w-9 items-center justify-center text-gray-500"
            >
              ✏️
            </button>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              aria-label="刷新朋友圈"
              className="flex h-9 w-9 items-center justify-center text-gray-500 disabled:opacity-40"
            >
              {refreshing ? '…' : '🔄'}
            </button>
          </div>
        }
      />

      <div className="relative shrink-0" style={{ height: '40vh' }} onClick={() => coverInput.current?.click()}>
        {settings.momentsCoverPhoto ? (
          <img src={settings.momentsCoverPhoto} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-[#aa3bff]/25 to-[#3b82f6]/25" />
        )}
        <div className="absolute bottom-3 right-3 flex items-center gap-2">
          <span className="text-[15px] font-medium text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.4)]">
            {settings.userNickname}
          </span>
          <Avatar avatar={settings.userAvatar} size={44} />
        </div>
        <input ref={coverInput} type="file" accept="image/*" onChange={handleCoverFile} className="hidden" />
      </div>

      {composerOpen && (
        <div className="border-b border-gray-100 bg-white px-4 py-3">
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
        {moments.length === 0 ? (
          <p className="bg-white py-10 text-center text-sm text-gray-400">还没有动态 点右上角刷新试试</p>
        ) : (
          moments.map((m) => {
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
              <div key={m.id} className="border-b border-gray-100 bg-white px-4 py-3">
                <div className="flex gap-3">
                  <Avatar avatar={posterAvatar} color={posterAvatarColor} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium text-[#576b95]">{posterName}</p>
                    <p className="mt-1 whitespace-pre-wrap text-[14.5px] leading-relaxed text-gray-900">
                      {m.content}
                    </p>
                    {m.imageUrl && (
                      <img
                        src={m.imageUrl}
                        alt=""
                        className="mt-2 max-h-64 w-full rounded-lg object-cover"
                        title={m.imagePhotographer ? `照片来自 Pexels · ${m.imagePhotographer}` : undefined}
                      />
                    )}
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[11px] text-gray-400">{formatListTime(m.createdAt)}</span>
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
                          className="text-base leading-none"
                        >
                          {userLiked ? '❤️' : '🤍'}
                        </button>
                      </div>
                    </div>

                    {commentingId === m.id && (
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          value={commentDraft}
                          onChange={(e) => setCommentDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') submitComment(m.id, poster?.id)
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
                          <p className="text-[#576b95]">
                            ❤ {momentLikes.map((l) => likerName(l.likerId)).join('、')}
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
                                <p key={c.id}>
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
    </div>
  )
}
