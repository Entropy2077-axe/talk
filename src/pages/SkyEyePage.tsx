import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { TopBar } from '../components/TopBar'
import { useConsoleCaptureStore } from '../lib/consoleCapture'
import { db } from '../db/db'
import { formatBubbleTime } from '../lib/time'
import { useChatEngineStore, stopAiTurn } from '../lib/chatEngine'
import { stopGroupAiTurn } from '../lib/groupChatEngine'

const COLORS: Record<string, string> = { log: 'text-gray-600', info: 'text-blue-600', warn: 'text-amber-600', error: 'text-red-600' }
const PAGE = 50

export function SkyEyePage() {
  const logs = useConsoleCaptureStore((s) => s.logs)
  const clearLogs = useConsoleCaptureStore((s) => s.clear)
  const states = useChatEngineStore((s) => s.states)
  const [logPage, setLogPage] = useState(0); const [turnPage, setTurnPage] = useState(0); const [level, setLevel] = useState('all'); const [query, setQuery] = useState(''); const [open, setOpen] = useState<string | null>(null)
  const conversations = useLiveQuery(() => db.conversations.toArray(), []) ?? []
  const traces = useLiveQuery(() => db.adminAiTraces.orderBy('createdAt').reverse().toArray(), []) ?? []
  const shownLogs = useMemo(() => logs.slice().reverse().filter((log) => (level === 'all' || log.level === level) && log.message.toLowerCase().includes(query.toLowerCase())), [logs, level, query])
  const shownTurns = traces.slice(turnPage * 20, turnPage * 20 + 20)
  const active = Object.entries(states).filter(([, state]) => state.aiTyping)
  const label = (id: string) => conversations.find((item) => item.id === id)?.groupId ? '群聊' : '私聊'
  return <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]"><TopBar title="天眼 · 管理台" showBack /><div className="flex-1 overflow-y-auto pb-5">
    <section className="mt-3 bg-white px-4 py-4"><h2 className="mb-2 text-sm font-medium">运行控制</h2>{active.length === 0 ? <p className="text-xs text-gray-400">没有正在生成的 AI 回合。</p> : active.map(([id, state]) => <div key={id} className="mb-2 flex items-center justify-between rounded-lg bg-green-50 p-2 text-sm"><span>{label(id)} · {state.typingLabel || 'AI'} 正在生成</span><button type="button" onClick={() => conversations.find((c) => c.id === id)?.groupId ? stopGroupAiTurn(id) : stopAiTurn(id)} className="text-red-500">停止</button></div>)}</section>
    <section className="mt-3 bg-white px-4 py-4"><div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-medium">Console 日志</h2><button type="button" onClick={clearLogs} className="text-xs text-red-500">清空</button></div><div className="mb-2 flex gap-2"><select value={level} onChange={(e) => { setLevel(e.target.value); setLogPage(0) }} className="rounded border px-2 text-xs"><option value="all">全部</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option><option value="log">日志</option></select><input value={query} onChange={(e) => { setQuery(e.target.value); setLogPage(0) }} placeholder="搜索日志" className="min-w-0 flex-1 rounded border px-2 text-xs" /></div><div className="space-y-1 rounded-lg bg-gray-50 p-2 font-mono text-[11px]">{shownLogs.slice(logPage * PAGE, logPage * PAGE + PAGE).map((log) => <p key={log.id} className={COLORS[log.level]}><span className="text-gray-400">[{formatBubbleTime(log.timestamp)}]</span> {log.message}</p>)}</div><Pager page={logPage} total={shownLogs.length} size={PAGE} setPage={setLogPage} /></section>
    <section className="mt-3 bg-white px-4 py-4"><h2 className="mb-2 text-sm font-medium">AI 调用追踪</h2>{shownTurns.map((trace) => <div key={trace.id} className="mb-2 rounded-lg border bg-gray-50"><button type="button" onClick={() => setOpen(open === trace.id ? null : trace.id)} className="flex w-full justify-between p-2 text-left"><span className="text-sm">{trace.purpose} · {trace.model}</span><span className="text-[11px] text-gray-400">{new Date(trace.createdAt).toLocaleString()}</span></button>{open === trace.id && <div className="space-y-2 border-t p-2"><pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-[11px]">{JSON.stringify(trace.messages, null, 2)}</pre><pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-[11px]">{trace.output || trace.error || ''}</pre></div>}</div>)}<Pager page={turnPage} total={traces.length} size={20} setPage={setTurnPage} /></section>
  </div></div>
}
function Pager({ page, total, size, setPage }: { page: number; total: number; size: number; setPage: (page: number) => void }) { const pages = Math.max(1, Math.ceil(total / size)); return <div className="mt-2 flex justify-between text-xs"><button disabled={page === 0} onClick={() => setPage(page - 1)} className="disabled:text-gray-300">上一页</button><span>{page + 1} / {pages}</span><button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} className="disabled:text-gray-300">下一页</button></div> }
