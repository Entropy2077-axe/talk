import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { AI_PROVIDERS, AI_PROVIDER_OPTIONS, type AiProviderId } from '../lib/aiProviders'
import { activeAiApiConfig, legacyFieldsForApiConfig, normalizeAiApiConfigs, savedAiApiConfigs } from '../lib/aiApiConfigs'
import { listModels, testConnection } from '../lib/deepseek'
import type { AiApiConfig } from '../types'

function clone(config: AiApiConfig): AiApiConfig { return structuredClone(config) }

export function ApiConfigurationsPage() {
  const settings = useSettingsStore()
  const configs = savedAiApiConfigs(settings)
  const active = activeAiApiConfig(settings)
  const [editingId, setEditingId] = useState(active.id ?? '')
  const [draft, setDraft] = useState<AiApiConfig>(() => clone(active))
  const [status, setStatus] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [manualModels, setManualModels] = useState({ model: false, utilityModel: false })
  const [busy, setBusy] = useState<'models' | 'test' | ''>('')
  const current = configs.find((item) => item.id === editingId) ?? configs[0]
  const hasChanges = JSON.stringify(current) !== JSON.stringify(draft)

  function select(config: AiApiConfig) {
    setEditingId(config.id); setDraft(clone(config)); setModels([]); setManualModels({ model: false, utilityModel: false }); setStatus('')
  }
  function save(next = draft, asPrimary = false) {
    const now = Date.now()
    const normalized = normalizeAiApiConfigs(settings.aiApiConfigs.map((item) => item.id === next.id ? { ...next, name: next.name.trim() || '未命名 API', updatedAt: now } : item), settings)
    const selectedId = asPrimary ? next.id : active.id
    const selected = normalized.find((item) => item.id === selectedId) ?? normalized[0]
    settings.setSettings({ aiApiConfigs: normalized, activeAiApiConfigId: selected.id, ...legacyFieldsForApiConfig(selected) })
    setDraft(clone(normalized.find((item) => item.id === next.id) ?? selected)); setStatus(asPrimary ? '已保存并使用此 API' : '已保存')
  }

  function create() {
    const now = Date.now(); const item: AiApiConfig = { id: uuid(), name: `API 配置 ${configs.length + 1}`, provider: 'custom', apiKey: '', baseUrl: '', model: '', utilityModel: '', sampling: {}, createdAt: now, updatedAt: now }
    settings.setSettings({ aiApiConfigs: [...configs, item], activeAiApiConfigId: active.id }); select(item)
  }
  function remove() {
    if (configs.length <= 1) { setStatus('至少保留一条 API 配置'); return }
    if (!window.confirm(`删除“${current.name}”？`)) return
    const next = configs.filter((item) => item.id !== current.id); const selected = next.find((item) => item.id === active.id) ?? next[0]
    settings.setSettings({ aiApiConfigs: next, activeAiApiConfigId: selected.id, ...legacyFieldsForApiConfig(selected) }); select(selected)
  }
  async function pullModels() {
    setBusy('models'); setStatus('')
    try { const loaded = await listModels(draft.apiKey, draft.baseUrl, draft.provider); setModels(loaded); setStatus(`已读取 ${loaded.length} 个模型`) }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setBusy('') }
  }
  async function test() {
    setBusy('test'); setStatus('')
    const result = await testConnection(draft.apiKey, draft.baseUrl, draft.model, draft.provider)
    setStatus(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`); setBusy('')
  }
  function modelField(field: 'model' | 'utilityModel', label: string) {
    const choices = [...new Set([draft[field], ...models].filter(Boolean))]
    return <label className="text-xs text-gray-500">{label}<select aria-label={label} value={manualModels[field] ? '__manual__' : draft[field]} onChange={(event) => { const manual = event.target.value === '__manual__'; setManualModels((value) => ({ ...value, [field]: manual })); if (!manual) setDraft({ ...draft, [field]: event.target.value }) }} className="mt-1 min-h-11 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800"><option value="">{field === 'utilityModel' ? '跟随聊天模型' : '请选择模型'}</option>{choices.map((model) => <option key={model} value={model}>{model}</option>)}<option value="__manual__">手动填写…</option></select>{manualModels[field] && <input aria-label={label + '名称'} autoFocus value={draft[field]} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} placeholder="输入模型名称" className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />}</label>
  }
  return <div className="ui-page"><TopBar title="LLM 设置" showBack /><div className="ui-page-scroll space-y-3">
    <section className="ui-section-card px-4 py-4"><div className="flex items-center justify-between"><div><h1 className="text-base font-semibold text-gray-900">API 配置集</h1><p className="mt-1 text-[11px] text-gray-400">只使用当前选中的 API，切换由你决定。</p></div><button type="button" onClick={create} className="rounded-lg bg-gray-900 px-3 py-2 text-xs text-white">新增</button></div><label className="mt-3 block text-xs text-gray-500">当前 API<select aria-label="当前 API" value={active.id} onChange={(event) => { const chosen = configs.find((item) => item.id === event.target.value); if (chosen) { settings.setSettings({ activeAiApiConfigId: chosen.id, ...legacyFieldsForApiConfig(chosen) }); select(chosen) } }} className="mt-1 min-h-11 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">{configs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="mt-3 space-y-2">{configs.map((item) => <button key={item.id} type="button" onClick={() => select(item)} className={`flex w-full items-center gap-2 rounded-xl border p-3 text-left ${item.id === editingId ? 'border-gray-900' : 'border-gray-200'}`}><span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">{item.id === active.id ? '使用中' : '已保存'}</span><span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">{item.name}</span><span className="text-xs text-gray-400">{AI_PROVIDERS[item.provider].label}</span></button>)}</div></section>
    <section className="ui-section-card px-4 py-4"><div className="mb-3"><h2 className="text-sm font-medium text-gray-900">编辑：{current.name}</h2><p className="mt-1 text-[11px] text-gray-400">修改后保存即可生效。</p></div>
      <label className="block text-xs text-gray-500">配置名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800" /></label>
      <label className="mt-3 block text-xs text-gray-500">供应商<select value={draft.provider} onChange={(event) => { const provider = event.target.value as AiProviderId; setDraft({ ...draft, provider, baseUrl: provider === 'custom' ? draft.baseUrl : AI_PROVIDERS[provider].defaultBaseUrl }) }} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800">{AI_PROVIDER_OPTIONS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
      <label className="mt-3 block text-xs text-gray-500">API Key<input type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800" /></label>
      <label className="mt-3 block text-xs text-gray-500">Base URL<input value={draft.baseUrl} readOnly={draft.provider !== 'custom'} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 read-only:bg-gray-100" /></label>
      <div className="mt-3 grid grid-cols-2 gap-2">{modelField('model', '聊天模型')}{modelField('utilityModel', '多功能模型')}</div>
      <div className="mt-3 grid grid-cols-3 gap-2"><label className="text-xs text-gray-500">Temperature<input type="number" min="0" max="2" step="0.01" value={draft.sampling?.temperature ?? ''} onChange={(event) => setDraft({ ...draft, sampling: { ...draft.sampling, temperature: event.target.value === '' ? undefined : Number(event.target.value) } })} placeholder="默认" className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-sm" /></label><label className="text-xs text-gray-500">Top P<input type="number" min="0" max="1" step="0.01" value={draft.sampling?.topP ?? ''} onChange={(event) => setDraft({ ...draft, sampling: { ...draft.sampling, topP: event.target.value === '' ? undefined : Number(event.target.value) } })} placeholder="默认" className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-sm" /></label><label className="text-xs text-gray-500">Top K<input type="number" min="1" step="1" value={draft.sampling?.topK ?? ''} onChange={(event) => setDraft({ ...draft, sampling: { ...draft.sampling, topK: event.target.value === '' ? undefined : Number(event.target.value) } })} placeholder="默认" className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-sm" /></label></div>
      <div className="mt-4 grid grid-cols-3 gap-2"><button type="button" onClick={pullModels} disabled={busy === 'models' || !draft.apiKey} className="rounded-lg bg-gray-100 py-2 text-xs text-gray-700 disabled:opacity-50">{busy === 'models' ? '拉取中…' : '拉取模型'}</button><button type="button" onClick={test} disabled={busy === 'test' || !draft.apiKey || !draft.model} className="rounded-lg bg-gray-100 py-2 text-xs text-gray-700 disabled:opacity-50">{busy === 'test' ? '测试中…' : '测试连接'}</button><button type="button" onClick={() => save()} disabled={!hasChanges} className="rounded-lg bg-gray-900 py-2 text-xs text-white disabled:opacity-50">保存配置</button></div>{active.id !== current.id && <button type="button" onClick={() => save(draft, true)} className="mt-3 w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white">保存并使用此 API</button>}<div className="mt-5 border-t border-gray-100 pt-4"><p className="text-xs text-red-500">危险操作</p><button type="button" onClick={remove} className="mt-2 w-full rounded-lg bg-red-50 py-2.5 text-sm text-red-500">删除此 API 配置</button></div>{status && <p className="mt-2 text-xs text-gray-500">{status}</p>}
    </section>
  </div></div>
}
