import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { TopBar } from '../components/TopBar'
import { useConsoleCaptureStore } from '../lib/consoleCapture'
import { useSettingsStore } from '../store/useSettingsStore'
import { db } from '../db/db'
import { formatBubbleTime } from '../lib/time'
import { useChatEngineStore, stopAiTurn } from '../lib/chatEngine'
import { stopGroupAiTurn } from '../lib/groupChatEngine'
import { refreshMoments } from '../lib/moments'
import { maybeTriggerProactiveMessage } from '../lib/proactiveChat'
import { ALL_MODULES } from '../features'

const LEVEL_COLOR: Record<string, string> = { log: 'text-gray-600', info: 'text-blue-600', warn: 'text-amber-600', error: 'text-red-600' }
const REDACTED_KEYS = ['apiKey', 'tavilyApiKey', 'pexelsApiKey']

function parsedObject(parsed: unknown): Record<string, unknown> { return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {} }
function textBlock(value: unknown): string { return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2) }
function when(timestamp: number): string { return `${formatBubbleTime(timestamp)} · ${new Date(timestamp).toLocaleDateString()}` }

export function SkyEyePage() {
  const logs = useConsoleCaptureStore((s) => s.logs)
  const clearLogs = useConsoleCaptureStore((s) => s.clear)
  const settings = useSettingsStore()
  const runtimeStates = useChatEngineStore((s) => s.states)
  const [openTurnId, setOpenTurnId] = useState<string | null>(null)
  const [actionStatus, setActionStatus] = useState('')
  const recentTurns = useLiveQuery(() => db.aiTurns.orderBy('createdAt').reverse().limit(20).toArray(), []) ?? []
  const socialEvents = useLiveQuery(() => db.socialEvents.orderBy('createdAt').reverse().limit(12).toArray(), []) ?? []
  const conversations = useLiveQuery(() => db.conversations.toArray(), []) ?? []
  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? []
  const groups = useLiveQuery(() => db.groups.toArray(), []) ?? []
  const counts = useLiveQuery(async () => ({
    联系人: await db.contacts.count(), 会话: await db.conversations.count(), 消息: await db.messages.count(), 群聊: await db.groups.count(),
    朋友圈: await db.moments.count(), 评论: await db.momentComments.count(), 点赞: await db.momentLikes.count(),
    社交事件: await db.socialEvents.count(), 结构化记忆: await db.contactMemories.count(), AI回合: await db.aiTurns.count(),
  }), [])

  const settingsDump = useMemo(() => Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'setSettings').map(([key, value]) => [key, REDACTED_KEYS.includes(key) ? (value ? '(已配置)' : '(未配置)') : value])), [settings])
  const labelForConversation = (id: string) => {
    const conversation = conversations.find((item) => item.id === id)
    const contact = conversation?.contactId ? contacts.find((item) => item.id === conversation.contactId) : undefined
    const group = conversation?.groupId ? groups.find((item) => item.id === conversation.groupId) : undefined
    return contact?.remark || contact?.name || group?.name || id.slice(0, 8)
  }
  const active = Object.entries(runtimeStates).filter(([, state]) => state.aiTyping)

  async function runAutonomyNow() {
    setActionStatus('正在执行一次自主行为…')
    try { await refreshMoments(settings); await maybeTriggerProactiveMessage(settings); setActionStatus('自主行为已执行；请查看朋友圈、会话和事件流。') }
    catch (error) { setActionStatus(`执行失败：${error instanceof Error ? error.message : String(error)}`) }
  }
  async function pruneExpiredEvents() {
    const now = Date.now()
    const expired = await db.socialEvents.filter((event) => !!event.expiresAt && event.expiresAt <= now).toArray()
    await db.socialEvents.bulkDelete(expired.map((event) => event.id))
    setActionStatus(`已清理 ${expired.length} 条过期社交事件。`)
  }
  async function copySnapshot() {
    const snapshot = { createdAt: new Date().toISOString(), counts, settings: settingsDump, active, logs: logs.slice(-80), socialEvents: socialEvents.slice(0, 12), aiTurns: recentTurns.slice(0, 8) }
    try { await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2)); setActionStatus('诊断快照已复制（已隐藏密钥）。') }
    catch { setActionStatus('复制失败：当前环境未授予剪贴板权限。') }
  }
  function stopAll() {
    for (const [conversationId] of active) {
      const conversation = conversations.find((item) => item.id === conversationId)
      if (conversation?.groupId) stopGroupAiTurn(conversationId); else stopAiTurn(conversationId)
    }
    setActionStatus(`已停止 ${active.length} 个正在运行的生成。`)
  }

  return <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
    <TopBar title="天眼 · 管理台" showBack />
    <div className="flex-1 overflow-y-auto pb-5">
      <section className="mt-3 bg-white px-4 py-4">
        <h2 className="mb-1 text-sm font-medium text-gray-900">运行控制</h2>
        <p className="mb-3 text-[11px] leading-relaxed text-gray-400">即时操作会影响当前本地数据或产生 API 请求；密钥始终不会展示或导出。</p>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <button onClick={() => void runAutonomyNow()} className="rounded-lg bg-[#07c160] px-2 py-2.5 text-white">立即跑一次自主行为</button>
          <button onClick={stopAll} disabled={active.length === 0} className="rounded-lg bg-red-50 px-2 py-2.5 text-red-600 disabled:text-gray-300">停止生成 ({active.length})</button>
          <button onClick={() => void pruneExpiredEvents()} className="rounded-lg bg-gray-100 px-2 py-2.5 text-gray-700">清理过期事件</button>
          <button onClick={() => void copySnapshot()} className="rounded-lg bg-gray-100 px-2 py-2.5 text-gray-700">复制诊断快照</button>
        </div>
        {actionStatus && <p className="mt-2 text-xs text-gray-500">{actionStatus}</p>}
      </section>

      <section className="mt-3 bg-white px-4 py-4">
        <h2 className="mb-2 text-xs font-medium text-gray-400">当前进程</h2>
        {active.length === 0 ? <p className="text-sm text-gray-400">没有正在生成的 AI 回合</p> : <div className="space-y-2">{active.map(([conversationId, state]) => <div key={conversationId} className="flex items-center justify-between rounded-lg bg-green-50 px-3 py-2"><div><p className="text-sm text-gray-800">{labelForConversation(conversationId)}</p><p className="text-[11px] text-gray-500">{state.typingLabel || 'AI'} 正在生成</p></div><button onClick={() => { const conversation = conversations.find((item) => item.id === conversationId); if (conversation?.groupId) stopGroupAiTurn(conversationId); else stopAiTurn(conversationId) }} className="text-xs text-red-500">停止</button></div>)}</div>}
      </section>

      <section className="mt-3 bg-white px-4 py-4"><h2 className="mb-2 text-xs font-medium text-gray-400">数据统计</h2>{counts ? <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm text-gray-700">{Object.entries(counts).map(([label, count]) => <div key={label} className="flex justify-between"><span className="text-gray-500">{label}</span><span className="font-medium">{count}</span></div>)}</div> : <p className="text-sm text-gray-400">加载中…</p>}</section>

      <section className="mt-3 bg-white px-4 py-4"><h2 className="mb-2 text-xs font-medium text-gray-400">模块状态</h2><div className="grid grid-cols-2 gap-2">{ALL_MODULES.map((module) => <div key={module.id} className="rounded-lg bg-gray-50 px-2 py-2 text-xs"><span>{module.icon} {module.name}</span><span className={`float-right ${settings.enabledModules.includes(module.id) ? 'text-[#07c160]' : 'text-gray-400'}`}>{settings.enabledModules.includes(module.id) ? '运行中' : '关闭'}</span></div>)}</div></section>

      <section className="mt-3 bg-white px-4 py-4"><h2 className="mb-2 text-xs font-medium text-gray-400">社交事件流</h2>{socialEvents.length === 0 ? <p className="text-sm text-gray-400">暂无事件</p> : <div className="space-y-2">{socialEvents.map((event) => <div key={event.id} className="border-l-2 border-[#07c160] pl-2"><p className="text-xs text-gray-700">{event.summary}</p><p className="text-[10px] text-gray-400">{when(event.createdAt)} · 重要度 {event.importance} · {event.expiresAt ? `到期 ${when(event.expiresAt)}` : '永久'}</p></div>)}</div>}</section>

      <section className="mt-3 bg-white px-4 py-4"><div className="mb-2 flex items-center justify-between"><h2 className="text-xs font-medium text-gray-400">Console 日志（最近{logs.length}条）</h2><button onClick={clearLogs} className="text-xs text-gray-400 underline">清空</button></div>{logs.length === 0 ? <p className="text-sm text-gray-400">还没有日志</p> : <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg bg-gray-50 p-2 font-mono text-[11px] leading-relaxed">{logs.map((log) => <p key={log.id} className={LEVEL_COLOR[log.level]}><span className="text-gray-400">[{formatBubbleTime(log.timestamp)}]</span> {log.message}</p>)}</div>}</section>

      <section className="mt-3 bg-white px-4 py-4"><h2 className="mb-2 text-xs font-medium text-gray-400">最近 AI 回合（可追溯提示词）</h2>{recentTurns.length === 0 ? <p className="text-sm text-gray-400">还没有 AI 回合记录</p> : <div className="space-y-2">{recentTurns.map((turn) => { const parsed = parsedObject(turn.parsed); const open = openTurnId === turn.id; return <div key={turn.id} className="rounded-lg border border-gray-100 bg-gray-50"><button onClick={() => setOpenTurnId(open ? null : turn.id)} className="flex w-full items-center justify-between px-3 py-2 text-left"><div><p className="text-sm font-medium text-gray-800">{labelForConversation(turn.conversationId)} · {when(turn.createdAt)}</p><p className="text-[11px] text-gray-400">气泡 {Array.isArray(parsed.parsedBubbles) ? parsed.parsedBubbles.length : '-'} · {textBlock(parsedObject(parsed.qualityCheck).reason) || '未见质量问题'}</p></div><span className="text-xs text-gray-400">{open ? '收起' : '展开'}</span></button>{open && <div className="space-y-3 border-t border-gray-100 p-3">{[['最终提示词构成', parsed.promptTrace], ['实际主提示词', parsed.mainPrompt], ['主模型原始回复', parsed.rawText], ['转换提示词', parsed.conversionPrompt], ['转换结果', parsed.conversionParsed ?? turn.raw], ['结构化结果 / 质量 / 记忆', { bubbles: parsed.parsedBubbles, mood: parsed.mood, thought: parsed.thought, qualityCheck: parsed.qualityCheck, memoryUpdate: parsed.memoryUpdate, groupMemoryUpdate: parsed.groupMemoryUpdate, storyOutline: parsed.storyOutline }]].map(([label, value]) => <div key={String(label)}><p className="mb-1 text-xs text-gray-400">{String(label)}</p><pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white p-2 text-[11px] text-gray-700">{textBlock(value)}</pre></div>)}</div>}</div> })}</div>}</section>

      <section className="mt-3 bg-white px-4 py-4"><h2 className="mb-2 text-xs font-medium text-gray-400">当前设置（敏感字段已隐藏）</h2><pre className="overflow-x-auto rounded-lg bg-gray-50 p-2 font-mono text-[11px] leading-relaxed text-gray-600">{JSON.stringify(settingsDump, null, 2)}</pre></section>
    </div>
  </div>
}
