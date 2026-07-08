import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { searchKnowledgeTopic } from '../lib/knowledgeBase'
import { formatListTime } from '../lib/time'

export function KnowledgeBasePage() {
  const settings = useSettingsStore()

  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchMessage, setSearchMessage] = useState('')

  const knowledgeEntries = useLiveQuery(() => db.knowledgeEntries.orderBy('fetchedAt').reverse().toArray(), []) ?? []

  async function handleSearchKnowledge() {
    if (!searchQuery.trim()) return
    setSearching(true)
    setSearchMessage('')
    try {
      const result = await searchKnowledgeTopic(searchQuery.trim(), settings)
      setSearchMessage(result.message ?? `新增了${result.addedCount}条知识`)
      if (!result.message) setSearchQuery('')
    } catch (err) {
      setSearchMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="知识库" showBack />
      <div className="flex-1 overflow-y-auto">
        <section className="mt-3 bg-white px-4 py-4">
          <h2 className="mb-2 text-xs font-medium text-gray-400">知识库（网络热梗/番剧/游戏，聊天时AI会尝试引用）</h2>
          <p className="mb-2 text-[11px] leading-relaxed text-gray-400">
            聊天时AI/你提到不认识的梗会自动在后台查一次（只查第一次，不会重复更新同一个话题）。也可以在下面手动指定一个方向搜索：
          </p>
          <div className="mb-2 flex gap-2">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleSearchKnowledge()
                }
              }}
              placeholder="想让AI了解点什么？比如一个梗/番剧/游戏名字"
              className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
            <button
              onClick={handleSearchKnowledge}
              disabled={!searchQuery.trim() || searching}
              className="shrink-0 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {searching ? '搜索中…' : '搜索'}
            </button>
          </div>
          {searchMessage && <p className="mb-2 text-xs text-gray-500">{searchMessage}</p>}

          {knowledgeEntries.length === 0 ? (
            <p className="text-sm text-gray-400">还没有知识条目</p>
          ) : (
            <div className="space-y-2">
              {knowledgeEntries.map((e) => (
                <div key={e.id} className="rounded-lg bg-gray-50 px-3 py-2">
                  <div className="mb-0.5 flex items-center justify-between">
                    <span className="text-[13px] font-medium text-gray-800">{e.topic}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[11px] text-gray-400">{formatListTime(e.fetchedAt)}</span>
                      <button
                        onClick={() => db.knowledgeEntries.delete(e.id)}
                        aria-label="删除这条知识"
                        className="text-[11px] text-gray-300"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  <p className="text-[12.5px] leading-relaxed text-gray-600">{e.content}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
