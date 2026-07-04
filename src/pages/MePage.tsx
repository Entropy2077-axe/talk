import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { useSettingsStore } from '../store/useSettingsStore'

export function MePage() {
  const navigate = useNavigate()
  const { userAvatar, userNickname } = useSettingsStore()

  return (
    <div className="relative flex min-h-full flex-col bg-[#f4f4f6]">
      <TopBar title="我" />

      <button
        onClick={() => navigate('/profile/edit')}
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
    </div>
  )
}
