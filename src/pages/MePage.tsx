import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { useSettingsStore } from '../store/useSettingsStore'

export function MePage() {
  const navigate = useNavigate()
  const { userAvatar, userNickname, setSettings } = useSettingsStore()
  const [editing, setEditing] = useState(false)
  const [nickDraft, setNickDraft] = useState(userNickname)
  const [avatarDraft, setAvatarDraft] = useState(userAvatar)

  function save() {
    setSettings({ userNickname: nickDraft.trim() || '我', userAvatar: avatarDraft.trim() || '🙂' })
    setEditing(false)
  }

  return (
    <div className="relative flex min-h-full flex-col bg-[#f4f4f6]">
      <TopBar title="我" />

      <button
        onClick={() => setEditing(true)}
        className="mt-3 flex items-center justify-between bg-white px-4 py-4 active:bg-gray-50"
      >
        <Avatar avatar={userAvatar} size={60} />
        <span className="text-[16px] font-medium text-gray-900">{userNickname}</span>
      </button>

      <div className="mt-3">
        <button
          onClick={() => navigate('/settings')}
          className="flex w-full items-center justify-between border-b border-gray-100 bg-white px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">设置</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M9 5l7 7-7 7" stroke="#c7c7cc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={() => navigate('/stickers')}
          className="flex w-full items-center justify-between bg-white px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">表情包管理</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M9 5l7 7-7 7" stroke="#c7c7cc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {editing && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-8">
          <div className="w-full rounded-2xl bg-white p-4">
            <h2 className="mb-3 text-center text-[15px] font-medium text-gray-900">编辑资料</h2>
            <label className="mb-1 block text-xs text-gray-400">头像（emoji）</label>
            <input
              value={avatarDraft}
              onChange={(e) => setAvatarDraft(e.target.value)}
              maxLength={4}
              className="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-center text-2xl"
            />
            <label className="mb-1 block text-xs text-gray-400">昵称</label>
            <input
              value={nickDraft}
              onChange={(e) => setNickDraft(e.target.value)}
              maxLength={20}
              className="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setEditing(false)}
                className="flex-1 rounded-lg bg-gray-100 py-2 text-sm text-gray-600"
              >
                取消
              </button>
              <button onClick={save} className="flex-1 rounded-lg bg-gray-900 py-2 text-sm text-white">
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
