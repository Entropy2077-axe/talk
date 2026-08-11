import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { isAiTestId } from '../lib/aiTestIsolation'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { AvatarPicker } from '../components/AvatarPicker'
import { randomAvatarColor } from '../lib/colors'
import { displayName } from '../lib/contact'
import { useSettingsStore } from '../store/useSettingsStore'

const GROUP_AVATAR_DEFAULT = '👥'
const MIN_MEMBERS = 2

export function GroupAddPage() {
  const navigate = useNavigate()
  const contacts = (useLiveQuery(() => db.contacts.toArray(), []) ?? []).filter((item) => !isAiTestId(item.id))
  const activeWorldId = useSettingsStore((state) => state.activeWorldId || state.defaultWorldviewId)

  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState(GROUP_AVATAR_DEFAULT)
  const [pickingAvatar, setPickingAvatar] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [creating, setCreating] = useState(false)

  function toggleMember(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      return [...prev, id]
    })
  }

  async function handleCreate() {
    const trimmedName = name.trim()
    if (!trimmedName || selected.length < MIN_MEMBERS || creating) return
    setCreating(true)
    try {
      const now = Date.now()
      const groupId = uuid()
      await db.groups.add({
        id: groupId,
        name: trimmedName,
        avatar,
        avatarColor: randomAvatarColor(),
        memberContactIds: selected,
        worldviewId: activeWorldId,
        createdAt: now,
        memoryMessageCursor: 0,
      })
      const conversationId = uuid()
      await db.conversations.add({ id: conversationId, groupId, pinned: false, createdAt: now, updatedAt: now })
      void navigate(`/chat/${conversationId}`, { replace: true })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="ui-page">
      <TopBar title="发起群聊" showBack />

      <div className="ui-page-scroll">
        <section className="ui-page-intro"><p className="ui-page-kicker">创建群聊</p><h1 className="ui-page-title">让至少两位联系人加入同一段对话</h1><p className="ui-page-summary">先确定群聊身份，再选择成员；创建后可以继续调整互动方式、成员和共同计划。</p></section>
        <section className="ui-section-card ui-section-spaced">
        <h2 className="ui-section-title">群聊身份</h2><p className="ui-section-summary mb-4">头像和名称会显示在消息列表与群聊顶部。</p>
        <label className="mb-1 block text-xs text-gray-400">群头像</label>
        <button
          onClick={() => setPickingAvatar(true)}
          className="mb-4 flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2"
        >
          <Avatar avatar={avatar} size={44} />
          <span className="text-sm text-gray-500">点击选择</span>
        </button>

        <label className="mb-1 block text-xs text-gray-400">群名称</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="给这个群起个名字"
          maxLength={20}
          className="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />

        </section>
        <h2 className="ui-section-label">选择成员</h2>
        <section className="ui-section-card">
        <label className="mb-2 block text-xs font-medium text-gray-400">
          选择群成员（至少{MIN_MEMBERS}人{selected.length > 0 ? ` · 已选${selected.length}人` : ''}）
        </label>
        {contacts.length === 0 ? (
          <div className="py-6 text-center"><p className="text-sm text-[var(--ui-text-3)]">还没有可加入群聊的联系人</p><button type="button" onClick={() => navigate('/contact/new')} className="ui-primary-action mt-3 px-4 py-2 text-sm">添加联系人</button></div>
        ) : (
          <div className="space-y-1">
            {contacts.map((c) => {
              const checked = selected.includes(c.id)
              return (
                <button
                  key={c.id}
                  onClick={() => toggleMember(c.id)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left active:bg-gray-50"
                >
                  <div
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                      checked ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300'
                    }`}
                  >
                    {checked && '✓'}
                  </div>
                  <Avatar avatar={c.avatar} color={c.avatarColor} size={36} />
                  <span className="min-w-0 flex-1 text-sm text-gray-800">{displayName(c)}</span>
                </button>
              )
            })}
          </div>
        )}
        </section>
      </div>

      <div className="sticky bottom-0 border-t border-[var(--ui-border-soft)] bg-[var(--ui-surface)] p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))]">
        <button
          onClick={handleCreate}
          disabled={!name.trim() || selected.length < MIN_MEMBERS || creating}
          className="ui-primary-action w-full py-3 text-sm font-medium disabled:opacity-40"
        >
          {creating ? '创建中…' : '创建群聊'}
        </button>
      </div>

      {pickingAvatar && <AvatarPicker onSelect={setAvatar} onClose={() => setPickingAvatar(false)} />}
    </div>
  )
}
