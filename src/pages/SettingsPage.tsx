import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { ActionSheet } from '../components/ActionSheet'
import { ImageCropper } from '../components/ImageCropper'
import { useSettingsStore } from '../store/useSettingsStore'
import { listModels, testConnection } from '../lib/deepseek'
import { DEFAULT_STYLE_PROMPT } from '../lib/prompt'
import { tavilySearch } from '../lib/webSearch'
import { searchPexelsPhoto } from '../lib/photoSearch'
import { imageProviderName, isImageProviderReady } from '../lib/mediaProviders'
import { db } from '../db/db'
import { assertTalkBackup, backupFileName, createBackup, restoreBackup } from '../lib/backup'
import type { AppSettings } from '../types'
import { useLiveQuery } from 'dexie-react-hooks'
import { USER_WALLET_ID, setUserBalance } from '../lib/finance'
import { formatCurrency } from '../lib/wallet'

export function SettingsPage() {
  const navigate = useNavigate()
  const {
    apiKey,
    baseUrl,
    model,
    utilityModel,
    globalSystemPrompt,
    tavilyApiKey,
    pexelsApiKey,
    imageProvider,
    imageProviders,
    themeMode,
    animationsEnabled,
    chatBackground,
    currencyIconMode,
    customCurrencyEmoji,
    adminModeEnabled,
    topInsetAdjustmentPx,
    automaticAiDailyCap,
    setSettings,
  } = useSettingsStore()
  const [confirmingWipe, setConfirmingWipe] = useState(false)
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

  async function handleWipeContacts() {
    await Promise.all([db.messages.clear(), db.conversations.clear(), db.contacts.clear(), db.groups.clear(), db.moments.clear(), db.momentComments.clear(), db.momentLikes.clear(), db.contactRelations.clear(), db.contactMemories.clear(), db.socialEvents.clear(), db.groupPlans.clear(), db.contactLifeStates.clear(), db.lifeEvents.clear(), db.simulationState.clear(), db.aiUsageRecords.clear(), db.aiTurns.clear(), db.adminLogs.clear(), db.adminAiTraces.clear()])
    navigate('/contacts')
  }

  async function handleExportBackup() {
    setBackupStatus('')
    const settings = { ...useSettingsStore.getState() } as Partial<AppSettings> & { setSettings?: unknown }
    delete settings.setSettings
    const backup = await createBackup(settings)
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = backupFileName()
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    setBackupStatus('备份已导出。这个文件可能包含 API Key，请自己妥善保管。')
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
      await restoreBackup(parsed)
      setSettings(parsed.settings)
      useSettingsStore.setState(parsed.settings)
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
  const [baseUrlDraft, setBaseUrlDraft] = useState(baseUrl)
  const [modelDraft, setModelDraft] = useState(model)
  const [utilityModelDraft, setUtilityModelDraft] = useState(utilityModel)
  const [promptDraft, setPromptDraft] = useState(globalSystemPrompt)
  const [tavilyKeyDraft, setTavilyKeyDraft] = useState(tavilyApiKey)
  const [pexelsKeyDraft, setPexelsKeyDraft] = useState(pexelsApiKey)
  const presetBackgrounds = ['#f4f4f6', '#f7f0e8', '#eef6f1', '#edf4ff', '#f5efff', '#fff3f0', '#f3f6e8', '#eef7f7']
  const currencyMode = currencyIconMode ?? 'coin'

  const [models, setModels] = useState<string[]>([])
  const [pulling, setPulling] = useState(false)
  const [pullError, setPullError] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [tavilyTesting, setTavilyTesting] = useState(false)
  const [tavilyTestResult, setTavilyTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [pexelsTesting, setPexelsTesting] = useState(false)
  const [pexelsTestResult, setPexelsTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  function persistConnection() {
    setSettings({ apiKey: apiKeyDraft.trim(), baseUrl: baseUrlDraft.trim(), model: modelDraft.trim() })
  }

  async function handlePullModels() {
    setPulling(true)
    setPullError('')
    try {
      const list = await listModels(apiKeyDraft.trim(), baseUrlDraft.trim())
      setModels(list)
      if (list.length > 0) {
        // Both drafts need this, not just the main one — otherwise a stale
        // model id (not in the freshly-pulled list) leaves the <select>
        // showing the browser's "no match, default to first option" display
        // while the actual stored setting silently stays on the old value.
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
    const result = await testConnection(apiKeyDraft.trim(), baseUrlDraft.trim(), modelDraft.trim())
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
      setTavilyTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setTavilyTesting(false)
    }
  }

  async function handlePexelsTest() {
    setPexelsTesting(true)
    setPexelsTestResult(null)
    setSettings({ pexelsApiKey: pexelsKeyDraft.trim() })
    try {
      const photo = await searchPexelsPhoto(pexelsKeyDraft.trim(), 'cat', 'square')
      setPexelsTestResult(
        photo ? { ok: true, message: '连接成功 已搜到示例图片' } : { ok: false, message: '连接成功但没搜到结果 可能是key本身有问题' },
      )
    } catch (err) {
      setPexelsTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setPexelsTesting(false)
    }
  }

  function restoreDefaultPrompt() {
    setPromptDraft(DEFAULT_STYLE_PROMPT)
    setSettings({ globalSystemPrompt: DEFAULT_STYLE_PROMPT })
  }

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="设置" showBack />
      <div className="flex-1 overflow-y-auto">

      <section className="mt-3 bg-white px-4 py-3">
        <h2 className="mb-2 text-xs font-medium text-gray-400">外观</h2>
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between">
            <div><p className="text-sm text-gray-800">顶部显示区域</p><p className="text-xs text-gray-400">自动避开系统安全区，并额外向下微调</p></div>
            <span className="text-xs text-gray-500">+{topInsetAdjustmentPx ?? 0}px</span>
          </div>
          <input aria-label="顶部显示区域微调" type="range" min="0" max="80" step="1" value={topInsetAdjustmentPx ?? 0} onChange={(e) => setSettings({ topInsetAdjustmentPx: Number(e.target.value) })} className="w-full accent-gray-900" />
          <button type="button" onClick={() => setSettings({ topInsetAdjustmentPx: 0 })} className="mt-1 text-xs text-gray-500">恢复默认</button>
        </div>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-800">暗色模式</p>
            <p className="mt-0.5 text-[11px] text-gray-400">适合晚上聊天，聊天页和设置页会一起变暗</p>
          </div>
          <button
            onClick={() => setSettings({ themeMode: (themeMode ?? 'light') === 'dark' ? 'light' : 'dark' })}
            aria-label="切换暗色模式"
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              (themeMode ?? 'light') === 'dark' ? 'bg-gray-900' : 'bg-gray-200'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                (themeMode ?? 'light') === 'dark' ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
        <div className="mb-3 flex items-center justify-between border-t border-gray-100 pt-3">
          <div>
            <p className="text-sm text-gray-800">界面动效</p>
            <p className="mt-0.5 text-[11px] text-gray-400">切换、提示与消息出现的轻量动画</p>
          </div>
          <button
            type="button"
            onClick={() => setSettings({ animationsEnabled: !(animationsEnabled ?? true) })}
            aria-label="切换界面动效"
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${(animationsEnabled ?? true) ? 'bg-gray-900' : 'bg-gray-200'}`}
          >
            <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${(animationsEnabled ?? true) ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
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
      {adminModeEnabled && <section className="mt-3 bg-white px-4 py-3"><h2 className="text-sm font-medium text-gray-900">设定我的余额</h2><p className="mt-1 text-xs text-gray-400">当前 {formatCurrency(wallet?.balance ?? 0, useSettingsStore.getState())}</p><div className="mt-2 flex gap-2"><input type="number" min="0" value={adminBalance} onChange={e=>setAdminBalance(e.target.value)} placeholder="目标余额" className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"/><button onClick={async()=>{const n=Number(adminBalance);if(Number.isFinite(n)&&n>=0&&confirm(`确认将余额设为 ${Math.round(n)}？`)){await setUserBalance(n);setAdminBalance('')}}} className="rounded-lg bg-gray-900 px-4 text-sm text-white">设定</button></div></section>}

      <section className="mt-3 bg-white px-4 py-3">
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

      <section className="mt-3 bg-white px-4 py-3"><h2 className="mb-2 text-xs font-medium text-gray-400">AI 调用预算</h2><p className="mb-2 text-xs text-gray-500">后台自动任务达到上限后会跳过；手动聊天和手动生成不会受限。</p>{usage && <><div className="mb-2 grid grid-cols-2 gap-2 text-xs text-gray-600"><p>今日调用 <b>{usage.today.filter((r) => r.success).length}</b></p><p>近30天 <b>{usage.recent.filter((r) => r.success).length}</b></p><p>今日估算 tokens <b>{usage.today.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0)}</b></p><p>自动调用 <b>{usage.today.filter((r) => r.automatic && r.success).length}</b></p></div><div className="mb-3 flex flex-wrap gap-1">{(['chat','proactive','memory','moments','worldbook','lifeSimulation','persona','quality','other'] as const).map((purpose) => <span key={purpose} className="rounded bg-gray-100 px-1.5 py-1 text-[10px] text-gray-500">{purpose} {usage.today.filter((r) => r.purpose === purpose && r.success).length}</span>)}</div></>}<label className="mb-1 block text-xs text-gray-500">自动任务每日调用上限（0 为不限）</label><input type="number" min="0" value={automaticAiDailyCap} onChange={(e) => setSettings({ automaticAiDailyCap: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/></section>

      <section className="mt-3 bg-white px-4 py-3">
        <h2 className="mb-2 text-xs font-medium text-gray-400">API 配置（DeepSeek）</h2>

        <label className="mb-1 block text-xs text-gray-500">API Key</label>
        <input
          value={apiKeyDraft}
          onChange={(e) => {
            setApiKeyDraft(e.target.value)
            setTestResult(null)
          }}
          onBlur={persistConnection}
          type="password"
          placeholder="sk-..."
          className="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />

        <label className="mb-1 block text-xs text-gray-500">Base URL</label>
        <input
          value={baseUrlDraft}
          onChange={(e) => {
            setBaseUrlDraft(e.target.value)
            setTestResult(null)
          }}
          onBlur={persistConnection}
          className="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />

        <label className="mb-1 block text-xs text-gray-500">模型</label>
        <div className="mb-1 flex gap-2">
          {models.length > 0 ? (
            <select
              value={modelDraft}
              onChange={(e) => {
                setModelDraft(e.target.value)
                setSettings({ model: e.target.value })
                setTestResult(null)
              }}
              className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
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
            <select
              value={utilityModelDraft}
              onChange={(e) => {
                setUtilityModelDraft(e.target.value)
                setSettings({ utilityModel: e.target.value })
              }}
              className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
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
            disabled={pulling || !apiKeyDraft}
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

      <section className="mt-3 bg-white px-4 py-3">
        <h2 className="mb-2 text-xs font-medium text-gray-400">联网搜索（Tavily，仅供知识库定时更新使用）</h2>
        <label className="mb-1 block text-xs text-gray-500">Tavily API Key</label>
        <input
          value={tavilyKeyDraft}
          onChange={(e) => {
            setTavilyKeyDraft(e.target.value)
            setTavilyTestResult(null)
          }}
          onBlur={() => setSettings({ tavilyApiKey: tavilyKeyDraft.trim() })}
          type="password"
          placeholder="tvly-..."
          className="mb-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />
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
          去 tavily.com 免费注册可以拿到一个key 只用来定时给"世界设定"页面的知识库搜索最新的网络热梗/番剧/游戏资讯 平时聊天不会用到
        </p>
      </section>

      <section className="mt-3 bg-white px-4 py-3">
        <h2 className="mb-2 text-xs font-medium text-gray-400">图片（Pexels，头像自动配图+朋友圈配图）</h2>
        <label className="mb-1 block text-xs text-gray-500">Pexels API Key</label>
        <input
          value={pexelsKeyDraft}
          onChange={(e) => {
            setPexelsKeyDraft(e.target.value)
            setPexelsTestResult(null)
          }}
          onBlur={() => setSettings({ pexelsApiKey: pexelsKeyDraft.trim() })}
          type="password"
          placeholder="Pexels API Key"
          className="mb-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />
        <button
          onClick={handlePexelsTest}
          disabled={pexelsTesting || !pexelsKeyDraft}
          className="w-full rounded-lg bg-gray-900 py-2 text-sm text-white disabled:opacity-50"
        >
          {pexelsTesting ? '测试中…' : '测试连接'}
        </button>
        {pexelsTestResult && (
          <p className={`mt-2 text-xs ${pexelsTestResult.ok ? 'text-green-600' : 'text-red-500'}`}>
            {pexelsTestResult.ok ? '✓ ' : '✗ '}
            {pexelsTestResult.message}
          </p>
        )}
        <p className="mt-2 text-[11px] text-gray-400">
          去 pexels.com/api 免费注册可以拿到一个key 用于创建联系人时自动配一张符合性格的头像照片、以及朋友圈动态偶尔配的插图 动漫风格头像走的是另一个不需要key的免费接口
        </p>
      </section>

      <section className="mt-3 bg-white">
        <button type="button" onClick={() => navigate('/settings/image-generation')} className="flex w-full items-center gap-3 px-4 py-4 text-left">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-lg">🎨</div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-gray-900">AI 图片生成</p>
            <p className={`mt-0.5 text-xs ${isImageProviderReady({ imageProvider, imageProviders }) ? 'text-green-600' : 'text-gray-400'}`}>
              {imageProviderName(imageProvider)} · {isImageProviderReady({ imageProvider, imageProviders }) ? 'AI 联系人可以调用' : '选择 Atlas、NAI、ComfyUI 等服务'}
            </p>
          </div>
          <span className="text-lg text-gray-300">›</span>
        </button>
      </section>

      <section className="mt-3 flex-1 bg-white px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-medium text-gray-400">说话风格提示词（对所有AI生效）</h2>
          <button
            onClick={restoreDefaultPrompt}
            className="text-xs text-gray-400 underline"
          >
            恢复默认
          </button>
        </div>
        <textarea
          value={promptDraft}
          onChange={(e) => setPromptDraft(e.target.value)}
          onBlur={() => setSettings({ globalSystemPrompt: promptDraft })}
          rows={14}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs leading-relaxed text-gray-700"
        />
        <p className="mt-2 text-[11px] text-gray-400">
          这里只控制所有AI共通的说话语气和习惯 每个AI各自的人物设定在联系人名片里单独编辑 消息输出格式、表情包与小程序调用规则由系统固定处理 不在这里展示
        </p>
      </section>


      <section className="mt-3 bg-white px-4 py-3">
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
          备份包含联系人、人设、聊天记录、朋友圈、表情包、仓库、知识库、世界观收藏和当前设置。设置里如果保存过 API Key，备份文件里也会带上，请不要发给别人。
        </p>
        {backupStatus && <p className="mt-2 text-xs text-gray-500">{backupStatus}</p>}
      </section>

      <section className="mt-3 bg-white px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-gray-900">管理员模式</h2>
            <p className="text-[11px] text-gray-400">开启后可使用天眼查看运行进程、真实提示词、AI 回合、记忆/事件链，并执行安全调试操作</p>
          </div>
          <button
            onClick={() => setSettings({ adminModeEnabled: !adminModeEnabled })}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors ${
              adminModeEnabled ? 'bg-[#07c160]' : 'bg-gray-200'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                adminModeEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </section>

      <section className="mt-3 bg-white px-4 py-3">
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
    </div>
  )
}
