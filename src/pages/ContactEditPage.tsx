import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { DEFAULT_PERSONA_TEMPLATE } from '../lib/prompt'
import { randomAvatarColor } from '../lib/colors'

export function ContactEditPage() {
  const { contactId } = useParams()
  const isNew = !contactId
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState('🙂')
  const [avatarColor, setAvatarColor] = useState(randomAvatarColor())
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_PERSONA_TEMPLATE)
  const [loaded, setLoaded] = useState(isNew)

  useEffect(() => {
    if (!contactId) return
    db.contacts.get(contactId).then((c) => {
      if (c) {
        setName(c.name)
        setAvatar(c.avatar)
        setAvatarColor(c.avatarColor)
        setSystemPrompt(c.systemPrompt)
      }
      setLoaded(true)
    })
  }, [contactId])

  async function handleSave() {
    const trimmedName = name.trim()
    if (!trimmedName) return

    if (isNew) {
      const id = uuid()
      const now = Date.now()
      await db.contacts.add({
        id,
        name: trimmedName,
        avatar,
        avatarColor,
        systemPrompt,
        createdAt: now,
      })
      await db.conversations.add({
        id: uuid(),
        contactId: id,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      })
      navigate(`/contact/${id}`, { replace: true })
    } else if (contactId) {
      await db.contacts.update(contactId, { name: trimmedName, avatar, avatarColor, systemPrompt })
      navigate(`/contact/${contactId}`, { replace: true })
    }
  }

  if (!loaded) return null

  return (
    <div className="flex min-h-full flex-col bg-[#f4f4f6]">
      <TopBar title={isNew ? '新建AI' : '编辑AI'} showBack />

      <section className="mt-3 bg-white px-4 py-4">
        <label className="mb-1 block text-xs text-gray-400">头像（emoji）</label>
        <input
          value={avatar}
          onChange={(e) => setAvatar(e.target.value)}
          maxLength={4}
          className="mb-3 w-20 rounded-lg border border-gray-200 px-3 py-2 text-center text-2xl"
        />

        <label className="mb-1 block text-xs text-gray-400">名字</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="给这个AI起个名字"
          className="mb-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />
      </section>

      <section className="mt-3 flex-1 bg-white px-4 py-4">
        <label className="mb-2 block text-xs font-medium text-gray-400">
          人物设定 / 系统提示词（可自由修改）
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
          保存
        </button>
      </div>
    </div>
  )
}
