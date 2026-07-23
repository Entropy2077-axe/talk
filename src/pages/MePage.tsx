import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { useSettingsStore } from '../store/useSettingsStore'
import { formatCurrency } from '../lib/wallet'
import { checkForUpdate } from '../lib/updateCheck'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { USER_WALLET_ID } from '../lib/finance'
import { useModuleEnabled } from '../features'

export function MePage() {
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const { userAvatar, userNickname } = settings
  const wallet = useLiveQuery(() => db.walletAccounts.get(USER_WALLET_ID), [])
  const [checking, setChecking] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('')
  const [updateUrl, setUpdateUrl] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(document.fullscreenElement))
  const [fullscreenError, setFullscreenError] = useState('')
  const saveLoadEnabled = useModuleEnabled('saveLoad')

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
      setFullscreenError('')
    }
    document.addEventListener('fullscreenchange', syncFullscreenState)
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState)
  }, [])

  async function handleFullscreen() {
    setFullscreenError('')
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      }
    } catch {
      setFullscreenError('当前环境不支持全屏')
    }
  }

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
          <span className="text-xs text-gray-400">{formatCurrency(wallet?.balance ?? 0, settings)}</span>
        </div>
      </button>

      <div className="mt-3">
        <button
          type="button"
          onClick={handleFullscreen}
          className="flex w-full items-center justify-between bg-white px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">{isFullscreen ? '退出全屏' : '进入全屏'}</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {isFullscreen ? (
              <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" stroke="#9ca3af" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <path d="M4 9V4h5M15 4h5v5M4 15v5h5M20 15v5h-5" stroke="#9ca3af" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </button>
        {fullscreenError && <p className="bg-white px-4 pb-3 text-xs text-red-500">{fullscreenError}</p>}
      </div>

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
          onClick={() => navigate('/modules')}
          className="flex w-full items-center justify-between border-b border-gray-100 bg-white px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">模组</span>
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
        {saveLoadEnabled && <button onClick={() => navigate('/save-load')} className="flex w-full items-center justify-between border-b border-gray-100 bg-white px-4 py-3.5 text-left active:bg-gray-50"><span className="text-[15px] text-gray-900">存档与回档</span><span>›</span></button>}
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
