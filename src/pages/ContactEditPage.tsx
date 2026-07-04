import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { AvatarPicker } from '../components/AvatarPicker'
import { randomAvatarColor } from '../lib/colors'
import { AVATAR_EMOJIS } from '../lib/avatarEmojis'

interface ConfirmState {
  name: string
  persona: string
}

export function ContactEditPage() {
  const { contactId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const isEditingExisting = !!contactId
  const confirmState = location.state as ConfirmState | null

  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState(AVATAR_EMOJIS[Math.floor(Math.random() * AVATAR_EMOJIS.length)])
  const [avatarColor] = useState(randomAvatarColor())
  const [systemPrompt, setSystemPrompt] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [pickingAvatar, setPickingAvatar] = useState(false)

  useEffect(() => {
    if (isEditingExisting) {
      db.contacts.get(contactId!).then((c) => {
        if (c) {
          setName(c.name)
          setAvatar(c.avatar)
          setSystemPrompt(c.systemPrompt)
        }
        setLoaded(true)
      })
    } else if (confirmState) {
      setName(confirmState.name)
      setSystemPrompt(confirmState.persona)
      setLoaded(true)
    } else {
      // no generated data to confirm — bounce back to the questionnaire
      navigate('/contact/new', { replace: true })
    }
  }, [contactId, isEditingExisting, confirmState, navigate])

  async function handleSave() {
    const trimmedName = name.trim()
    if (!trimmedName) return

    if (isEditingExisting) {
      await db.contacts.update(contactId!, { avatar, systemPrompt })
      navigate(`/contact/${contactId}`, { replace: true })
    } else {
      const id = uuid()
      const now = Date.now()
      await db.contacts.add({
        id,
        name: trimmedName,
        avatar,
        avatarColor,
        systemPrompt,
        createdAt: now,
        memoryFacts: '',
        memoryStyle: '',
        memoryUpdatedAt: 0,
        memoryMessageCursor: 0,
      })
      await db.conversations.add({
        id: uuid(),
        contactId: id,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      })
      navigate(`/contact/${id}`, { replace: true })
    }
  }

  if (!loaded) return null

  return (
    <div className="flex min-h-full flex-col bg-[#f4f4f6]">
      <TopBar title={isEditingExisting ? '编辑资料' : '确认新联系人'} showBack />

      <section className="mt-3 bg-white px-4 py-4">
        <label className="mb-1 block text-xs text-gray-400">头像</label>
        <button
          onClick={() => setPickingAvatar(true)}
          className="mb-3 flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2"
        >
          <Avatar avatar={avatar} color={avatarColor} size={44} />
          <span className="text-sm text-gray-500">点击更换</span>
        </button>

        <label className="mb-1 block text-xs text-gray-400">名字</label>
        {isEditingExisting ? (
          <>
            <p className="w-full rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-500">{name}</p>
            <p className="mt-1 text-[11px] text-gray-400">名字是TA自己的 不能由你重新命名 想换个称呼可以在名片里设置备注</p>
          </>
        ) : (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="AI生成的名字 可以再改改"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
        )}
      </section>

      <section className="mt-3 flex-1 bg-white px-4 py-4">
        <label className="mb-2 block text-xs font-medium text-gray-400">
          人物设定（可自由修改，用于微调这个AI的性格细节）
        </label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={12}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm leading-relaxed text-gray-700"
        />
      </section>

      <div className="sticky bottom-0 border-t border-gray-100 bg-white p-3">
        <button
          onClick={handleSave}
          disabled={!name.trim()}
          className="w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-40"
        >
          {isEditingExisting ? '保存' : '添加这个联系人'}
        </button>
      </div>

      {pickingAvatar && <AvatarPicker onSelect={setAvatar} onClose={() => setPickingAvatar(false)} />}
    </div>
  )
}
