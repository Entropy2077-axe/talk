import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { TopBar } from '../components/TopBar'
import { useConsoleCaptureStore } from '../lib/consoleCapture'
import { db } from '../db/db'
import { formatBubbleTime } from '../lib/time'
import { useChatEngineStore, stopAiTurn } from '../lib/chatEngine'
import { stopGroupAiTurn } from '../lib/groupChatEngine'
import type { AdminAiTrace, AdminAiTraceStage } from '../types'

const COLORS: Record<string, string> = { log: 'text-gray-600', info: 'text-blue-600', warn: 'text-amber-600', error: 'text-red-600' }
const PAGE = 50
const TRACE_PAGE = 20
const EMPTY_TRACES: AdminAiTrace[] = []
const STAGE_ORDER: AdminAiTraceStage[] = ['first_chat', 'first_quality', 'second_chat', 'other', 'second_quality']
const STAGE_LABEL: Record<AdminAiTraceStage, string> = { first_chat: '第一次 Chat', first_quality: '第一次审核', second_chat: '第二次 Chat', other: 'Other 转换', second_quality: '第二次审核' }

interface TraceTurn { id: string; traces: AdminAiTrace[]; createdAt: number; conversationId?: string; legacy: boolean }

function groupTraces(traces: AdminAiTrace[]): TraceTurn[] {
  const groups = new Map<string, TraceTurn>()
  for (const trace of traces) {
    const id = trace.turnId || `legacy:${trace.id}`
    const existing = groups.get(id)
    if (existing) {
      existing.traces.push(trace)
      existing.createdAt = Math.max(existing.createdAt, trace.createdAt)
    } else groups.set(id, { id, traces: [trace], createdAt: trace.createdAt, conversationId: trace.conversationId, legacy: !trace.turnId })
  }
  return Array.from(groups.values()).sort((a, b) => b.createdAt - a.createdAt)
}

function reviewResult(trace: AdminAiTrace): { passed?: boolean; reason?: string } {
  if (trace.error) return { passed: false, reason: trace.error }
  try {
    const parsed = JSON.parse(trace.output || '') as { valid?: unknown; reason?: unknown }
    return { passed: parsed.valid === true, reason: typeof parsed.reason === 'string' ? parsed.reason : undefined }
  } catch { return {} }
}

export function SkyEyePage() {
  const logs = useConsoleCaptureStore((s) => s.logs)
  const clearLogs = useConsoleCaptureStore((s) => s.clear)
  const states = useChatEngineStore((s) => s.states)
  const [logPage, setLogPage] = useState(0); const [turnPage, setTurnPage] = useState(0); const [level, setLevel] = useState('all'); const [query, setQuery] = useState(''); const [open, setOpen] = useState<string | null>(null)
  const conversations = useLiveQuery(() => db.conversations.toArray(), []) ?? []
  const traces = useLiveQuery(() => db.adminAiTraces.orderBy('createdAt').reverse().toArray(), []) ?? EMPTY_TRACES
  const traceTurns = useMemo(() => groupTraces(traces), [traces])
  const shownLogs = useMemo(() => logs.slice().reverse().filter((log) => (level === 'all' || log.level === level) && log.message.toLowerCase().includes(query.toLowerCase())), [logs, level, query])
  const shownTurns = traceTurns.slice(turnPage * TRACE_PAGE, turnPage * TRACE_PAGE + TRACE_PAGE)
  const active = Object.entries(states).filter(([, state]) => state.aiTyping)
  const label = (id: string) => conversations.find((item) => item.id === id)?.groupId ? '群聊' : '私聊'
  return <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]"><TopBar title="天眼 · 管理台" showBack /><div className="flex-1 overflow-y-auto pb-5">
    <section className="mt-3 bg-white px-4 py-4"><h2 className="mb-2 text-sm font-medium">运行控制</h2>{active.length === 0 ? <p className="text-xs text-gray-400">没有正在生成的 AI 回合。</p> : active.map(([id, state]) => <div key={id} className="mb-2 flex items-center justify-between rounded-lg bg-green-50 p-2 text-sm"><span>{label(id)} · {state.typingLabel || 'AI'} 正在生成</span><button type="button" onClick={() => conversations.find((c) => c.id === id)?.groupId ? stopGroupAiTurn(id) : stopAiTurn(id)} className="text-red-500">停止</button></div>)}</section>
    <section className="mt-3 bg-white px-4 py-4"><div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-medium">Console 日志</h2><button type="button" onClick={clearLogs} className="text-xs text-red-500">清空</button></div><div className="mb-2 flex gap-2"><select value={level} onChange={(e) => { setLevel(e.target.value); setLogPage(0) }} className="rounded border px-2 text-xs"><option value="all">全部</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option><option value="log">日志</option></select><input value={query} onChange={(e) => { setQuery(e.target.value); setLogPage(0) }} placeholder="搜索日志" className="min-w-0 flex-1 rounded border px-2 text-xs" /></div><div className="space-y-1 rounded-lg bg-gray-50 p-2 font-mono text-[11px]">{shownLogs.slice(logPage * PAGE, logPage * PAGE + PAGE).map((log) => <p key={log.id} className={COLORS[log.level]}><span className="text-gray-400">[{formatBubbleTime(log.timestamp)}]</span> {log.message}</p>)}</div><Pager page={logPage} total={shownLogs.length} size={PAGE} setPage={setLogPage} /></section>
    <section className="mt-3 bg-white px-4 py-4"><h2 className="mb-2 text-sm font-medium">AI 调用追踪</h2><p className="mb-3 text-[11px] text-gray-400">每张卡片代表一轮回复，按 Chat → 审核 → 重写 → 转换 → 最终审核排列。</p>{shownTurns.map((turn) => <TraceTurnCard key={turn.id} turn={turn} open={open === turn.id} toggle={() => setOpen(open === turn.id ? null : turn.id)} scene={turn.conversationId ? label(turn.conversationId) : undefined} />)}<Pager page={turnPage} total={traceTurns.length} size={TRACE_PAGE} setPage={setTurnPage} /></section>
  </div></div>
}

function TraceTurnCard({ turn, open, toggle, scene }: { turn: TraceTurn; open: boolean; toggle: () => void; scene?: string }) {
  const ordered = [...turn.traces].sort((a, b) => {
    const ai = a.stage ? STAGE_ORDER.indexOf(a.stage) : 99
    const bi = b.stage ? STAGE_ORDER.indexOf(b.stage) : 99
    return ai === bi ? a.createdAt - b.createdAt : ai - bi
  })
  const finalReview = [...ordered].reverse().find((trace) => trace.stage === 'second_quality')
  const firstReview = ordered.find((trace) => trace.stage === 'first_quality')
  const finalStatus = finalReview ? reviewResult(finalReview) : firstReview ? reviewResult(firstReview) : {}
  return <div className="mb-3 overflow-hidden rounded-xl border bg-gray-50">
    <button type="button" onClick={toggle} className="w-full p-3 text-left">
      <div className="flex items-start justify-between gap-2"><div><p className="text-sm font-medium">{turn.legacy ? `${ordered[0].purpose} · ${ordered[0].model}` : `${scene || 'AI 回复'} · ${ordered.length} 次调用`}</p><div className="mt-1 flex flex-wrap gap-1">{ordered.map((trace) => <span key={trace.id} className="rounded bg-white px-1.5 py-0.5 text-[10px] text-gray-500">{trace.stage ? STAGE_LABEL[trace.stage] : trace.purpose}</span>)}</div></div><div className="text-right"><p className="text-[11px] text-gray-400">{new Date(turn.createdAt).toLocaleString()}</p>{finalStatus.passed !== undefined && <p className={`mt-1 text-[11px] ${finalStatus.passed ? 'text-green-600' : 'text-red-500'}`}>{finalStatus.passed ? '审核通过' : '审核未通过'}</p>}</div></div>
    </button>
    {open && <div className="space-y-3 border-t p-3">{ordered.map((trace, index) => <TraceStep key={trace.id} trace={trace} index={index} />)}</div>}
  </div>
}

function TraceStep({ trace, index }: { trace: AdminAiTrace; index: number }) {
  const isReview = trace.stage === 'first_quality' || trace.stage === 'second_quality' || (!trace.stage && trace.purpose === 'quality')
  const result = isReview ? reviewResult(trace) : {}
  const title = trace.stage ? STAGE_LABEL[trace.stage] : `${trace.purpose} · ${trace.model}`
  return <div className={`rounded-lg border p-2 ${trace.stage === 'first_chat' ? 'border-blue-200 bg-blue-50' : isReview ? 'border-amber-200 bg-amber-50' : 'bg-white'}`}>
    <div className="mb-2 flex items-center justify-between gap-2"><p className="text-xs font-medium">{index + 1}. {title} <span className="font-normal text-gray-400">· {trace.model}</span></p>{isReview && result.passed !== undefined && <span className={`rounded px-1.5 py-0.5 text-[10px] ${result.passed ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>{result.passed ? '通过' : '未通过'}</span>}</div>
    {result.reason && <p className="mb-2 rounded bg-white/80 p-2 text-[11px] text-gray-600">审核原因：{result.reason}</p>}
    <details open={trace.stage === 'first_chat' || !trace.stage}><summary className="cursor-pointer text-[11px] text-gray-500">输入消息 / Prompt</summary><pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-[11px]">{trace.messages.map((message) => `[${message.role}]\n${message.content}`).join('\n\n')}</pre></details>
    <details open><summary className="cursor-pointer text-[11px] text-gray-500">{trace.error ? '错误' : '模型输出'}</summary><pre className={`mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded p-2 text-[11px] ${trace.error ? 'bg-red-50 text-red-600' : 'bg-white'}`}>{trace.output || trace.error || '（无输出）'}</pre></details>
    <p className="mt-1 text-right text-[10px] text-gray-400">输入 {trace.inputTokens} · 输出 {trace.outputTokens} tokens</p>
  </div>
}
function Pager({ page, total, size, setPage }: { page: number; total: number; size: number; setPage: (page: number) => void }) { const pages = Math.max(1, Math.ceil(total / size)); return <div className="mt-2 flex justify-between text-xs"><button disabled={page === 0} onClick={() => setPage(page - 1)} className="disabled:text-gray-300">上一页</button><span>{page + 1} / {pages}</span><button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} className="disabled:text-gray-300">下一页</button></div> }
