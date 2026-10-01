import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { ActionSheet } from '../components/ActionSheet'

import { useSettingsStore } from '../store/useSettingsStore'
import { db } from '../db/db'
import { assertTalkBackup, backupFileName, createBackup, mergeSettingsPreservingSecrets, restoreBackup } from '../lib/backup'
import { resumeMediaAssets } from '../lib/imageAssets'
import { ensureWorldSnapshotsMigrated } from '../lib/worldSnapshots'
import type { AppSettings } from '../types'

import { cancelAllContactGenerationTasks, markPersistedContactGenerationTasksPaused } from '../lib/contactGenerationTasks'
import { Capacitor } from '@capacitor/core'
import { BackupDirectory } from '../lib/backupDirectory'

export function DataSettingsPage() {

  const navigate = useNavigate()
  const { setSettings } = useSettingsStore()
  const [confirmingWipe, setConfirmingWipe] = useState(false)
  const [backupStatus, setBackupStatus] = useState('')
  const [restoringBackup, setRestoringBackup] = useState(false)
  const backupInputRef = useRef<HTMLInputElement | null>(null)
  async function handleExportBackup() {
    setBackupStatus('')
    try {
      setBackupStatus('正在生成备份…')
      const settings = { ...useSettingsStore.getState() } as Partial<AppSettings> & { setSettings?: unknown }
      delete settings.setSettings
      const backup = await createBackup(settings)
      const filename = backupFileName()
      const contents = JSON.stringify(backup, null, 2)

      if (Capacitor.getPlatform() === 'android') {
        const { token } = await BackupDirectory.stage({ contents })
        setBackupStatus('请选择备份文件的保存位置…')
        await BackupDirectory.saveStaged({ token, filename })
        setBackupStatus(`备份已保存：${filename}。API Key、令牌和密码不会写入备份文件。`)
        return
      }

      const blob = new Blob([contents], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setBackupStatus('备份已导出。API Key、令牌和密码不会写入备份文件。')
    } catch (error) {
      setBackupStatus(error instanceof Error ? `备份失败：${error.message}` : '备份失败，请重试。')
    }
  }
  async function handleImportBackup(file: File) {
    setBackupStatus('')
    setRestoringBackup(true)
    try {
      const parsed: unknown = JSON.parse(await file.text())
      assertTalkBackup(parsed)
      if (!window.confirm('导入备份会覆盖当前这台设备里的聊天、联系人、朋友圈、设置等本地数据。确定继续吗？')) {
        return
      }
      await cancelAllContactGenerationTasks()
      await restoreBackup(parsed)
      await markPersistedContactGenerationTasksPaused()
      const restoredSettings = mergeSettingsPreservingSecrets(parsed.settings, useSettingsStore.getState())
      if ((parsed.tables.worldSnapshots ?? []).some((row) => Number((row as { snapshotVersion?: number }).snapshotVersion ?? 1) < 2)) restoredSettings.worldSnapshotMigrationVersion = 1
      setSettings(restoredSettings)
      useSettingsStore.setState(restoredSettings)
      await ensureWorldSnapshotsMigrated()
      await resumeMediaAssets()
      setBackupStatus('备份已恢复。建议返回消息页检查联系人和聊天记录。')
    } catch (err) {
      setBackupStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setRestoringBackup(false)
      if (backupInputRef.current) backupInputRef.current.value = ''
    }
  }
  async function handleWipeContacts() {
    await cancelAllContactGenerationTasks()
    await Promise.all([db.messages.clear(), db.conversations.clear(), db.contacts.clear(), db.groups.clear(), db.moments.clear(), db.momentComments.clear(), db.momentLikes.clear(), db.contactRelations.clear(), db.contactMemories.clear(), db.socialEvents.clear(), db.groupPlans.clear(), db.contactLifeStates.clear(), db.lifeEvents.clear(), db.contactExperiences.clear(), db.simulationState.clear(), db.aiUsageRecords.clear(), db.aiTurns.clear(), db.aiTestSuites.clear(), db.adminLogs.clear(), db.adminAiTraces.clear(), db.contactGenerationTasks.clear(), db.mediaAssets.clear()])
    void navigate('/contacts')
  }

  return <div className="ui-page"><TopBar title="数据管理" showBack /><div className="ui-page-scroll pb-5"><section className="ui-section-card ui-section-spaced">
    <h2 className="mb-2 text-xs font-medium text-[var(--ui-text-3)]">数据备份与恢复</h2>
    <div className="grid grid-cols-2 gap-2">
      <button onClick={handleExportBackup} className="rounded-lg bg-[var(--ui-action)] py-2.5 text-sm text-[var(--ui-on-action)]">
        导出备份
      </button>
      <button
        onClick={() => backupInputRef.current?.click()}
        disabled={restoringBackup}
        className="rounded-lg bg-[var(--ui-surface-2)] py-2.5 text-sm text-[var(--ui-text-2)] disabled:opacity-50"
      >
        {restoringBackup ? '恢复中…' : '导入恢复'}
      </button>
    </div>
    <input
      ref={backupInputRef}
      type="file"
      accept="application/json,.json"
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0]
        if (file) void handleImportBackup(file)
      }}
    />
    <p className="mt-2 text-[11px] leading-relaxed text-[var(--ui-text-3)]">
      全量数据备份包含联系人、人设、聊天记录、朋友圈、表情包、仓库、资料库、世界备份和当前设置。为保护隐私，API Key、令牌和密码不会写入备份文件；恢复时将保留这台设备当前保存的密钥。
    </p>
    {backupStatus && <p className="mt-2 text-xs text-[var(--ui-text-3)]">{backupStatus}</p>}
  </section><section className="ui-section-card ui-section-spaced">
      <h2 className="mb-2 text-xs font-medium text-[var(--ui-text-3)]">危险操作</h2>
      <button
        onClick={() => setConfirmingWipe(true)}
        className="w-full rounded-lg bg-[var(--ui-danger-soft)] py-2.5 text-sm text-[var(--ui-danger-ink)]"
      >
        清空所有联系人与聊天记录
      </button>
      <p className="mt-2 text-[11px] text-[var(--ui-text-3)]">
        数据存在你这台设备的浏览器本地 这个操作会删除所有联系人、会话和聊天记录 不可恢复
      </p>
    </section></div>{confirmingWipe && <ActionSheet onClose={() => setConfirmingWipe(false)} options={[{ label: '确认清空所有联系人与聊天记录', onSelect: handleWipeContacts, danger: true }]} />}</div>
}
