import { useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { useSettingsStore } from '../store/useSettingsStore'
import { displayName } from '../lib/contact'
import { refreshMoments } from '../lib/moments'
import { resizeImageDataUrl } from '../lib/image'
import { formatListTime } from '../lib/time'
import type { Contact, MomentComment, MomentLike } from '../types'

export function MomentsPage() {
  const settings = useSettingsStore()
  const moments = useLiveQuery(() => db.moments.orderBy('createdAt').reverse().toArray(), []) ?? []
  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? []
  const likes = useLiveQuery(() => db.momentLikes.toArray(), []) ?? []
  const comments = useLiveQuery(() => db.momentComments.toArray(), []) ?? []
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState('')
  const coverInput = useRef<HTMLInputElement>(null)

  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts])

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
    return map
  }, [comments])

  function nameFor(contact: Contact | undefined): string {
    return contact ? displayName(contact) : '一个朋友'
  }

  function likerName(likerId: string): string {
    return likerId === 'user' ? settings.userNickname : nameFor(contactById.get(likerId))
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

  async function toggleUserLike(momentId: string, posterContactId: string) {
    const existing = likesByMoment.get(momentId)?.find((l) => l.likerId === 'user')
    if (existing) {
      await db.momentLikes.delete(existing.id)
      return
    }
    await db.momentLikes.add({ id: uuid(), momentId, likerId: 'user', createdAt: Date.now() })
    const contact = contactById.get(posterContactId)
    if (contact) {
      const events = contact.pendingEvents ?? []
      await db.contacts.update(posterContactId, { pendingEvents: [...events, '你发的朋友圈刚被对方点赞了'] })
    }
  }

  return (
    <div className="relative flex min-h-full flex-col bg-[#ededed]">
      <TopBar
        title="朋友圈"
        showBack
        right={
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            aria-label="刷新朋友圈"
            className="flex h-9 w-9 items-center justify-center text-gray-500 disabled:opacity-40"
          >
            {refreshing ? '…' : '🔄'}
          </button>
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

      {message && <p className="bg-white px-4 py-2 text-center text-xs text-gray-400">{message}</p>}

      <div className="flex-1">
        {moments.length === 0 ? (
          <p className="bg-white py-10 text-center text-sm text-gray-400">还没有动态 点右上角刷新试试</p>
        ) : (
          moments.map((m) => {
            const poster = contactById.get(m.contactId)
            if (!poster) return null
            const momentLikes = likesByMoment.get(m.id) ?? []
            const momentComments = commentsByMoment.get(m.id) ?? []
            const userLiked = momentLikes.some((l) => l.likerId === 'user')
            return (
              <div key={m.id} className="border-b border-gray-100 bg-white px-4 py-3">
                <div className="flex gap-3">
                  <Avatar avatar={poster.avatar} color={poster.avatarColor} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium text-[#576b95]">{displayName(poster)}</p>
                    <p className="mt-1 whitespace-pre-wrap text-[14.5px] leading-relaxed text-gray-900">
                      {m.content}
                    </p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[11px] text-gray-400">{formatListTime(m.createdAt)}</span>
                      <button
                        onClick={() => toggleUserLike(m.id, poster.id)}
                        aria-label="点赞"
                        className="text-base leading-none"
                      >
                        {userLiked ? '❤️' : '🤍'}
                      </button>
                    </div>

                    {(momentLikes.length > 0 || momentComments.length > 0) && (
                      <div className="mt-2 rounded-lg bg-gray-50 px-2.5 py-2 text-[13px] leading-relaxed">
                        {momentLikes.length > 0 && (
                          <p className="text-[#576b95]">
                            ❤ {momentLikes.map((l) => likerName(l.likerId)).join('、')}
                          </p>
                        )}
                        {momentComments.length > 0 && (
                          <div className={momentLikes.length > 0 ? 'mt-1 border-t border-gray-200 pt-1' : ''}>
                            {momentComments.map((c) => (
                              <p key={c.id}>
                                <span className="text-[#576b95]">{nameFor(contactById.get(c.authorContactId))}</span>
                                {'：'}
                                {c.content}
                              </p>
                            ))}
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
