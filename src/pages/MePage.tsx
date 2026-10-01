import { useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { useNavigate } from 'react-router-dom'
import { SettingsMenu } from '../components/SettingsMenu'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { useSettingsStore } from '../store/useSettingsStore'
import { formatCurrency } from '../lib/wallet'
import { checkForUpdate, type UpdateCheckResult } from '../lib/updateCheck'
import { InAppUpdate } from '../lib/inAppUpdate'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { claimDailySalaries, localDateKey, USER_WALLET_ID } from '../lib/finance'
import { useModuleEnabled } from '../features'

export function MePage() {
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const { userAvatar, userNickname } = settings
  const wallet = useLiveQuery(() => db.walletAccounts.get(USER_WALLET_ID), [])
  const [checking, setChecking] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('')
  const [availableUpdate, setAvailableUpdate] = useState<UpdateCheckResult | null>(null)
  const [downloadId, setDownloadId] = useState<number | null>(null)
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

  async function handleCheckUpdate() {
    setChecking(true)
    setUpdateMessage('')
    setAvailableUpdate(null)
    setDownloadId(null)
    try {
      const result = await checkForUpdate()
      if (result.hasUpdate) {
        setUpdateMessage(`发现新版本 ${result.latestVersion}`)
        setAvailableUpdate(result)
      } else {
        setUpdateMessage('已是最新版本')
      }
    } catch (err) {
      setUpdateMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  async function handleInstallUpdate() {
    if (!availableUpdate) return
    if (Capacitor.getPlatform() !== 'android' || !availableUpdate.apkUrl) {
      window.open(availableUpdate.releaseUrl, '_blank')
      return
    }
    setChecking(true)
    setUpdateMessage(downloadId === null ? '正在下载 APK…' : '正在打开安装程序…')
    try {
      const result = downloadId === null
        ? await InAppUpdate.downloadAndInstall({ url: availableUpdate.apkUrl, title: `Talk ${availableUpdate.latestVersion}` })
        : await InAppUpdate.installDownloaded({ downloadId })
      setDownloadId(result.downloadId)
      setUpdateMessage(result.status === 'permission-required'
        ? '请允许安装未知应用，返回后再点一次继续安装'
        : '安装程序已打开，请确认更新')
    } catch (error) {
      setUpdateMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="relative min-h-full bg-[var(--ui-bg)] pb-5">
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
        <div className="mt-4 flex items-center justify-between gap-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface-2)] px-4 py-3">
          <div className="min-w-0"><p className="text-[11px] text-[var(--ui-text-3)]">我的余额</p><p className="ui-font-display mt-1 truncate text-lg font-semibold text-[var(--ui-text)]">{formatCurrency(wallet?.balance ?? 0, settings)}</p></div>
          {careerEnabled && <div className="shrink-0 text-right"><p className="mb-1.5 text-[11px] text-[var(--ui-text-3)]">今日工资</p><button type="button" onClick={() => void claimSalary()} disabled={claimingSalary || !!salaryClaim || !settings.userOccupation} className="rounded-[var(--ui-radius-control)] bg-[var(--ui-action)] px-3 py-2 text-sm text-[var(--ui-on-action)] disabled:opacity-45">{claimingSalary ? '发放中…' : salaryClaim ? '今日已领取' : settings.userOccupation ? '签到领取' : '尚未入职'}</button></div>}
        </div>
        {salaryMessage && <p role="status" className="mt-2 text-xs text-[var(--ui-text-2)]">{salaryMessage}</p>}
      </section>

<h2 className="ui-section-label">设置与工具</h2><SettingsMenu />
<section className="ui-list-card ui-section-spaced">
        <button
          onClick={availableUpdate ? () => void handleInstallUpdate() : () => void handleCheckUpdate()}
          disabled={checking}
          className="flex w-full items-center justify-between px-4 py-3.5 text-left active:bg-gray-50 disabled:opacity-50"
        >
          <span className="text-[15px] text-gray-900">检查更新</span>
          <span className="text-xs text-gray-400">
            {checking ? (availableUpdate ? '处理中…' : '检查中…') : updateMessage || `当前 v${__APP_VERSION__}`}
          </span>
        </button>
      </section>
    </div>
  )
}
