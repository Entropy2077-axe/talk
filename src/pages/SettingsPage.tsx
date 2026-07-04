import { useState } from 'react'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { listModels, testConnection } from '../lib/deepseek'
import { DEFAULT_GLOBAL_SYSTEM_PROMPT } from '../lib/prompt'

export function SettingsPage() {
  const { apiKey, baseUrl, model, globalSystemPrompt, setSettings } = useSettingsStore()

  const [apiKeyDraft, setApiKeyDraft] = useState(apiKey)
  const [baseUrlDraft, setBaseUrlDraft] = useState(baseUrl)
  const [modelDraft, setModelDraft] = useState(model)
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
          <h2 className="text-xs font-medium text-gray-400">统一系统提示词（对所有AI生效）</h2>
          <button
            onClick={() => setPromptDraft(DEFAULT_GLOBAL_SYSTEM_PROMPT)}
            className="text-xs text-gray-400 underline"
          >
            恢复默认
          </button>
        </div>
        <textarea
          value={promptDraft}
          onChange={(e) => setPromptDraft(e.target.value)}
          onBlur={() => setSettings({ globalSystemPrompt: promptDraft })}
          rows={16}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs leading-relaxed text-gray-700"
        />
        <p className="mt-2 text-[11px] text-gray-400">
          提示词中的 {'{{STICKERS}}'}、{'{{LINKS}}'}、{'{{PERSONA}}'} 会在发送请求时自动替换为表情包列表、可用小程序、以及每个AI各自的人物设定
        </p>
      </section>
    </div>
  )
}
