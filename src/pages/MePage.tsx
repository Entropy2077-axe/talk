import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Fullscreen } from '@boengli/capacitor-fullscreen'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { useSettingsStore } from '../store/useSettingsStore'
import { formatCurrency } from '../lib/wallet'
import { checkForUpdate } from '../lib/updateCheck'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { claimDailySalaries, localDateKey, USER_WALLET_ID } from '../lib/finance'
import { useModuleEnabled } from '../features'
import { uiThemeName } from '../lib/uiTheme'

// The Android plugin does not expose a status query. Keep the state at module
// scope so it survives navigating away from and back to the Me tab while the
// current WebView process is alive.
let androidFullscreenActive = false

function refreshViewportAfterSystemUiChange() {
  const notify = () => window.dispatchEvent(new Event('talk:system-ui-change'))
  notify()
  // Android applies window-inset and cutout changes asynchronously. Measure
  // once after layout and once after the system-bar animation has settled.
  requestAnimationFrame(() => requestAnimationFrame(notify))
  window.setTimeout(notify, 200)
}

export function MePage() {
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const { userAvatar, userNickname } = settings
  const wallet = useLiveQuery(() => db.walletAccounts.get(USER_WALLET_ID), [])
  const [checking, setChecking] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('')
  const [updateUrl, setUpdateUrl] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(() =>
    Capacitor.getPlatform() === 'android' ? androidFullscreenActive : Boolean(document.fullscreenElement),
  )
  const [fullscreenError, setFullscreenError] = useState('')
  const saveLoadEnabled = useModuleEnabled('saveLoad')
  const careerEnabled = useModuleEnabled('career')
  const salaryClaim = useLiveQuery(() => db.walletTransactions.where('idempotencyKey').equals(`salary:user:${localDateKey()}`).first(), [])
  const [claimingSalary, setClaimingSalary] = useState(false)
  const [salaryMessage, setSalaryMessage] = useState('')

  async function claimSalary() {
    setClaimingSalary(true)
    setSalaryMessage('')
    try {
      const result = await claimDailySalaries()
      setSalaryMessage(`已领取 ${formatCurrency(result.userAmount, settings)}，并为 ${result.contactCount} 位 AI 发放工资`)
    } catch (error) {
      setSalaryMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setClaimingSalary(false)
    }
  }

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
      if (Capacitor.getPlatform() === 'android') {
        if (androidFullscreenActive) {
          await Fullscreen.deactivateImmersiveMode()
          androidFullscreenActive = false
        } else {
          await Fullscreen.activateImmersiveMode()
          androidFullscreenActive = true
        }
        setIsFullscreen(androidFullscreenActive)
        refreshViewportAfterSystemUiChange()
      } else if (document.fullscreenElement) {
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
    <div className="relative flex min-h-full flex-col bg-[var(--ui-bg)] pb-5">
      <TopBar title="我" />

      <section className="border-b border-[var(--ui-border-soft)] bg-[var(--ui-surface)] px-4 pb-5 pt-4">
        <button type="button" onClick={() => navigate('/profile/edit')} className="flex w-full items-center gap-4 text-left active:opacity-70">
          <Avatar avatar={userAvatar} size={68} />
          <span className="min-w-0 flex-1">
            <span className="ui-font-display block truncate text-xl font-semibold text-[var(--ui-text)]">{userNickname}</span>
            <span className="mt-1 block text-xs text-[var(--ui-text-3)]">{settings.userOccupation || '还没有设置职业'} · 点击编辑个人资料</span>
          </span>
          <span className="text-lg text-[var(--ui-text-3)]">›</span>
        </button>
        <div className="mt-4 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface-2)] px-4 py-3">
          <p className="text-[11px] text-[var(--ui-text-3)]">我的余额</p>
          <p className="ui-font-display mt-1 text-lg font-semibold text-[var(--ui-text)]">{formatCurrency(wallet?.balance ?? 0, settings)}</p>
        </div>
      </section>

      {careerEnabled && (
        <section className="mx-3 mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="ui-font-display font-semibold text-[var(--ui-text)]">今日工资</p>
              <p className="mt-0.5 text-xs text-[var(--ui-text-3)]">领取时会同时为所有已入职 AI 发薪</p>
            </div>
            <button type="button" onClick={() => void claimSalary()} disabled={claimingSalary || !!salaryClaim || !settings.userOccupation} className="shrink-0 rounded-[var(--ui-radius-control)] bg-[var(--ui-action)] px-3 py-2 text-sm text-[var(--ui-on-action)] disabled:opacity-45">
              {claimingSalary ? '发放中…' : salaryClaim ? '今日已领取' : settings.userOccupation ? '签到领取' : '尚未入职'}
            </button>
          </div>
          {salaryMessage && <p className="mt-2 text-xs text-[var(--ui-text-2)]">{salaryMessage}</p>}
        </section>
      )}

      <h2 className="px-4 pb-2 pt-5 text-xs font-medium text-[var(--ui-text-3)]">使用体验</h2>
      <section className="mx-3 overflow-hidden rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] shadow-[var(--ui-shadow)]">
        <button
          type="button"
          onClick={() => navigate('/experience-mode')}
          className="flex w-full items-center justify-between border-b border-[var(--ui-border-soft)] px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">体验模式</span>
          <span className="flex items-center gap-2 text-xs text-gray-400">{settings.experienceMode === 'immersive' ? '沉浸模式' : '自由模式'}<span>›</span></span>
        </button>
        <button
          type="button"
          onClick={handleFullscreen}
          className="flex w-full items-center justify-between border-b border-[var(--ui-border-soft)] px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">{isFullscreen ? '退出全屏' : '进入全屏'}</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {isFullscreen ? (
              <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <path d="M4 9V4h5M15 4h5v5M4 15v5h5M20 15v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </button>
        {fullscreenError && <p className="border-b border-[var(--ui-border-soft)] px-4 pb-3 text-xs text-[var(--ui-danger-ink)]">{fullscreenError}</p>}
        <button
          type="button"
          onClick={() => navigate('/appearance')}
          className="flex w-full items-center justify-between px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">软件风格切换</span>
          <span className="flex items-center gap-2 text-xs text-gray-400">
            {uiThemeName(settings.uiTheme)}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
      </section>

      <h2 className="px-4 pb-2 pt-5 text-xs font-medium text-[var(--ui-text-3)]">AI 与内容</h2>
      <section className="mx-3 overflow-hidden rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] shadow-[var(--ui-shadow)]">
        <button
          type="button"
          onClick={() => navigate('/presets')}
          className="flex w-full items-center justify-between border-b border-[var(--ui-border-soft)] px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">预设</span>
          <span className="flex items-center gap-2 text-xs text-gray-400">生成参数与提示词<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
        </button>
        <button
          onClick={() => navigate('/modules')}
          className="flex w-full items-center justify-between border-b border-[var(--ui-border-soft)] px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">模组</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={() => navigate('/stickers')}
          className="flex w-full items-center justify-between border-b border-[var(--ui-border-soft)] px-4 py-3.5 text-left active:bg-gray-50"
        >
          <span className="text-[15px] text-gray-900">表情包管理</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {saveLoadEnabled && <button onClick={() => navigate('/save-load')} className="flex w-full items-center justify-between px-4 py-3.5 text-left active:bg-gray-50"><span className="text-[15px] text-gray-900">选择世界</span><span className="text-[var(--ui-text-3)]">›</span></button>}
      </section>

      <h2 className="px-4 pb-2 pt-5 text-xs font-medium text-[var(--ui-text-3)]">应用管理</h2>
      <section className="mx-3 overflow-hidden rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] shadow-[var(--ui-shadow)]">
        <button onClick={() => navigate('/settings')} className="flex w-full items-center justify-between border-b border-[var(--ui-border-soft)] px-4 py-3.5 text-left active:bg-gray-50"><span className="text-[15px] text-[var(--ui-text)]">通用设置</span><span className="text-[var(--ui-text-3)]">›</span></button>
        <button onClick={() => navigate('/settings/other-interfaces')} className="flex w-full items-center justify-between border-b border-[var(--ui-border-soft)] px-4 py-3.5 text-left active:bg-gray-50"><span className="text-[15px] text-[var(--ui-text)]">其他接口</span><span className="text-[var(--ui-text-3)]">›</span></button>
        <button
          onClick={updateUrl ? () => window.open(updateUrl, '_blank') : handleCheckUpdate}
          disabled={checking}
          className="flex w-full items-center justify-between px-4 py-3.5 text-left active:bg-gray-50 disabled:opacity-50"
        >
          <span className="text-[15px] text-gray-900">检查更新</span>
          <span className="text-xs text-gray-400">
            {checking ? '检查中…' : updateMessage || `当前 v${__APP_VERSION__}`}
          </span>
        </button>
      </section>
    </div>
  )
}
