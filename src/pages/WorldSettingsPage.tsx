import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { chatCompletion } from '../lib/deepseek'
import { buildWorldviewDraftPrompt, parseWorldviewDraft } from '../lib/prompt'
import type { WorldbookEntry } from '../types'
import { promptModuleEnabled } from '../lib/promptModules'

const blank = (): WorldbookEntry => ({ id: uuid(), title: '', content: '', keywords: [], enabled: true, alwaysInclude: false, priority: 50, createdAt: Date.now(), updatedAt: Date.now() })

export function WorldSettingsPage() {
  const settings = useSettingsStore()
  const entries = useLiveQuery(() => db.worldbookEntries.orderBy('priority').reverse().toArray(), []) ?? []
  const [editing, setEditing] = useState<WorldbookEntry | null>(null)
  const [keywords, setKeywords] = useState('')
  const [idea, setIdea] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function open(entry = blank()) { setEditing({ ...entry }); setKeywords(entry.keywords.join('、')); setError('') }
  async function save() {
    if (!editing?.title.trim() || !editing.content.trim()) return setError('标题和正文不能为空')
    await db.worldbookEntries.put({ ...editing, title: editing.title.trim(), content: editing.content.trim(), keywords: keywords.split(/[、,，\s]+/).map((x) => x.trim()).filter(Boolean), priority: Math.max(0, Math.min(100, editing.priority)), updatedAt: Date.now() })
    setEditing(null)
  }
  async function generate() {
    if (!idea.trim() || !settings.apiKey) return setError(settings.apiKey ? '请输入世界设定想法' : '请先在设置中配置 API Key')
    setBusy(true); setError('')
    try {
      if (!promptModuleEnabled(settings, 'worldview')) throw new Error('世界书提示词模块已屏蔽')
      const raw = await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel, messages: [{ role: 'system', content: buildWorldviewDraftPrompt(idea.trim(), '', settings.promptModules) }, { role: 'user', content: '请生成' }], jsonMode: true, purpose: 'worldbook' })
      const parsed = parseWorldviewDraft(raw)
      if (!parsed) throw new Error('生成结果解析失败')
      const entry = blank(); entry.title = idea.trim().slice(0, 20); entry.content = parsed.worldview
      open(entry)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
    <TopBar title="世界书" showBack />
    <div className="flex-1 overflow-y-auto px-4 pb-6">
      <section className="mt-3 rounded-xl bg-white p-4"><p className="text-sm font-medium">按需注入的世界设定</p><p className="mt-1 text-xs text-gray-400">常驻条目始终生效，其他条目按标题、关键词和对话内容匹配，避免把整本世界书每轮都发给 AI。</p><div className="mt-3 flex gap-2"><button onClick={() => open()} className="flex-1 rounded-lg bg-gray-900 py-2 text-sm text-white">新增条目</button><button onClick={() => void generate()} disabled={busy} className="flex-1 rounded-lg bg-gray-100 py-2 text-sm text-gray-700">{busy ? '生成中…' : 'AI 帮写'}</button></div><input value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="AI 帮写的世界设定想法" className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />{error && <p className="mt-2 text-xs text-red-500">{error}</p>}</section>
      <div className="mt-3 space-y-2">{entries.map((entry) => <article key={entry.id} className="rounded-xl bg-white p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-medium text-gray-900">{entry.title}</p><p className="mt-1 line-clamp-3 text-sm text-gray-500">{entry.content}</p><p className="mt-2 text-xs text-gray-400">{entry.alwaysInclude ? '常驻 · ' : ''}优先级 {entry.priority}{entry.keywords.length ? ` · ${entry.keywords.join('、')}` : ''}</p></div><button onClick={() => db.worldbookEntries.update(entry.id, { enabled: !entry.enabled, updatedAt: Date.now() })} className={`rounded-full px-2 py-1 text-xs ${entry.enabled ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-400'}`}>{entry.enabled ? '启用' : '停用'}</button></div><div className="mt-3 flex gap-3 text-xs"><button onClick={() => open(entry)} className="text-blue-600">编辑</button><button onClick={() => db.worldbookEntries.update(entry.id, { alwaysInclude: !entry.alwaysInclude, updatedAt: Date.now() })} className="text-gray-600">{entry.alwaysInclude ? '取消常驻' : '设为常驻'}</button><button onClick={() => db.worldbookEntries.delete(entry.id)} className="text-red-500">删除</button></div></article>)}</div>
    </div>
    {editing && <div className="absolute inset-0 z-30 flex items-center bg-black/30 p-5"><div className="max-h-[90%] w-full overflow-y-auto rounded-2xl bg-white p-4"><h2 className="mb-3 font-medium">编辑世界书条目</h2><input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="标题" className="mb-2 w-full rounded-lg border p-2 text-sm"/><textarea value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} rows={8} placeholder="正文" className="mb-2 w-full rounded-lg border p-2 text-sm"/><input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="关键词，用逗号或顿号分隔" className="mb-3 w-full rounded-lg border p-2 text-sm"/><label className="text-xs text-gray-500">优先级 {editing.priority}</label><input type="range" min="0" max="100" value={editing.priority} onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) })} className="mb-3 w-full"/><label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.alwaysInclude} onChange={(e) => setEditing({ ...editing, alwaysInclude: e.target.checked })}/>始终注入</label>{error && <p className="mb-2 text-xs text-red-500">{error}</p>}<div className="flex gap-2"><button onClick={() => setEditing(null)} className="flex-1 rounded-lg bg-gray-100 py-2">取消</button><button onClick={() => void save()} className="flex-1 rounded-lg bg-gray-900 py-2 text-white">保存</button></div></div></div>}
  </div>
}
