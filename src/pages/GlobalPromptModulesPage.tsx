import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { TopBar } from '../components/TopBar'
import { ToggleSwitch } from '../components/ToggleSwitch'
import { db } from '../db/db'
import { PROMPT_MODULE_DEFINITIONS, unknownPromptPlaceholders } from '../lib/promptModules'
import { clonePromptModules, normalizePromptPresets, SYSTEM_DEFAULT_PROMPT_PRESET_ID } from '../lib/promptPresets'
import { displayName } from '../lib/contact'
import { useSettingsStore } from '../store/useSettingsStore'
import type { PromptModuleId, PromptModuleSettings, PromptPreset, SamplingParameters } from '../types'

export function GlobalPromptModulesPage() {
  const settings = useSettingsStore()
  const presets = normalizePromptPresets(settings.promptPresets, settings.promptModules)
  const contacts = useLiveQuery(() => db.contacts.orderBy('createdAt').toArray(), []) ?? []
  const [selectedId, setSelectedId] = useState(settings.activePromptPresetId || SYSTEM_DEFAULT_PROMPT_PRESET_ID)
  const selected = presets.find((preset) => preset.id === selectedId) ?? presets[0]
  const [draft, setDraft] = useState<PromptModuleSettings>(() => clonePromptModules(selected.modules))
  const [samplingDraft, setSamplingDraft] = useState<SamplingParameters>(() => ({ ...selected.sampling }))
  const [editing, setEditing] = useState<{ moduleId: PromptModuleId; templateId: string } | null>(null)
  const [validationError, setValidationError] = useState('')
  const [applyingPreset, setApplyingPreset] = useState<PromptPreset | null>(null)
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([])
  const visibleDefinitions = useMemo(() => PROMPT_MODULE_DEFINITIONS, [])

  function loadPreset(preset: PromptPreset) {
    setSelectedId(preset.id)
    setDraft(clonePromptModules(preset.modules))
    setSamplingDraft({ ...preset.sampling })
    setEditing(null)
    setValidationError('')
  }

  function validateModules(modules: PromptModuleSettings): string {
    for (const definition of visibleDefinitions) {
      for (const template of definition.templates) {
        const unknown = unknownPromptPlaceholders(definition.id, template.id, modules[definition.id]?.templates?.[template.id] ?? '')
        if (unknown.length) return `${definition.name}／${template.name}含未知占位符：${unknown.map((key) => `{{${key}}}`).join('、')}`
      }
    }
    return ''
  }

  function saveArchive() {
    const error = validateModules(draft)
    if (error) { setValidationError(error); return }
    const name = window.prompt('给这份提示词存档命名')?.trim()
    if (!name) return
    const now = Date.now()
    const preset: PromptPreset = { id: uuid(), name, modules: clonePromptModules(draft), sampling: { ...samplingDraft }, createdAt: now, updatedAt: now }
    settings.setSettings({ promptPresets: [...presets, preset] })
    setSelectedId(preset.id)
    setValidationError('')
  }

  function makeDefault(preset: PromptPreset) {
    const modules = clonePromptModules(preset.modules)
    settings.setSettings({
      activePromptPresetId: preset.id,
      promptModules: modules,
      globalSystemPrompt: modules.chat?.templates?.style ?? settings.globalSystemPrompt,
    })
  }

  function deletePreset(preset: PromptPreset) {
    if (preset.systemDefault || preset.id === SYSTEM_DEFAULT_PROMPT_PRESET_ID) return
    if (!window.confirm(`删除提示词存档“${preset.name}”？已经复制给联系人的提示词不会受影响。`)) return
    const next = presets.filter((item) => item.id !== preset.id)
    const patch: Partial<typeof settings> = { promptPresets: next }
    if (settings.activePromptPresetId === preset.id) {
      const fallback = next.find((item) => item.id === SYSTEM_DEFAULT_PROMPT_PRESET_ID) ?? next[0]
      patch.activePromptPresetId = fallback.id
      patch.promptModules = clonePromptModules(fallback.modules)
      patch.globalSystemPrompt = fallback.modules.chat?.templates?.style ?? settings.globalSystemPrompt
    }
    settings.setSettings(patch)
    if (selectedId === preset.id) loadPreset(next[0])
  }

  async function applyToContacts() {
    if (!applyingPreset || selectedContactIds.length === 0) return
    if (!window.confirm(`用“${applyingPreset.name}”覆盖 ${selectedContactIds.length} 个联系人的固定提示词？联系人现有的单独修改会被替换。`)) return
    const now = Date.now()
    await db.transaction('rw', db.contacts, async () => {
      for (const contactId of selectedContactIds) await db.contacts.update(contactId, {
        promptModulesSnapshot: clonePromptModules(applyingPreset.modules),
        promptPresetSourceId: applyingPreset.id,
        promptPresetSourceName: applyingPreset.name,
        promptSnapshotUpdatedAt: now,
      })
    })
    setApplyingPreset(null)
    setSelectedContactIds([])
  }

  return <div className="ui-page relative">
    <TopBar title="预设" showBack />
    <div className="ui-page-scroll">
      <header className="ui-page-intro"><p className="ui-page-kicker">当前预设</p><h1 className="ui-page-title">{selected.name}</h1><p className="ui-page-summary">先选择或保存一套提示词预设，再决定是否覆盖到具体联系人。</p></header>
      <section className="ui-section-card px-4 py-4">
        <h2 className="text-sm font-medium text-gray-900">生成参数</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-gray-400">这些值会覆盖应用内各功能原有的温度默认值；留空则保持原有行为。Top P / Top K 仅在填写后发送给接口。</p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <label className="text-xs text-gray-500">Temperature<input aria-label="Temperature" type="number" min="0" max="2" step="0.01" value={samplingDraft.temperature ?? ''} onChange={(event) => setSamplingDraft((current) => ({ ...current, ...(event.target.value === '' ? { temperature: undefined } : { temperature: Number(event.target.value) }) }))} placeholder="默认" className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-sm text-gray-800" /></label>
          <label className="text-xs text-gray-500">Top P<input aria-label="Top P" type="number" min="0" max="1" step="0.01" value={samplingDraft.topP ?? ''} onChange={(event) => setSamplingDraft((current) => ({ ...current, ...(event.target.value === '' ? { topP: undefined } : { topP: Number(event.target.value) }) }))} placeholder="默认" className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-sm text-gray-800" /></label>
          <label className="text-xs text-gray-500">Top K<input aria-label="Top K" type="number" min="1" step="1" value={samplingDraft.topK ?? ''} onChange={(event) => setSamplingDraft((current) => ({ ...current, ...(event.target.value === '' ? { topK: undefined } : { topK: Number(event.target.value) }) }))} placeholder="默认" className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-sm text-gray-800" /></label>
        </div>
      </section>
      <section className="ui-section-card ui-section-spaced px-4 py-4">
        <button type="button" onClick={saveArchive} className="w-full rounded-xl bg-gray-900 py-3 text-sm font-medium text-white">保存为新预设</button>
        <p className="mt-2 text-[11px] leading-relaxed text-gray-400">预设会同时保存生成参数和全局提示词模块。启用后，生成参数立即生效；新联系人会复制当前预设的提示词模块快照。</p>
        {validationError && <p className="mt-2 text-xs text-red-500">{validationError}</p>}
      </section>

      <section className="ui-section-card ui-section-spaced px-4 py-4">
        <h2 className="mb-3 text-xs font-medium text-gray-400">已保存的提示词</h2>
        <div className="space-y-2">{presets.map((preset) => <div key={preset.id} className={`rounded-xl border px-3 py-3 ${selectedId === preset.id ? 'border-gray-900' : 'border-gray-200'}`}>
          <button type="button" onClick={() => loadPreset(preset)} className="w-full text-left">
            <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">{preset.name}</span>{preset.systemDefault && <span className="text-[10px] text-gray-400">系统默认</span>}{settings.activePromptPresetId === preset.id && <span className="rounded-full bg-gray-900 px-2 py-0.5 text-[10px] text-white">当前默认</span>}</div>
          </button>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <button type="button" onClick={() => makeDefault(preset)} className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-gray-600">启用此预设</button>
            <button type="button" onClick={() => { setApplyingPreset(preset); setSelectedContactIds([]) }} className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-gray-600">应用到联系人</button>
            {!preset.systemDefault && <button type="button" onClick={() => deletePreset(preset)} className="ml-auto rounded-lg px-2.5 py-1.5 text-red-500">删除</button>}
          </div>
        </div>)}</div>
      </section>

      <section className="ui-section-card ui-section-spaced px-4 py-4">
        <div className="mb-3"><h2 className="text-sm font-medium text-gray-900">全局提示词设置 · 正在编辑：{selected.name}</h2><p className="mt-1 text-[11px] text-gray-400">编辑后点击顶部“保存为新预设”创建新存档；系统默认预设本身不会被覆盖。</p></div>
        <div className="space-y-3">{visibleDefinitions.map((definition) => {
          const config = draft[definition.id]
          if (!config) return null
          return <div key={definition.id} className="rounded-xl border border-gray-200 p-3">
            <div className="flex items-center gap-3"><div className="min-w-0 flex-1"><p className="text-sm font-medium text-gray-900">{definition.name}</p><p className="text-[10px] text-gray-400">{definition.description}</p></div><ToggleSwitch checked={config.enabled} onChange={(enabled) => setDraft((current) => ({ ...current, [definition.id]: { ...current[definition.id], enabled } }))} ariaLabel={`切换${definition.name}`} /></div>
            <div className="mt-2 space-y-2">{definition.templates.map((template) => {
              const open = editing?.moduleId === definition.id && editing.templateId === template.id
              return <div key={template.id} className="rounded-lg bg-gray-50 px-3 py-2">
                <button type="button" onClick={() => setEditing(open ? null : { moduleId: definition.id, templateId: template.id })} className="flex w-full items-center justify-between text-left"><span className="text-xs font-medium text-gray-700">{template.name}</span><span className="text-xs text-gray-400">{open ? '收起' : '编辑'}</span></button>
                {open && <><textarea value={config.templates[template.id] ?? ''} onChange={(event) => setDraft((current) => ({ ...current, [definition.id]: { ...current[definition.id], templates: { ...current[definition.id].templates, [template.id]: event.target.value } } }))} rows={10} className="mt-2 w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed" /><p className="mt-1 text-[10px] text-gray-400">可用动态占位符：{template.placeholders.length ? template.placeholders.map((key) => `{{${key}}}`).join('、') : '无'}</p></>}
              </div>
            })}</div>
          </div>
        })}</div>
      </section>
    </div>

    {applyingPreset && <div className="absolute inset-0 z-50 flex items-end bg-black/40" onClick={() => setApplyingPreset(null)}><div className="max-h-[80%] w-full overflow-y-auto rounded-t-2xl bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]" onClick={(event) => event.stopPropagation()}><h3 className="text-base font-medium text-gray-900">应用“{applyingPreset.name}”</h3><p className="mt-1 text-xs text-gray-400">只覆盖选中联系人的固定提示词快照。</p><div className="mt-3 space-y-1">{contacts.map((contact) => <label key={contact.id} className="flex items-center gap-3 rounded-lg px-2 py-2 active:bg-gray-50"><input type="checkbox" checked={selectedContactIds.includes(contact.id)} onChange={(event) => setSelectedContactIds((ids) => event.target.checked ? [...ids, contact.id] : ids.filter((id) => id !== contact.id))} /><span className="min-w-0 flex-1 truncate text-sm text-gray-800">{displayName(contact)}</span><span className="truncate text-[10px] text-gray-400">{contact.promptPresetSourceName || '旧版默认'}</span></label>)}</div><div className="mt-4 flex gap-2"><button type="button" onClick={() => setApplyingPreset(null)} className="flex-1 rounded-xl bg-gray-100 py-2.5 text-sm text-gray-600">取消</button><button type="button" onClick={() => void applyToContacts()} disabled={!selectedContactIds.length} className="flex-1 rounded-xl bg-gray-900 py-2.5 text-sm text-white disabled:opacity-40">确认覆盖</button></div></div></div>}
  </div>
}
