import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { FileSliders, Palette } from 'lucide-react'
import { ActionSheet } from '../components/ActionSheet'
import { ImageCropper } from '../components/ImageCropper'
import { useSettingsStore } from '../store/useSettingsStore'
import { listModels, testConnection } from '../lib/deepseek'
import { tavilySearch } from '../lib/webSearch'
import { apiKeyFingerprint, testPexelsConnection } from '../lib/photoSearch'
import { friendlyConnectionError } from '../lib/connectionError'
import { isImageProviderReady } from '../lib/mediaProviders'
import { db } from '../db/db'
import { assertTalkBackup, backupFileName, createBackup, mergeSettingsPreservingSecrets, restoreBackup } from '../lib/backup'
import { resumeMediaAssets } from '../lib/imageAssets'
import { ensureWorldSnapshotsMigrated } from '../lib/worldSnapshots'
import type { AppSettings } from '../types'
import { useLiveQuery } from 'dexie-react-hooks'
import { USER_WALLET_ID, setUserBalance } from '../lib/finance'
import { formatCurrency } from '../lib/wallet'
import { CHAT_PAGE_SIZE_OPTIONS, normalizeChatPageSize } from '../lib/chatPagination'
import { ModelPicker } from '../components/ModelPicker'
import { ToggleSwitch } from '../components/ToggleSwitch'
import { AI_PROVIDERS, AI_PROVIDER_OPTIONS, resolveChatCompletionsUrl, resolveModelsUrl, type AiProviderId } from '../lib/aiProviders'
import { cancelAllContactGenerationTasks, markPersistedContactGenerationTasksPaused } from '../lib/contactGenerationTasks'
import { Capacitor } from '@capacitor/core'
import { BackupDirectory } from '../lib/backupDirectory'
import { legacyFieldsForApiConfig, orderedAiApiConfigs } from '../lib/aiApiConfigs'

export function SettingsPage() {
  const navigate = useNavigate()
  const {
    aiProvider,
    apiKey,
    baseUrl,
    model,
    utilityModel,
    tavilyApiKey,
    pexelsApiKey,
    imageProvider,
    imageProviders,
    animationsEnabled,
    chatBackground,
    chatPageSize,
    chatResponseTimeoutMs,
    currencyIconMode,
    customCurrencyEmoji,
    adminModeEnabled,
    experienceMode,
    topInsetAdjustmentPx,
    automaticAiDailyCap,
    aiApiConfigs,
    aiApiFailoverOrder,
    worldEconomyIsolated,
    setSettings,
  } = useSettingsStore()
  const [confirmingWipe, setConfirmingWipe] = useState(false)
  const [switchingApi, setSwitchingApi] = useState(false)
  const [backupStatus, setBackupStatus] = useState('')
  const [restoringBackup, setRestoringBackup] = useState(false)
  const [backgroundCropSrc, setBackgroundCropSrc] = useState('')
  const wallet = useLiveQuery(() => db.walletAccounts.get(USER_WALLET_ID), [])
  const usage = useLiveQuery(async () => {
    const now = Date.now(); const today = new Date(now).toDateString()
    const records = await db.aiUsageRecords.toArray()
    const recent = records.filter((r) => now - r.createdAt <= 30 * 24 * 60 * 60 * 1000)
    return { today: records.filter((r) => new Date(r.createdAt).toDateString() === today), recent }
  }, [])
  const [adminBalance, setAdminBalance] = useState('')
  const backupInputRef = useRef<HTMLInputElement | null>(null)
  const backgroundInputRef = useRef<HTMLInputElement | null>(null)
  const providerLabel = AI_PROVIDERS[aiProvider].label

  async function handleWipeContacts() {
    await cancelAllContactGenerationTasks()
    await Promise.all([db.messages.clear(), db.conversations.clear(), db.contacts.clear(), db.groups.clear(), db.moments.clear(), db.momentComments.clear(), db.momentLikes.clear(), db.contactRelations.clear(), db.contactMemories.clear(), db.socialEvents.clear(), db.groupPlans.clear(), db.contactLifeStates.clear(), db.lifeEvents.clear(), db.contactExperiences.clear(), db.simulationState.clear(), db.aiUsageRecords.clear(), db.aiTurns.clear(), db.aiTestSuites.clear(), db.adminLogs.clear(), db.adminAiTraces.clear(), db.contactGenerationTasks.clear(), db.mediaAssets.clear()])
    void navigate('/contacts')
  }

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

  async function handleBackgroundImage(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setBackgroundCropSrc(reader.result)
    }
    reader.readAsDataURL(file)
  }

  const [apiKeyDraft, setApiKeyDraft] = useState(apiKey)
  const [providerDraft, setProviderDraft] = useState<AiProviderId>(aiProvider ?? 'deepseek')
  const [baseUrlDraft, setBaseUrlDraft] = useState(baseUrl)
  const [modelDraft, setModelDraft] = useState(model)
  const [utilityModelDraft, setUtilityModelDraft] = useState(utilityModel)
  const [tavilyKeyDraft, setTavilyKeyDraft] = useState(tavilyApiKey)
  const [pexelsKeyDraft, setPexelsKeyDraft] = useState(pexelsApiKey)
  const [visibleApiKeys, setVisibleApiKeys] = useState({ ai: false, tavily: false, pexels: false })
  const pexelsDraftRef = useRef(pexelsApiKey)
  const pexelsRequestRef = useRef(0)
  const pexelsAbortRef = useRef<AbortController | null>(null)
  const presetBackgrounds = ['#f4f4f6', '#f7f0e8', '#eef6f1', '#edf4ff', '#f5efff', '#fff3f0', '#f3f6e8', '#eef7f7']
  const currencyMode = currencyIconMode ?? 'coin'

  const [models, setModels] = useState<string[]>([])
  const [modelPicker, setModelPicker] = useState<'chat' | 'utility' | null>(null)
  const [pulling, setPulling] = useState(false)
  const [pullError, setPullError] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [tavilyTesting, setTavilyTesting] = useState(false)
  const [tavilyTestResult, setTavilyTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [pexelsTesting, setPexelsTesting] = useState(false)
  const [pexelsTestResult, setPexelsTestResult] = useState<{ ok: boolean; message: string; imageUrl?: string; fingerprint: string; verifiedAt?: number } | null>(null)

  let chatEndpointPreview = ''
  let modelsEndpointPreview: string | null = null
  let endpointPreviewError = ''
  try {
    chatEndpointPreview = resolveChatCompletionsUrl(baseUrlDraft, providerDraft)
    modelsEndpointPreview = resolveModelsUrl(baseUrlDraft, providerDraft)
  } catch (error) {
    endpointPreviewError = error instanceof Error ? error.message : String(error)
  }


  function persistConnection() {
    setSettings({ aiProvider: providerDraft, apiKey: apiKeyDraft.trim(), baseUrl: baseUrlDraft.trim(), model: modelDraft.trim() })
  }

  async function handlePullModels() {
    setPulling(true)
    setPullError('')
    try {
      const list = await listModels(apiKeyDraft.trim(), baseUrlDraft.trim(), providerDraft)
      setModels(list)
      if (list.length > 0) {
        // Keep both saved choices valid when switching API providers. A
        // provider-specific stale id must not remain selected after refresh.
        if (!list.includes(modelDraft)) {
          setModelDraft(list[0])
          setSettings({ model: list[0] })
        }
        if (!list.includes(utilityModelDraft)) {
          setUtilityModelDraft(list[0])
          setSettings({ utilityModel: list[0] })
        }
      }
    } catch (err) {
      setPullError(err instanceof Error ? err.message : String(err))
    } finally {
      setPulling(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    persistConnection()
    const result = await testConnection(apiKeyDraft.trim(), baseUrlDraft.trim(), modelDraft.trim(), providerDraft)
    setTestResult(result)
    setTesting(false)
  }

  async function handleTavilyTest() {
    setTavilyTesting(true)
    setTavilyTestResult(null)
    setSettings({ tavilyApiKey: tavilyKeyDraft.trim() })
    try {
      const results = await tavilySearch(tavilyKeyDraft.trim(), 'test')
      setTavilyTestResult({ ok: true, message: `连接成功 搜到${results.length}条结果` })
    } catch (err) {
      setTavilyTestResult({ ok: false, message: friendlyConnectionError(err, 'Tavily') })
    } finally {
      setTavilyTesting(false)
    }
  }

  async function handlePexelsTest() {
    const key = pexelsKeyDraft.trim()
    const fingerprint = apiKeyFingerprint(key)
    const requestId = ++pexelsRequestRef.current
    pexelsAbortRef.current?.abort()
    const controller = new AbortController()
    pexelsAbortRef.current = controller
    setPexelsTesting(true)
    setPexelsTestResult(null)
    try {
      const result = await testPexelsConnection(key, controller.signal)
      if (requestId !== pexelsRequestRef.current || apiKeyFingerprint(pexelsDraftRef.current) !== fingerprint) return
      setSettings({ pexelsApiKey: key })
      setPexelsTestResult({ ok: true, message: '连接成功，已通过当前 Key 拉取测试图片', imageUrl: result.photo.url, fingerprint: result.fingerprint, verifiedAt: result.verifiedAt })
    } catch (err) {
      if (controller.signal.aborted || requestId !== pexelsRequestRef.current) return
      setPexelsTestResult({ ok: false, message: friendlyConnectionError(err, 'Pexels'), fingerprint })
    } finally {
      if (requestId === pexelsRequestRef.current) setPexelsTesting(false)
    }
  }

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[var(--ui-bg)]">
      <TopBar title="设置" showBack />
      <div className="flex flex-1 flex-col overflow-y-auto">

      <section className="order-0 border-b border-[var(--ui-border-soft)] bg-[var(--ui-surface)] px-4 pb-4 pt-5">
        <p className="text-xs font-medium text-[var(--ui-text-3)]">通用设置</p>
        <h1 className="mt-1 text-lg font-semibold text-[var(--ui-text)]">管理 AI、聊天体验与本机数据</h1>
        <div className="mt-4 flex items-center justify-between gap-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface-2)] px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs text-[var(--ui-text-2)]">当前 AI 服务</p>
            <p className="mt-0.5 truncate text-sm font-medium text-[var(--ui-text)]">{providerLabel} · {model || '尚未选择模型'}</p>
          </div>
          <span className={`shrink-0 text-xs ${apiKey ? 'text-[var(--ui-success-ink)]' : 'text-[var(--ui-warning-ink)]'}`}>
            {apiKey ? '已配置' : '待配置'}
          </span>
        </div>
      </section>

      <h2 className="order-5 px-4 pb-1 pt-5 text-xs font-medium text-[var(--ui-text-3)]">AI 与创作</h2>

      <section className="order-50 mt-3 bg-[var(--ui-surface)] px-4 py-3">
        <h2 className="mb-2 text-xs font-medium text-gray-400">外观</h2>
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between">
            <div><p className="text-sm text-gray-800">顶部显示区域</p><p className="text-xs text-gray-400">自动避开系统安全区，并额外向下微调</p></div>
            <span className="text-xs text-gray-500">+{topInsetAdjustmentPx ?? 0}px</span>
          </div>
          <input aria-label="顶部显示区域微调" type="range" min="0" max="80" step="1" value={topInsetAdjustmentPx ?? 0} onChange={(e) => setSettings({ topInsetAdjustmentPx: Number(e.target.value) })} className="w-full accent-gray-900" />
          <button type="button" onClick={() => setSettings({ topInsetAdjustmentPx: 0 })} className="mt-1 text-xs text-gray-500">恢复默认</button>
        </div>
        <div className="mb-3 flex items-center justify-between border-t border-gray-100 pt-3">
          <div>
            <p className="text-sm text-gray-800">界面动效</p>
            <p className="mt-0.5 text-[11px] text-gray-400">切换、提示与消息出现的轻量动画</p>
          </div>
          <ToggleSwitch
            checked={animationsEnabled ?? true}
            onChange={(checked) => setSettings({ animationsEnabled: checked })}
            ariaLabel="切换界面动效"
            size="sm"
            activeTone="dark"
          />
        </div>

        <label className="mb-1 block text-xs text-gray-500">聊天背景色</label>
        <div className="mb-2 flex flex-wrap gap-2">
          {presetBackgrounds.map((color) => (
            <button
              key={color}
              onClick={() => setSettings({ chatBackground: color })}
              aria-label={`应用背景色 ${color}`}
              className={`h-8 w-8 rounded-full border ${
                chatBackground === color ? 'border-gray-900 ring-2 ring-gray-300' : 'border-gray-200'
              }`}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
        <div className="mb-2 flex gap-2">
          <input
            type="color"
            value={chatBackground && chatBackground.startsWith('#') ? chatBackground : '#ededed'}
            onChange={(e) => setSettings({ chatBackground: e.target.value })}
            className="h-10 w-14 rounded-lg border border-gray-200 p-1"
          />
          <button
            onClick={() => backgroundInputRef.current?.click()}
            className="flex-1 rounded-lg bg-gray-100 py-2 text-sm text-gray-700"
          >
            上传背景图
          </button>
          <button
            onClick={() => setSettings({ chatBackground: '' })}
            className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-700"
          >
            默认
          </button>
        </div>
        <input
          ref={backgroundInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleBackgroundImage(file)
            if (backgroundInputRef.current) backgroundInputRef.current.value = ''
          }}
        />
        <p className="text-[11px] text-gray-400">背景只保存在本机，导出备份时会一起带走。</p>
      </section>
      <section className="order-40 mt-3 bg-[var(--ui-surface)] px-4 py-3">
        <h2 className="mb-2 text-xs font-medium text-gray-400">聊天</h2>
        <label className="mb-1 block text-sm text-gray-800" htmlFor="chat-page-size">每次加载消息条数</label>
        <p className="mb-2 text-[11px] leading-relaxed text-gray-400">打开聊天时先加载这么多条；滚动到顶部后，每次继续加载相同数量。默认 40 条。</p>
        <div className="flex items-center gap-2">
          <select
            id="chat-page-size"
            aria-label="每次加载消息条数"
            value={normalizeChatPageSize(chatPageSize)}
            onChange={(event) => setSettings({ chatPageSize: Number(event.target.value) })}
            className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
          >
            {CHAT_PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} 条</option>)}
          </select>
          <button type="button" onClick={() => setSettings({ chatPageSize: 40 })} className="rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-600">恢复默认</button>
        </div>
        <div className="mt-4 border-t border-gray-100 pt-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-gray-800">回复等待超时</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-gray-400">超时会停止本轮生成，保留已显示的消息，并可手动重试。</p>
            </div>
            <ToggleSwitch
              checked={chatResponseTimeoutMs > 0}
              onChange={(checked) => setSettings({ chatResponseTimeoutMs: checked ? 60 * 1000 : 0 })}
              ariaLabel="切换回复等待超时"
              size="sm"
              activeTone="dark"
            />
          </div>
          {chatResponseTimeoutMs > 0 && (
            <label className="mt-3 block text-xs text-gray-500" htmlFor="chat-response-timeout">
              超时时间（秒）
              <input
                id="chat-response-timeout"
                aria-label="回复等待超时时间（秒）"
                type="number"
                min="5"
                max="600"
                step="1"
                value={Math.round(chatResponseTimeoutMs / 1000)}
                onChange={(event) => {
                  const seconds = Number(event.target.value)
                  if (!Number.isFinite(seconds)) return
                  setSettings({ chatResponseTimeoutMs: Math.max(5, Math.min(600, Math.round(seconds))) * 1000 })
                }}
                className="mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800"
              />
            </label>
          )}
        </div>
      </section>
      {adminModeEnabled && <section className="order-60 mt-3 bg-white px-4 py-3"><h2 className="text-sm font-medium text-gray-900">设定我的余额</h2><p className="mt-1 text-xs text-gray-400">当前 {formatCurrency(wallet?.balance ?? 0, useSettingsStore.getState())}</p><div className="mt-2 flex gap-2"><input type="number" min="0" value={adminBalance} onChange={e=>setAdminBalance(e.target.value)} placeholder="目标余额" className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"/><button onClick={async()=>{const n=Number(adminBalance);if(Number.isFinite(n)&&n>=0&&confirm(`确认将余额设为 ${Math.round(n)}？`)){await setUserBalance(n);setAdminBalance('')}}} className="rounded-lg bg-gray-900 px-4 text-sm text-white">设定</button></div></section>}

      <section className="order-60 mt-3 bg-[var(--ui-surface)] px-4 py-3">
        <h2 className="mb-2 text-xs font-medium text-gray-400">货币图标</h2>
        <div className="grid grid-cols-4 gap-2">
          {[
            { mode: 'coin' as const, label: '🪙', text: '金币' },
            { mode: 'emoji' as const, label: customCurrencyEmoji || '💎', text: 'emoji' },
            { mode: 'yen' as const, label: '¥', text: '人民币' },
            { mode: 'dollar' as const, label: '$', text: '美元' },
          ].map((item) => (
            <button
              key={item.mode}
              onClick={() => setSettings({ currencyIconMode: item.mode })}
              className={`rounded-lg border px-2 py-2 text-center ${
                currencyMode === item.mode ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 bg-white text-gray-700'
              }`}
            >
              <span className="block text-lg">{item.label}</span>
              <span className="text-[11px]">{item.text}</span>
            </button>
          ))}
        </div>
        {currencyMode === 'emoji' && (
          <input
            value={customCurrencyEmoji ?? ''}
            onChange={(e) => setSettings({ customCurrencyEmoji: e.target.value.slice(0, 4) })}
            placeholder="输入一个表情"
            className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
        )}
      </section>

      <section className="order-110 mt-3 bg-white px-4 py-3"><h2 className="mb-2 text-xs font-medium text-gray-400">AI 调用预算</h2><p className="mb-2 text-xs text-gray-500">后台自动任务达到上限后会跳过；手动聊天和手动生成不会受限。</p>{usage && <><div className="mb-2 grid grid-cols-2 gap-2 text-xs text-gray-600"><p>今日调用 <b>{usage.today.filter((r) => r.success).length}</b></p><p>近30天 <b>{usage.recent.filter((r) => r.success).length}</b></p><p>今日估算 tokens <b>{usage.today.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0)}</b></p><p>自动调用 <b>{usage.today.filter((r) => r.automatic && r.success).length}</b></p></div><div className="mb-3 flex flex-wrap gap-1">{(['chat','proactive','memory','moments','worldbook','offlineState','persona','quality','other'] as const).map((purpose) => <span key={purpose} className="rounded bg-gray-100 px-1.5 py-1 text-[10px] text-gray-500">{purpose} {usage.today.filter((r) => r.purpose === purpose && r.success).length}</span>)}</div></>}<label className="mb-1 block text-xs text-gray-500">自动任务每日调用上限（0 为不限）</label><input type="number" min="0" value={automaticAiDailyCap} onChange={(e) => setSettings({ automaticAiDailyCap: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/></section>

      <section className="order-10 mt-3 bg-[var(--ui-surface)]">
        <button type="button" onClick={() => navigate('/settings/api-configurations')} className="flex w-full items-center gap-3 px-4 py-4 text-left">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-[var(--ui-special-ink)]">AI</div>
          <div className="min-w-0 flex-1"><p className="text-sm text-gray-900">API 配置</p><p className="mt-0.5 truncate text-xs text-gray-400">{providerLabel} · {model || '未选择模型'}；支持主 API 与备用 API</p></div>
          <span className="text-lg text-gray-300">›</span>
        </button>
        <button type="button" onClick={() => setSwitchingApi(true)} className="mx-4 mb-4 w-[calc(100%-2rem)] rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700">快速切换主 API</button>
      </section>

      <section className="order-10 hidden mt-3 bg-[var(--ui-surface)] px-4 py-3" aria-hidden="true">
        <h2 className="mb-2 text-xs font-medium text-gray-400">AI 供应商与 API 配置</h2>

        <label className="mb-1 block text-xs text-gray-500">供应商</label>
        <select
          value={providerDraft}
          onChange={(event) => {
            const next = event.target.value as AiProviderId
            setProviderDraft(next)
            setModels([])
            setPullError('')
            setTestResult(null)
            if (next !== 'custom') setBaseUrlDraft(AI_PROVIDERS[next].defaultBaseUrl)
            setSettings({ aiProvider: next, ...(next !== 'custom' ? { baseUrl: AI_PROVIDERS[next].defaultBaseUrl } : {}) })
          }}
          className="mb-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        >
          {AI_PROVIDER_OPTIONS.map((provider) => (
            <option key={provider.id} value={provider.id}>{provider.label} · {provider.stability === 'stable' ? '稳定支持' : provider.stability === 'experimental' ? '实验性' : '自行兼容'}</option>
          ))}
        </select>
        <p className={`mb-3 text-[11px] leading-relaxed ${providerDraft === 'deepseek' ? 'text-green-600' : 'text-amber-600'}`}>
          {providerDraft === 'deepseek'
            ? 'DeepSeek 已经过完整实测，属于稳定支持。'
            : providerDraft === 'custom'
              ? '自定义接口会按 OpenAI Chat Completions 协议尝试调用，不保证供应商行为。'
              : '该供应商依据官方兼容协议完成适配，目前未使用对应真实 Key 做长期验证，属于实验性支持。'}
        </p>

        <label className="mb-1 block text-xs text-gray-500">API Key</label>
        <div className="relative mb-3">
          <input
            value={apiKeyDraft}
            onChange={(e) => {
              setApiKeyDraft(e.target.value)
              setTestResult(null)
            }}
            onBlur={persistConnection}
            type={visibleApiKeys.ai ? 'text' : 'password'}
            placeholder="sk-..."
            className="w-full rounded-lg border border-gray-200 py-2 pl-3 pr-16 text-sm"
          />
          <button
            type="button"
            onClick={() => setVisibleApiKeys((current) => ({ ...current, ai: !current.ai }))}
            aria-label={visibleApiKeys.ai ? '隐藏 API Key' : '显示 API Key'}
            aria-pressed={visibleApiKeys.ai}
            className="absolute inset-y-0 right-0 px-3 text-xs text-gray-500"
          >
            {visibleApiKeys.ai ? '隐藏' : '显示'}
          </button>
        </div>
        <div className={`mb-3 rounded-lg px-3 py-2 text-[11px] leading-relaxed ${endpointPreviewError ? 'bg-red-50 text-red-500' : 'bg-gray-50 text-gray-500'}`}>
          {endpointPreviewError ? endpointPreviewError : <>
            <p className="break-all">实际聊天地址：{chatEndpointPreview}</p>
            <p className="mt-1 break-all">模型列表地址：{modelsEndpointPreview ?? '该供应商未声明兼容的 Models 接口，请手动填写模型'}</p>
          </>}
        </div>

        <label className="mb-1 block text-xs text-gray-500">Base URL</label>
        <input
          value={baseUrlDraft}
          readOnly={providerDraft !== 'custom'}
          aria-readonly={providerDraft !== 'custom'}
          onChange={(e) => {
            if (providerDraft !== 'custom') return
            setBaseUrlDraft(e.target.value)
            setTestResult(null)
          }}
          onBlur={persistConnection}
          className={`mb-3 w-full rounded-lg border px-3 py-2 text-sm ${
            providerDraft === 'custom'
              ? 'border-gray-200 bg-white text-gray-800'
              : 'cursor-not-allowed border-gray-100 bg-gray-100 text-gray-400'
          }`}
        />
        <label className="mb-1 block text-xs text-gray-500">模型</label>
        <div className="mb-1 flex gap-2">
          {models.length > 0 ? (
            <button
              type="button"
              onClick={() => setModelPicker('chat')}
              className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2 text-left text-sm"
            >
              <span className="min-w-0 flex-1 truncate">{modelDraft}</span>
              <span className="shrink-0 text-xs text-gray-400" aria-hidden="true">▼</span>
            </button>
          ) : (
            <input
              value={modelDraft}
              onChange={(e) => {
                setModelDraft(e.target.value)
                setTestResult(null)
              }}
              onBlur={persistConnection}
              className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
          )}
        </div>
        {pullError && <p className="mb-2 text-xs text-red-500">{pullError}</p>}

        <label className="mb-1 block text-xs text-gray-500">多功能模型（商城生成、好感度评分、世界观草稿等辅助任务，独立于主聊天模型）</label>
        <div className="mb-1 flex gap-2">
          {models.length > 0 ? (
            <button
              type="button"
              onClick={() => setModelPicker('utility')}
              className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2 text-left text-sm"
            >
              <span className="min-w-0 flex-1 truncate">{utilityModelDraft}</span>
              <span className="shrink-0 text-xs text-gray-400" aria-hidden="true">▼</span>
            </button>
          ) : (
            <input
              value={utilityModelDraft}
              onChange={(e) => setUtilityModelDraft(e.target.value)}
              onBlur={() => setSettings({ utilityModel: utilityModelDraft.trim() })}
              className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
          )}
        </div>

        <div className="mt-2 flex gap-2">
          <button
            onClick={handlePullModels}
            disabled={pulling || !apiKeyDraft || !modelsEndpointPreview}
            className="flex-1 rounded-lg bg-gray-100 py-2 text-sm text-gray-700 disabled:opacity-50"
          >
            {pulling ? '拉取中…' : '拉取模型'}
          </button>
          <button
            onClick={handleTest}
            disabled={testing || !apiKeyDraft}
            className="flex-1 rounded-lg bg-gray-900 py-2 text-sm text-white disabled:opacity-50"
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
        </div>
        {testResult && (
          <p className={`mt-2 text-xs ${testResult.ok ? 'text-green-600' : 'text-red-500'}`}>
            {testResult.ok ? '✓ ' : '✗ '}
            {testResult.message}
          </p>
        )}
      </section>

      <section className="order-0 hidden" aria-hidden="true">
        <h2 className="mb-2 text-xs font-medium text-gray-400">联网搜索（Tavily，用于资料库联网补全）</h2>
        <label className="mb-1 block text-xs text-gray-500">Tavily API Key</label>
        <div className="relative mb-2">
          <input
            value={tavilyKeyDraft}
            onChange={(e) => {
              setTavilyKeyDraft(e.target.value)
              setTavilyTestResult(null)
            }}
            onBlur={() => setSettings({ tavilyApiKey: tavilyKeyDraft.trim() })}
            type={visibleApiKeys.tavily ? 'text' : 'password'}
            placeholder="tvly-..."
            className="w-full rounded-lg border border-gray-200 py-2 pl-3 pr-16 text-sm"
          />
          <button
            type="button"
            onClick={() => setVisibleApiKeys((current) => ({ ...current, tavily: !current.tavily }))}
            aria-label={visibleApiKeys.tavily ? '隐藏 Tavily API Key' : '显示 Tavily API Key'}
            aria-pressed={visibleApiKeys.tavily}
            className="absolute inset-y-0 right-0 px-3 text-xs text-gray-500"
          >
            {visibleApiKeys.tavily ? '隐藏' : '显示'}
          </button>
        </div>
        <button
          onClick={handleTavilyTest}
          disabled={tavilyTesting || !tavilyKeyDraft}
          className="w-full rounded-lg bg-gray-900 py-2 text-sm text-white disabled:opacity-50"
        >
          {tavilyTesting ? '测试中…' : '测试连接'}
        </button>
        {tavilyTestResult && (
          <p className={`mt-2 text-xs ${tavilyTestResult.ok ? 'text-green-600' : 'text-red-500'}`}>
            {tavilyTestResult.ok ? '✓ ' : '✗ '}
            {tavilyTestResult.message}
          </p>
        )}
        <p className="mt-2 text-[11px] text-gray-400">
          去 tavily.com 免费注册可以拿到一个key，用于把网络热梗、番剧、游戏和其他搜索资料保存到资料库；聊天遇到陌生词时也可以按需补全
        </p>
      </section>

      <section className="order-0 hidden" aria-hidden="true">
        <h2 className="mb-2 text-xs font-medium text-gray-400">图片（Pexels，头像自动配图+朋友圈配图）</h2>
        <label className="mb-1 block text-xs text-gray-500">Pexels API Key</label>
        <div className="relative mb-2">
          <input
            value={pexelsKeyDraft}
            onChange={(e) => {
              setPexelsKeyDraft(e.target.value)
              pexelsDraftRef.current = e.target.value
              pexelsRequestRef.current += 1
              pexelsAbortRef.current?.abort()
              setPexelsTesting(false)
              setPexelsTestResult(null)
            }}
            onBlur={() => setSettings({ pexelsApiKey: pexelsKeyDraft.trim() })}
            type={visibleApiKeys.pexels ? 'text' : 'password'}
            placeholder="Pexels API Key"
            className="w-full rounded-lg border border-gray-200 py-2 pl-3 pr-16 text-sm"
          />
          <button
            type="button"
            onClick={() => setVisibleApiKeys((current) => ({ ...current, pexels: !current.pexels }))}
            aria-label={visibleApiKeys.pexels ? '隐藏 Pexels API Key' : '显示 Pexels API Key'}
            aria-pressed={visibleApiKeys.pexels}
            className="absolute inset-y-0 right-0 px-3 text-xs text-gray-500"
          >
            {visibleApiKeys.pexels ? '隐藏' : '显示'}
          </button>
        </div>
        <button
          onClick={handlePexelsTest}
          disabled={pexelsTesting || !pexelsKeyDraft}
          className="w-full rounded-lg bg-gray-900 py-2 text-sm text-white disabled:opacity-50"
        >
          {pexelsTesting ? '测试中…' : '测试连接'}
        </button>
        {pexelsTestResult && (
          <div className={`mt-2 rounded-lg p-2 text-xs ${pexelsTestResult.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-500'}`}>
            <div className="flex items-center gap-3">
              {pexelsTestResult.imageUrl && <img src={pexelsTestResult.imageUrl} alt="Pexels 测试图片" className="h-14 w-14 shrink-0 rounded-lg object-cover" />}
              <div className="min-w-0">
                <p>{pexelsTestResult.ok ? '✓ ' : '✗ '}{pexelsTestResult.message}</p>
                <p className="mt-1 font-mono text-[10px] opacity-70">Key {pexelsTestResult.fingerprint}</p>
                {pexelsTestResult.verifiedAt && <p className="mt-0.5 text-[10px] opacity-70">验证时间：{new Date(pexelsTestResult.verifiedAt).toLocaleString()}</p>}
              </div>
            </div>
          </div>
        )}
        <p className="mt-2 text-[11px] text-gray-400">
          去 pexels.com/api 免费注册可以拿到一个key 用于创建联系人时自动配一张符合性格的头像照片、以及朋友圈动态偶尔配的插图 动漫风格头像走的是另一个不需要key的免费接口
        </p>
      </section>

      <section className="order-0 hidden" aria-hidden="true">
        <button type="button" onClick={() => navigate('/settings/other-interfaces')} className="flex w-full items-center gap-3 px-4 py-4 text-left">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-[var(--ui-special-ink)]"><Palette size={20} /></div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-gray-900">其他接口</p>
            <p className={`mt-0.5 text-xs ${isImageProviderReady({ imageProvider, imageProviders }) ? 'text-green-600' : 'text-gray-400'}`}>
              图像、语音、Pexels、Tavily 与动漫图库
            </p>
          </div>
          <span className="text-lg text-gray-300">›</span>
        </button>
      </section>

      <section className="order-20 hidden mt-3 bg-[var(--ui-surface)]" aria-hidden="true">
        <button type="button" onClick={() => navigate('/presets')} className="flex w-full items-center gap-3 px-4 py-4 text-left">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-[var(--ui-special-ink)]"><FileSliders size={20} /></div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-gray-900">预设</p>
            <p className="mt-0.5 text-xs text-gray-400">生成参数、全局提示词存档与联系人覆盖</p>
          </div>
          <span className="text-lg text-gray-300">›</span>
        </button>
      </section>

      <h2 className="order-35 px-4 pb-1 pt-5 text-xs font-medium text-[var(--ui-text-3)]">聊天体验</h2>


      <section className="order-70 mt-3 bg-[var(--ui-surface)] px-4 py-3">
        <h2 className="mb-2 text-xs font-medium text-gray-400">世界经济与资产</h2>
        <div className="flex items-center justify-between gap-4">
          <div><p className="text-sm text-gray-800">各世界独立保存经济与资产</p><p className="mt-1 text-[11px] leading-relaxed text-gray-400">关闭时，用户余额、仓库、职业和商城记录在所有世界间共用；开启后随世界备份切换。首次开启时，旧世界会沿用当前共享状态作为初始值。</p></div>
          <button type="button" role="switch" aria-checked={worldEconomyIsolated === true} onClick={() => setSettings({ worldEconomyIsolated: worldEconomyIsolated !== true })} className={`relative h-6 w-11 shrink-0 rounded-full ${worldEconomyIsolated === true ? 'bg-green-500' : 'bg-gray-200'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${worldEconomyIsolated === true ? 'left-5.5' : 'left-0.5'}`} /></button>
        </div>
      </section>

      <h2 className="order-65 px-4 pb-1 pt-5 text-xs font-medium text-[var(--ui-text-3)]">世界与本机数据</h2>

      <section className="order-80 mt-3 bg-[var(--ui-surface)] px-4 py-3">
        <h2 className="mb-2 text-xs font-medium text-gray-400">数据备份与恢复</h2>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={handleExportBackup} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white">
            导出备份
          </button>
          <button
            onClick={() => backupInputRef.current?.click()}
            disabled={restoringBackup}
            className="rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700 disabled:opacity-50"
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
        <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
          全量数据备份包含联系人、人设、聊天记录、朋友圈、表情包、仓库、资料库、世界备份和当前设置。为保护隐私，API Key、令牌和密码不会写入备份文件；恢复时将保留这台设备当前保存的密钥。
        </p>
        {backupStatus && <p className="mt-2 text-xs text-gray-500">{backupStatus}</p>}
      </section>

      <section className="order-90 mt-3 bg-[var(--ui-surface)] px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-gray-900">管理员模式</h2>
            <p className="text-[11px] text-gray-400">{experienceMode === 'immersive' ? '沉浸模式下不可开启；切换到自由模式后可以使用' : '开启后可使用天眼查看运行进程、真实提示词、AI 回合、记忆/事件链，并执行安全调试操作'}</p>
          </div>
          <ToggleSwitch
            checked={experienceMode === 'immersive' ? false : adminModeEnabled}
            onChange={(checked) => { if (experienceMode !== 'immersive') setSettings({ adminModeEnabled: checked }) }}
            ariaLabel="切换管理员模式"
          />
        </div>
      </section>

      <h2 className="order-85 px-4 pb-1 pt-5 text-xs font-medium text-[var(--ui-text-3)]">高级与管理</h2>

      <section className="order-100 mt-3 bg-[var(--ui-surface)] px-4 py-3">
        <h2 className="mb-2 text-xs font-medium text-gray-400">危险操作</h2>
        <button
          onClick={() => setConfirmingWipe(true)}
          className="w-full rounded-lg bg-red-50 py-2.5 text-sm text-red-500"
        >
          清空所有联系人与聊天记录
        </button>
        <p className="mt-2 text-[11px] text-gray-400">
          数据存在你这台设备的浏览器本地 这个操作会删除所有联系人、会话和聊天记录 不可恢复
        </p>
      </section>
      </div>

      {confirmingWipe && (
        <ActionSheet
          onClose={() => setConfirmingWipe(false)}
          options={[{ label: '确认清空所有联系人与聊天记录', onSelect: handleWipeContacts, danger: true }]}
        />
      )}
      {backgroundCropSrc && (
        <ImageCropper
          src={backgroundCropSrc}
          aspectRatio={0.68}
          mode="frame"
          title="裁剪聊天背景"
          onCancel={() => setBackgroundCropSrc('')}
          onConfirm={(dataUrl) => {
            setSettings({ chatBackground: dataUrl })
            setBackgroundCropSrc('')
          }}
        />
      )}
      {switchingApi && <ActionSheet onClose={() => setSwitchingApi(false)} options={orderedAiApiConfigs({ aiApiConfigs, aiApiFailoverOrder, aiProvider, apiKey, baseUrl, model, utilityModel, promptPresets: [], activePromptPresetId: '' }).map((config) => ({ label: `${config.name} · ${config.model || '未选模型'}`, onSelect: () => {
        const ordered = [config.id, ...orderedAiApiConfigs({ aiApiConfigs, aiApiFailoverOrder, aiProvider, apiKey, baseUrl, model, utilityModel, promptPresets: [], activePromptPresetId: '' }).filter((item) => item.id !== config.id).map((item) => item.id)]
        setSettings({ aiApiFailoverOrder: ordered, ...legacyFieldsForApiConfig(config) })
      } }))} />}
      {modelPicker && (
        <ModelPicker
          title={modelPicker === 'chat' ? '选择聊天模型' : '选择多功能模型'}
          models={models}
          value={modelPicker === 'chat' ? modelDraft : utilityModelDraft}
          onClose={() => setModelPicker(null)}
          onSelect={(selectedModel) => {
            if (modelPicker === 'chat') {
              setModelDraft(selectedModel)
              setSettings({ model: selectedModel })
              setTestResult(null)
            } else {
              setUtilityModelDraft(selectedModel)
              setSettings({ utilityModel: selectedModel })
            }
          }}
        />
      )}
    </div>
  )
}
