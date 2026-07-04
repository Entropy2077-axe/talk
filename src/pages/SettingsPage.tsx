import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { ActionSheet } from '../components/ActionSheet'
import { useSettingsStore } from '../store/useSettingsStore'
import { listModels, testConnection } from '../lib/deepseek'
import { DEFAULT_STYLE_PROMPT } from '../lib/prompt'
import { db } from '../db/db'

export function SettingsPage() {
  const navigate = useNavigate()
  const { apiKey, baseUrl, model, shopModel, globalSystemPrompt, setSettings } = useSettingsStore()
  const [confirmingWipe, setConfirmingWipe] = useState(false)

  async function handleWipeContacts() {
    await db.transaction('rw', db.contacts, db.conversations, db.messages, async () => {
      await db.messages.clear()
      await db.conversations.clear()
      await db.contacts.clear()
    })
    navigate('/contacts')
  }

  const [apiKeyDraft, setApiKeyDraft] = useState(apiKey)
  const [baseUrlDraft, setBaseUrlDraft] = useState(baseUrl)
  const [modelDraft, setModelDraft] = useState(model)
  const [shopModelDraft, setShopModelDraft] = useState(shopModel)
  const [promptDraft, setPromptDraft] = useState(globalSystemPrompt)

  const [models, setModels] = useState<string[]>([])
  const [pulling, setPulling] = useState(false)
  const [pullError, setPullError] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  function persistConnection() {
    setSettings({ apiKey: apiKeyDraft.trim(), baseUrl: baseUrlDraft.trim(), model: modelDraft.trim() })
  }

  async function handlePullModels() {
    setPulling(true)
    setPullError('')
    try {
      const list = await listModels(apiKeyDraft.trim(), baseUrlDraft.trim())
      setModels(list)
      if (list.length > 0 && !list.includes(modelDraft)) setModelDraft(list[0])
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

  return (
    <div className="flex min-h-full flex-col bg-[#f4f4f6]">
      <TopBar title="设置" showBack />

      <section className="mt-3 bg-white px-4 py-3">
        <h2 className="mb-2 text-xs font-medium text-gray-400">API 配置（DeepSeek）</h2>

        <label className="mb-1 block text-xs text-gray-500">API Key</label>
        <input
          value={apiKeyDraft}
          onChange={(e) => setApiKeyDraft(e.target.value)}
          onBlur={persistConnection}
          type="password"
          placeholder="sk-..."
          className="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />

        <label className="mb-1 block text-xs text-gray-500">Base URL</label>
        <input
          value={baseUrlDraft}
          onChange={(e) => setBaseUrlDraft(e.target.value)}
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
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={persistConnection}
              className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
          )}
        </div>
        {pullError && <p className="mb-2 text-xs text-red-500">{pullError}</p>}

        <label className="mb-1 block text-xs text-gray-500">购物商城商品生成模型（独立于聊天，可以选不同的模型）</label>
        <div className="mb-1 flex gap-2">
          {models.length > 0 ? (
            <select
              value={shopModelDraft}
              onChange={(e) => {
                setShopModelDraft(e.target.value)
                setSettings({ shopModel: e.target.value })
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
              value={shopModelDraft}
              onChange={(e) => setShopModelDraft(e.target.value)}
              onBlur={() => setSettings({ shopModel: shopModelDraft.trim() })}
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

      <section className="mt-3 flex-1 bg-white px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-medium text-gray-400">说话风格提示词（对所有AI生效）</h2>
          <button
            onClick={() => setPromptDraft(DEFAULT_STYLE_PROMPT)}
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

      {confirmingWipe && (
        <ActionSheet
          onClose={() => setConfirmingWipe(false)}
          options={[{ label: '确认清空所有联系人与聊天记录', onSelect: handleWipeContacts, danger: true }]}
        />
      )}
    </div>
  )
}
