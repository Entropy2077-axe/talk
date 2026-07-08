import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { TopBar } from '../components/TopBar'
import { useConsoleCaptureStore } from '../lib/consoleCapture'
import { useSettingsStore } from '../store/useSettingsStore'
import { db } from '../db/db'
import { formatBubbleTime } from '../lib/time'

const LEVEL_COLOR: Record<string, string> = {
  log: 'text-gray-600',
  info: 'text-blue-600',
  warn: 'text-amber-600',
  error: 'text-red-600',
}

const REDACTED_KEYS = ['apiKey', 'tavilyApiKey', 'pexelsApiKey']

function parsedObject(parsed: unknown): Record<string, unknown> {
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

function textBlock(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return JSON.stringify(value, null, 2)
}

export function SkyEyePage() {
  const logs = useConsoleCaptureStore((s) => s.logs)
  const clearLogs = useConsoleCaptureStore((s) => s.clear)
  const settings = useSettingsStore()
  const [stats, setStats] = useState<Record<string, number> | null>(null)
  const [openTurnId, setOpenTurnId] = useState<string | null>(null)
  const recentTurns = useLiveQuery(() => db.aiTurns.orderBy('createdAt').reverse().limit(10).toArray(), []) ?? []

  useEffect(() => {
    async function loadStats() {
      const [
        contacts,
        conversations,
        messages,
        groups,
        moments,
        momentComments,
        momentLikes,
        knowledgeEntries,
        savedWorldviews,
        inventory,
        stickers,
      ] = await Promise.all([
        db.contacts.count(),
        db.conversations.count(),
        db.messages.count(),
        db.groups.count(),
        db.moments.count(),
        db.momentComments.count(),
        db.momentLikes.count(),
        db.knowledgeEntries.count(),
        db.savedWorldviews.count(),
        db.inventory.count(),
        db.stickers.count(),
      ])
      setStats({
        联系人: contacts,
        会话: conversations,
        消息: messages,
        群聊: groups,
        朋友圈: moments,
        朋友圈评论: momentComments,
        朋友圈点赞: momentLikes,
        知识库条目: knowledgeEntries,
        收藏的世界观: savedWorldviews,
        仓库物品: inventory,
        表情包: stickers,
      })
    }
    loadStats()
  }, [])

  const settingsDump = Object.fromEntries(
    Object.entries(settings)
      .filter(([key]) => key !== 'setSettings')
      .map(([key, value]) => [key, REDACTED_KEYS.includes(key) ? (value ? '(已配置)' : '(未配置)') : value]),
  )

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="天眼" showBack />

      <div className="flex-1 overflow-y-auto">
        <section className="mt-3 bg-white px-4 py-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-medium text-gray-400">Console 日志（最近{logs.length}条）</h2>
            <button onClick={clearLogs} className="text-xs text-gray-400 underline">
              清空
            </button>
          </div>
          {logs.length === 0 ? (
            <p className="text-sm text-gray-400">还没有日志</p>
          ) : (
            <div className="max-h-80 space-y-1 overflow-y-auto rounded-lg bg-gray-50 p-2 font-mono text-[11px] leading-relaxed">
              {logs.map((l) => (
                <p key={l.id} className={LEVEL_COLOR[l.level]}>
                  <span className="text-gray-400">[{formatBubbleTime(l.timestamp)}]</span> {l.message}
                </p>
              ))}
            </div>
          )}
        </section>

        <section className="mt-3 bg-white px-4 py-4">
          <h2 className="mb-2 text-xs font-medium text-gray-400">数据统计</h2>
          {stats ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm text-gray-700">
              {Object.entries(stats).map(([label, count]) => (
                <div key={label} className="flex justify-between">
                  <span className="text-gray-500">{label}</span>
                  <span className="font-medium">{count}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400">加载中…</p>
          )}
        </section>

        <section className="mt-3 bg-white px-4 py-4">
          <h2 className="mb-2 text-xs font-medium text-gray-400">最近 AI 回合</h2>
          {recentTurns.length === 0 ? (
            <p className="text-sm text-gray-400">还没有 AI 回合记录</p>
          ) : (
            <div className="space-y-2">
              {recentTurns.map((turn) => {
                const parsed = parsedObject(turn.parsed)
                const isOpen = openTurnId === turn.id
                return (
                  <div key={turn.id} className="rounded-lg border border-gray-100 bg-gray-50">
                    <button
                      onClick={() => setOpenTurnId(isOpen ? null : turn.id)}
                      className="flex w-full items-center justify-between px-3 py-2 text-left"
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-800">{formatBubbleTime(turn.createdAt)}</p>
                        <p className="text-[11px] text-gray-400">
                          bubbles:{' '}
                          {Array.isArray(parsed.parsedBubbles) ? parsed.parsedBubbles.length : '-'} / mood:{' '}
                          {textBlock(parsed.mood) || '-'}
                        </p>
                      </div>
                      <span className="text-xs text-gray-400">{isOpen ? '收起' : '展开'}</span>
                    </button>
                    {isOpen && (
                      <div className="space-y-3 border-t border-gray-100 p-3">
                        <div>
                          <p className="mb-1 text-xs text-gray-400">主模型原始回复</p>
                          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white p-2 text-[11px] text-gray-700">
                            {textBlock(parsed.rawText) || '（旧记录无）'}
                          </pre>
                        </div>
                        <div>
                          <p className="mb-1 text-xs text-gray-400">解析后的气泡 / mood / thought</p>
                          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[11px] text-gray-700">
                            {JSON.stringify(
                              {
                                bubbles: parsed.parsedBubbles,
                                mood: parsed.mood,
                                thought: parsed.thought,
                                validator: parsed.validator,
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </div>
                        <div>
                          <p className="mb-1 text-xs text-gray-400">记忆 / 内部意图 / 知识查询</p>
                          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[11px] text-gray-700">
                            {JSON.stringify(
                              {
                                memoryUpdate: parsed.memoryUpdate,
                                injectedIntents: parsed.injectedIntents,
                                knowledgeQueries: parsed.knowledgeQueries ?? turn.knowledgeQueries,
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </div>
                        <div>
                          <p className="mb-1 text-xs text-gray-400">JSON 转换结果</p>
                          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[11px] text-gray-700">
                            {textBlock(parsed.conversionParsed) || turn.raw}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <section className="mt-3 bg-white px-4 py-4">
          <h2 className="mb-2 text-xs font-medium text-gray-400">当前设置（敏感字段已隐藏）</h2>
          <pre className="overflow-x-auto rounded-lg bg-gray-50 p-2 font-mono text-[11px] leading-relaxed text-gray-600">
            {JSON.stringify(settingsDump, null, 2)}
          </pre>
        </section>
      </div>
    </div>
  )
}
