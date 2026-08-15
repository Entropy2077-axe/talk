import { useMemo, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { TopBar } from '../components/TopBar'
import { ModelPicker } from '../components/ModelPicker'
import { useSettingsStore } from '../store/useSettingsStore'
import { AI_PROVIDERS, AI_PROVIDER_OPTIONS, type AiProviderId } from '../lib/aiProviders'
import { legacyFieldsForApiConfig, normalizeAiApiConfigs, orderedAiApiConfigs } from '../lib/aiApiConfigs'
import { listModels, testConnection } from '../lib/deepseek'
import type { AiApiConfig } from '../types'

function clone(config: AiApiConfig): AiApiConfig { return structuredClone(config) }

export function ApiConfigurationsPage() {
  const settings = useSettingsStore()
  const configs = orderedAiApiConfigs(settings)
  const [editingId, setEditingId] = useState(configs[0]?.id ?? '')
  const [draft, setDraft] = useState<AiApiConfig>(() => clone(configs[0]))
  const [status, setStatus] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [picker, setPicker] = useState<'model' | 'utility' | null>(null)
  const [busy, setBusy] = useState<'models' | 'test' | ''>('')
  const current = configs.find((item) => item.id === editingId) ?? configs[0]
  const hasChanges = JSON.stringify(current) !== JSON.stringify(draft)

  function select(config: AiApiConfig) {
    setEditingId(config.id); setDraft(clone(config)); setModels([]); setStatus('')
  }
  function save(next = draft, asPrimary = false) {
    const now = Date.now()
    const normalized = normalizeAiApiConfigs(settings.aiApiConfigs.map((item) => item.id === next.id ? { ...next, name: next.name.trim() || '未命名 API', updatedAt: now } : item), settings)
    const existingOrder = settings.aiApiFailoverOrder.filter((id) => normalized.some((item) => item.id === id))
    const order = asPrimary ? [next.id, ...existingOrder.filter((id) => id !== next.id)] : existingOrder
    const completeOrder = [...order, ...normalized.map((item) => item.id).filter((id) => !order.includes(id))]
    const primary = normalized.find((item) => item.id === completeOrder[0]) ?? normalized[0]
    settings.setSettings({ aiApiConfigs: normalized, aiApiFailoverOrder: completeOrder, ...legacyFieldsForApiConfig(primary) })
    setDraft(clone(normalized.find((item) => item.id === next.id) ?? primary)); setStatus(asPrimary ? '已保存并设为主 API' : '已保存')
  }
  function create() {
    const now = Date.now(); const item: AiApiConfig = { id: uuid(), name: `API 配置 ${configs.length + 1}`, provider: 'custom', apiKey: '', baseUrl: '', model: '', utilityModel: '', sampling: {}, createdAt: now, updatedAt: now }
    settings.setSettings({ aiApiConfigs: [...configs, item], aiApiFailoverOrder: [...configs.map((config) => config.id), item.id] }); select(item)
  }
  function remove() {
    if (configs.length <= 1) { setStatus('至少保留一条 API 配置'); return }
    if (!window.confirm(`删除“${current.name}”？`)) return
    const next = configs.filter((item) => item.id !== current.id); const order = next.map((item) => item.id)
    settings.setSettings({ aiApiConfigs: next, aiApiFailoverOrder: order, ...legacyFieldsForApiConfig(next[0]) }); select(next[0])
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
  const orderingHint = useMemo(() => configs.map((item, index) => `${index === 0 ? '主' : `备${index}`}：${item.name}`).join(' → '), [configs])
  return <div className="ui-page"><TopBar title="API 配置" showBack /><div className="ui-page-scroll space-y-3">
    <section className="ui-section-card px-4 py-4"><div className="flex items-center justify-between"><div><h1 className="text-base font-semibold text-gray-900">API 配置集</h1><p className="mt-1 text-[11px] text-gray-400">按顺序自动尝试网络失败、超时、429 或 5xx 的备用接口。</p></div><button type="button" onClick={create} className="rounded-lg bg-gray-900 px-3 py-2 text-xs text-white">新增</button></div><p className="mt-3 text-[11px] text-gray-500">{orderingHint}</p><div className="mt-3 space-y-2">{configs.map((item, index) => <button key={item.id} type="button" onClick={() => select(item)} className={`flex w-full items-center gap-2 rounded-xl border p-3 text-left ${item.id === editingId ? 'border-gray-900' : 'border-gray-200'}`}><span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">{index === 0 ? '主 API' : `备用 ${index}`}</span><span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">{item.name}</span><span className="text-xs text-gray-400">{AI_PROVIDERS[item.provider].label}</span></button>)}</div></section>
    <section className="ui-section-card px-4 py-4"><div className="mb-3"><h2 className="text-sm font-medium text-gray-900">编辑：{current.name}</h2><p className="mt-1 text-[11px] text-gray-400">修改后先保存；主 API 与删除操作在本页底部。</p></div>
      <label className="block text-xs text-gray-500">配置名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800" /></label>
      <label className="mt-3 block text-xs text-gray-500">供应商<select value={draft.provider} onChange={(event) => { const provider = event.target.value as AiProviderId; setDraft({ ...draft, provider, baseUrl: provider === 'custom' ? draft.baseUrl : AI_PROVIDERS[provider].defaultBaseUrl }) }} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800">{AI_PROVIDER_OPTIONS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
      <label className="mt-3 block text-xs text-gray-500">API Key<input type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800" /></label>
      <label className="mt-3 block text-xs text-gray-500">Base URL<input value={draft.baseUrl} readOnly={draft.provider !== 'custom'} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 read-only:bg-gray-100" /></label>
      <div className="mt-3 grid grid-cols-2 gap-2"><label className="text-xs text-gray-500">聊天模型<div className="mt-1 flex gap-1"><input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm" /><button type="button" disabled={!models.length} onClick={() => setPicker('model')} className="rounded-lg bg-gray-100 px-2 text-xs disabled:opacity-40">选</button></div></label><label className="text-xs text-gray-500">多功能模型<div className="mt-1 flex gap-1"><input value={draft.utilityModel} onChange={(event) => setDraft({ ...draft, utilityModel: event.target.value })} className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm" /><button type="button" disabled={!models.length} onClick={() => setPicker('utility')} className="rounded-lg bg-gray-100 px-2 text-xs disabled:opacity-40">选</button></div></label></div>
      <div className="mt-3 grid grid-cols-3 gap-2"><label className="text-xs text-gray-500">Temperature<input type="number" min="0" max="2" step="0.01" value={draft.sampling?.temperature ?? ''} onChange={(event) => setDraft({ ...draft, sampling: { ...draft.sampling, temperature: event.target.value === '' ? undefined : Number(event.target.value) } })} placeholder="默认" className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-sm" /></label><label className="text-xs text-gray-500">Top P<input type="number" min="0" max="1" step="0.01" value={draft.sampling?.topP ?? ''} onChange={(event) => setDraft({ ...draft, sampling: { ...draft.sampling, topP: event.target.value === '' ? undefined : Number(event.target.value) } })} placeholder="默认" className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-sm" /></label><label className="text-xs text-gray-500">Top K<input type="number" min="1" step="1" value={draft.sampling?.topK ?? ''} onChange={(event) => setDraft({ ...draft, sampling: { ...draft.sampling, topK: event.target.value === '' ? undefined : Number(event.target.value) } })} placeholder="默认" className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-sm" /></label></div>
      <div className="mt-4 grid grid-cols-3 gap-2"><button type="button" onClick={pullModels} disabled={busy === 'models' || !draft.apiKey} className="rounded-lg bg-gray-100 py-2 text-xs text-gray-700 disabled:opacity-50">{busy === 'models' ? '拉取中…' : '拉取模型'}</button><button type="button" onClick={test} disabled={busy === 'test' || !draft.apiKey || !draft.model} className="rounded-lg bg-gray-100 py-2 text-xs text-gray-700 disabled:opacity-50">{busy === 'test' ? '测试中…' : '测试连接'}</button><button type="button" onClick={() => save()} disabled={!hasChanges} className="rounded-lg bg-gray-900 py-2 text-xs text-white disabled:opacity-50">保存配置</button></div>{configs[0]?.id !== current.id && <button type="button" onClick={() => save(draft, true)} className="mt-3 w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white">保存并设为主 API</button>}<div className="mt-5 border-t border-gray-100 pt-4"><p className="text-xs text-red-500">危险操作</p><button type="button" onClick={remove} className="mt-2 w-full rounded-lg bg-red-50 py-2.5 text-sm text-red-500">删除此 API 配置</button></div>{status && <p className="mt-2 text-xs text-gray-500">{status}</p>}
    </section>
  </div>{picker && <ModelPicker title="选择模型" models={models} value={picker === 'model' ? draft.model : draft.utilityModel} onClose={() => setPicker(null)} onSelect={(selected) => setDraft((currentDraft) => picker === 'model' ? { ...currentDraft, model: selected } : { ...currentDraft, utilityModel: selected })} />}</div>
}
