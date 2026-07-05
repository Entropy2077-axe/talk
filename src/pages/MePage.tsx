import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { useSettingsStore } from '../store/useSettingsStore'
import { formatCurrency } from '../lib/wallet'
import { checkForUpdate } from '../lib/updateCheck'

export function MePage() {
  const navigate = useNavigate()
  const { userAvatar, userNickname, walletBalance } = useSettingsStore()
  const [checking, setChecking] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('')
  const [updateUrl, setUpdateUrl] = useState('')

  async function handleCheckUpdate() {
    setChecking(true)
    setUpdateMessage('')
    setUpdateUrl('')
    try {
      const result = await checkForUpdate()
      if (result.hasUpdate) {
        setUpdateMessage(`发现新版本 ${result.latestVersion}，点击前往下载`)
        setUpdateUrl(result.releaseUrl)
      } else {
        setUpdateMessage('已是最新版本')
      }
    } catch (err) {
      setUpdateMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="relative flex min-h-full flex-col bg-[#f4f4f6]">
      <TopBar title="我" />

      <button
        onClick={() => navigate('/profile/edit')}
        className="mt-3 flex items-center justify-between bg-white px-4 py-4 active:bg-gray-50"
      >
        <Avatar avatar={userAvatar} size={60} />
        <div className="flex flex-col items-end gap-1">
          <span className="text-[16px] font-medium text-gray-900">{userNickname}</span>
          <span className="text-xs text-gray-400">{formatCurrency(walletBalance)}</span>
        </div>
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
          className="flex w-full items-center justify-between border-b border-gray-100 bg-white px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">表情包管理</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M9 5l7 7-7 7" stroke="#c7c7cc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={updateUrl ? () => window.open(updateUrl, '_blank') : handleCheckUpdate}
          disabled={checking}
          className="flex w-full items-center justify-between bg-white px-4 py-3.5 text-left active:bg-gray-50 disabled:opacity-50"
        >
          <span className="text-[15px] text-gray-900">检查更新</span>
          <span className="text-xs text-gray-400">
            {checking ? '检查中…' : updateMessage || `当前 v${__APP_VERSION__}`}
          </span>
        </button>
      </div>
    </div>
  )
}
