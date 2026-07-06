import { useEffect, useState } from 'react'
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

export function SkyEyePage() {
  const logs = useConsoleCaptureStore((s) => s.logs)
  const clearLogs = useConsoleCaptureStore((s) => s.clear)
  const settings = useSettingsStore()
  const [stats, setStats] = useState<Record<string, number> | null>(null)

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
        todos,
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
        db.todos.count(),
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
        待办: todos,
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
          <h2 className="mb-2 text-xs font-medium text-gray-400">当前设置（敏感字段已隐藏）</h2>
          <pre className="overflow-x-auto rounded-lg bg-gray-50 p-2 font-mono text-[11px] leading-relaxed text-gray-600">
            {JSON.stringify(settingsDump, null, 2)}
          </pre>
        </section>
      </div>
    </div>
  )
}
