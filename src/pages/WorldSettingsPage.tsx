import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { chatCompletion } from '../lib/deepseek'
import { buildWorldviewDraftPrompt, parseWorldviewDraft } from '../lib/prompt'
import { formatListTime } from '../lib/time'

type WorldviewTab = 'self' | 'ai'

export function WorldSettingsPage() {
  const settings = useSettingsStore()

  const [tab, setTab] = useState<WorldviewTab>('self')
  const [selfText, setSelfText] = useState(settings.worldview)
  const [idea, setIdea] = useState('')
  const [draft, setDraft] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [savingName, setSavingName] = useState<{ content: string } | null>(null)
  const [nameDraft, setNameDraft] = useState('')

  const savedWorldviews = useLiveQuery(() => db.savedWorldviews.orderBy('createdAt').reverse().toArray(), []) ?? []

  async function handleGenerateDraft() {
    if (!idea.trim()) return
    if (!settings.apiKey) {
      setError('还没有配置API Key 请先去"我-设置"里填写')
      return
    }
    setGenerating(true)
    setError('')
    try {
      const raw = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        messages: [
          { role: 'system', content: buildWorldviewDraftPrompt(idea.trim(), settings.worldview) },
          { role: 'user', content: '请生成' },
        ],
        jsonMode: true,
      })
      const parsed = parseWorldviewDraft(raw)
      if (!parsed) throw new Error('生成结果解析失败 请重试一次')
      setDraft(parsed.worldview)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  function applyWorldview(content: string) {
    settings.setSettings({ worldview: content })
  }

  async function handleSaveToLibrary() {
    if (!savingName || !nameDraft.trim()) return
    await db.savedWorldviews.add({
      id: uuid(),
      name: nameDraft.trim(),
      content: savingName.content,
      createdAt: Date.now(),
    })
    setSavingName(null)
    setNameDraft('')
  }

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="世界书" showBack />
      <div className="flex-1 overflow-y-auto">

      <section className="mt-3 bg-white px-4 py-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-medium text-gray-400">当前生效的世界观（会影响所有联系人的言行）</h2>
          {settings.worldview && (
            <button
              onClick={() => {
                setSavingName({ content: settings.worldview })
                setNameDraft('')
              }}
              className="shrink-0 pl-2 text-xs text-[#aa3bff]"
            >
              收藏
            </button>
          )}
        </div>
        {settings.worldview ? (
          <p className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm leading-relaxed text-gray-700">
            {settings.worldview}
          </p>
        ) : (
          <p className="text-sm text-gray-400">还没有设定世界观</p>
        )}
      </section>

      <section className="mt-3 bg-white px-4 py-4">
        <div className="mb-3 flex rounded-lg bg-gray-100 p-0.5 text-sm">
          <button
            onClick={() => setTab('self')}
            className={`flex-1 rounded-md py-1.5 ${tab === 'self' ? 'bg-white font-medium text-gray-900 shadow-sm' : 'text-gray-500'}`}
          >
            自己写
          </button>
          <button
            onClick={() => setTab('ai')}
            className={`flex-1 rounded-md py-1.5 ${tab === 'ai' ? 'bg-white font-medium text-gray-900 shadow-sm' : 'text-gray-500'}`}
          >
            让AI帮写
          </button>
        </div>

        {tab === 'self' ? (
          <div>
            <textarea
              value={selfText}
              onChange={(e) => setSelfText(e.target.value)}
              placeholder="直接写下你想要的世界设定…"
              rows={8}
              className="mb-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm leading-relaxed"
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setSavingName({ content: selfText })
                  setNameDraft('')
                }}
                disabled={!selfText.trim()}
                className="flex-1 rounded-lg bg-gray-100 py-2 text-sm text-gray-600 disabled:opacity-50"
              >
                保存到收藏夹
              </button>
              <button
                onClick={() => applyWorldview(selfText.trim())}
                disabled={!selfText.trim()}
                className="flex-1 rounded-lg bg-gray-900 py-2 text-sm text-white disabled:opacity-50"
              >
                保存并应用
              </button>
            </div>
          </div>
        ) : (
          <div>
            <label className="mb-1 block text-xs text-gray-500">你的想法</label>
            <textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder="比如：这个世界其实人人都有一种小超能力…"
              rows={3}
              className="mb-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
            <button
              onClick={handleGenerateDraft}
              disabled={!idea.trim() || generating}
              className="w-full rounded-lg bg-gray-100 py-2 text-sm text-gray-700 disabled:opacity-50"
            >
              {generating ? '生成中…' : '让AI帮你完善'}
            </button>
            {error && <p className="mt-2 text-xs text-red-500">{error}</p>}

            {draft && (
              <div className="mt-3 rounded-lg border border-gray-200 p-3">
                <label className="mb-1 block text-xs text-gray-400">草稿（可以直接编辑）</label>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={8}
                  className="mb-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm leading-relaxed"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleGenerateDraft}
                    disabled={generating}
                    className="flex-1 rounded-lg bg-gray-100 py-2 text-xs text-gray-600"
                  >
                    重新生成
                  </button>
                  <button
                    onClick={() => {
                      setSavingName({ content: draft })
                      setNameDraft('')
                    }}
                    className="flex-1 rounded-lg bg-gray-100 py-2 text-xs text-gray-600"
                  >
                    存到收藏夹
                  </button>
                  <button
                    onClick={() => {
                      applyWorldview(draft)
                      setDraft('')
                      setIdea('')
                    }}
                    className="flex-1 rounded-lg bg-gray-900 py-2 text-xs text-white"
                  >
                    确认应用
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {savedWorldviews.length > 0 && (
        <section className="mt-3 bg-white px-4 py-4">
          <h2 className="mb-2 text-xs font-medium text-gray-400">收藏的世界观</h2>
          <div className="space-y-2">
            {savedWorldviews.map((w) => (
              <div key={w.id} className="rounded-lg bg-gray-50 px-3 py-2.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[13px] font-medium text-gray-800">{w.name}</span>
                  <span className="text-[11px] text-gray-400">{formatListTime(w.createdAt)}</span>
                </div>
                <p className="mb-2 line-clamp-2 text-[12.5px] leading-relaxed text-gray-500">{w.content}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => applyWorldview(w.content)}
                    className="rounded-md bg-gray-900 px-3 py-1 text-xs text-white"
                  >
                    应用
                  </button>
                  <button
                    onClick={() => db.savedWorldviews.delete(w.id)}
                    className="rounded-md bg-gray-100 px-3 py-1 text-xs text-gray-500"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      </div>

      {savingName && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-8">
          <div className="w-full rounded-2xl bg-white p-4">
            <h2 className="mb-3 text-center text-[15px] font-medium text-gray-900">给这个世界观起个名字</h2>
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="比如：超能力设定"
              maxLength={20}
              className="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setSavingName(null)}
                className="flex-1 rounded-lg bg-gray-100 py-2 text-sm text-gray-600"
              >
                取消
              </button>
              <button
                onClick={handleSaveToLibrary}
                disabled={!nameDraft.trim()}
                className="flex-1 rounded-lg bg-gray-900 py-2 text-sm text-white disabled:opacity-50"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
