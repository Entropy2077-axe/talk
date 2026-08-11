import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { TopBar } from '../components/TopBar'
import { useConsoleCaptureStore } from '../lib/consoleCapture'
import { db } from '../db/db'
import { formatBubbleTime } from '../lib/time'
import { useChatEngineStore, stopAiTurn } from '../lib/chatEngine'
import { stopGroupAiTurn } from '../lib/groupChatEngine'
import type { AdminAiTrace, AdminAiTraceStage } from '../types'
import { isAiTestId } from '../lib/aiTestIsolation'

const COLORS: Record<string, string> = { log: 'text-[var(--ui-text-2)]', info: 'text-[var(--ui-link)]', warn: 'text-[var(--ui-warning)]', error: 'text-[var(--ui-danger)]' }
const PAGE = 50
const TRACE_PAGE = 20
const EMPTY_TRACES: AdminAiTrace[] = []
const STAGE_ORDER: AdminAiTraceStage[] = ['original_generation', 'tool_call', 'review_and_repair', 'image_generation', 'sticker_lookup', 'schedule_change', 'location_change', 'first_chat', 'first_quality', 'second_chat', 'other', 'second_quality']
const STAGE_LABEL: Record<AdminAiTraceStage, string> = {
  original_generation: '原文生成', tool_call: '工具调用', review_and_repair: '审核及 JSON 修复', json_translation: 'JSON 格式翻译',
  image_generation: '图片生成', sticker_lookup: '表情包获取', schedule_change: '日程变更执行', location_change: '地点变更执行',
  first_chat: '原文生成（旧记录）', first_quality: '审核及修改（旧记录）', second_chat: '二次生成（旧记录）', other: 'JSON 格式翻译（旧记录）', second_quality: '二次审核（旧记录)',
}

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

function formatDuration(durationMs?: number): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return '耗时未知'
  if (durationMs < 1000) return `耗时 ${Math.max(0, Math.round(durationMs))} 毫秒`
  return `耗时 ${(durationMs / 1000).toFixed(durationMs < 10_000 ? 2 : 1)} 秒`
}

export function SkyEyePage() {
  const logs = useConsoleCaptureStore((s) => s.logs)
  const clearLogs = useConsoleCaptureStore((s) => s.clear)
  const states = useChatEngineStore((s) => s.states)
  const [logPage, setLogPage] = useState(0)
  const [turnPage, setTurnPage] = useState(0)
  const [level, setLevel] = useState('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [logsExpanded, setLogsExpanded] = useState(false)
  const conversations = (useLiveQuery(() => db.conversations.toArray(), []) ?? []).filter((item) => !isAiTestId(item.id))
  const traces = (useLiveQuery(() => db.adminAiTraces.orderBy('createdAt').reverse().toArray(), []) ?? EMPTY_TRACES).filter((item) => !isAiTestId(item.conversationId))
  const traceTurns = useMemo(() => groupTraces(traces), [traces])
  const shownLogs = useMemo(() => logs.slice().reverse().filter((log) => (level === 'all' || log.level === level) && log.message.toLowerCase().includes(query.toLowerCase())), [logs, level, query])
  const shownTurns = traceTurns.slice(turnPage * TRACE_PAGE, turnPage * TRACE_PAGE + TRACE_PAGE)
  const active = Object.entries(states).filter(([id, state]) => !isAiTestId(id) && state.aiTyping)
  const label = (id: string) => conversations.find((item) => item.id === id)?.groupId ? '群聊' : '私聊'

  return <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[var(--ui-surface-2)]">
    <TopBar title="天眼 · 管理台" showBack />
    <div className="flex-1 overflow-y-auto pb-5">
      <section className="border-b border-[var(--ui-border-soft)] bg-[var(--ui-surface)] px-4 py-4">
        <div className="mb-3 flex items-start justify-between gap-3"><div><h2 className="text-sm font-medium text-[var(--ui-text)]">运行控制</h2><p className="mt-1 text-xs text-[var(--ui-text-3)]">正在执行的任务优先显示</p></div>{active.length > 0 && <span className="rounded-full bg-[var(--ui-accent-soft)] px-2 py-1 text-[11px] text-[var(--ui-action)]">{active.length} 个运行中</span>}</div>
        {active.length === 0 ? <p className="text-xs text-[var(--ui-text-3)]">没有正在生成的 AI 回合。</p> : <div className="space-y-2">{active.map(([id, state]) => <div key={id} className="flex items-center justify-between gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] px-3 py-2.5 text-sm"><div className="min-w-0"><p className="truncate text-[var(--ui-text)]">{label(id)} · {state.typingLabel || 'AI'} 正在生成</p><p className="mt-1 text-[11px] text-[var(--ui-text-3)]">此任务可随时停止</p></div><button type="button" onClick={() => conversations.find((c) => c.id === id)?.groupId ? stopGroupAiTurn(id) : stopAiTurn(id)} className="shrink-0 rounded-[var(--ui-radius-control)] bg-[var(--ui-danger-soft)] px-2.5 py-1.5 text-xs text-[var(--ui-danger)]">停止</button></div>)}</div>}
      </section>

      <section className="mt-3 bg-[var(--ui-surface)] px-4 py-5">
        <div className="mb-3 flex items-start justify-between gap-3"><div><h2 className="text-sm font-medium text-[var(--ui-text)]">AI 调用追踪</h2><p className="mt-1 text-[11px] leading-relaxed text-[var(--ui-text-3)]">每张卡片代表一轮回复，按生成、工具、审核与最终结果排列。</p></div><span className="shrink-0 text-xs text-[var(--ui-text-3)]">{traceTurns.length} 回合</span></div>
        {shownTurns.length === 0 ? <p className="py-3 text-center text-xs text-[var(--ui-text-3)]">还没有可追踪的 AI 调用。</p> : shownTurns.map((turn) => <TraceTurnCard key={turn.id} turn={turn} open={open === turn.id} toggle={() => setOpen(open === turn.id ? null : turn.id)} scene={turn.conversationId ? label(turn.conversationId) : undefined} />)}
        <Pager page={turnPage} total={traceTurns.length} size={TRACE_PAGE} setPage={setTurnPage} />
      </section>

      <section className="mt-3 overflow-hidden bg-[var(--ui-surface)]">
        <div className="flex items-center justify-between gap-3 p-4"><div><h2 className="text-sm font-medium text-[var(--ui-text)]">系统日志</h2><p className="mt-1 text-xs text-[var(--ui-text-3)]">{shownLogs.length} 条记录，需要排查底层问题时再展开</p></div><button type="button" onClick={() => setLogsExpanded((value) => !value)} aria-expanded={logsExpanded} className="rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface-2)] px-3 py-1.5 text-xs text-[var(--ui-text-2)]">{logsExpanded ? '收起' : '展开'}</button></div>
        {logsExpanded && <div className="border-t border-[var(--ui-border-soft)] p-4 pt-3"><div className="mb-2 flex gap-2"><select value={level} onChange={(e) => { setLevel(e.target.value); setLogPage(0) }} aria-label="日志级别" className="rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface-2)] px-2 text-xs text-[var(--ui-text)]"><option value="all">全部</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option><option value="log">日志</option></select><input value={query} onChange={(e) => { setQuery(e.target.value); setLogPage(0) }} placeholder="搜索日志" className="min-w-0 flex-1 rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface-2)] px-2 text-xs text-[var(--ui-text)]" /></div><div className="max-h-80 space-y-1 overflow-y-auto rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] p-2 font-mono text-[11px]">{shownLogs.slice(logPage * PAGE, logPage * PAGE + PAGE).map((log) => <p key={log.id} className={COLORS[log.level]}><span className="text-[var(--ui-text-3)]">[{formatBubbleTime(log.timestamp)}]</span> {log.message}</p>)}{shownLogs.length === 0 && <p className="text-[var(--ui-text-3)]">没有符合条件的日志。</p>}</div><div className="mt-3 flex justify-end"><button type="button" onClick={clearLogs} className="text-xs text-[var(--ui-danger)]">清空日志</button></div><Pager page={logPage} total={shownLogs.length} size={PAGE} setPage={setLogPage} /></div>}
      </section>
    </div>
  </div>
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
  return <div className="mb-2 overflow-hidden rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)]">
    <button type="button" onClick={toggle} aria-expanded={open} className="w-full p-3 text-left"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-medium text-[var(--ui-text)]">{turn.legacy ? `${ordered[0].purpose} · ${ordered[0].model}` : `${scene || 'AI 回复'} · ${ordered.length} 次调用`}</p><div className="mt-2 flex flex-wrap gap-1">{ordered.map((trace) => <span key={trace.id} className="rounded-full border border-[var(--ui-border)] bg-[var(--ui-surface)] px-1.5 py-0.5 text-[10px] text-[var(--ui-text-2)]">{trace.stage ? STAGE_LABEL[trace.stage] : trace.purpose}</span>)}</div></div><div className="shrink-0 text-right"><p className="text-[11px] text-[var(--ui-text-3)]">{new Date(turn.createdAt).toLocaleString()}</p>{finalStatus.passed !== undefined && <p className={`mt-1 text-[11px] ${finalStatus.passed ? 'text-[var(--ui-action)]' : 'text-[var(--ui-danger)]'}`}>{finalStatus.passed ? '审核通过' : '审核未通过'}</p>}</div></div></button>
    {open && <div className="space-y-3 border-t border-[var(--ui-border-soft)] bg-[var(--ui-surface)] p-3">{ordered.map((trace, index) => <TraceStep key={trace.id} trace={trace} index={index} />)}</div>}
  </div>
}

function TraceStep({ trace, index }: { trace: AdminAiTrace; index: number }) {
  const isReview = trace.stage === 'first_quality' || trace.stage === 'second_quality' || (!trace.stage && trace.purpose === 'quality')
  const result = isReview ? reviewResult(trace) : {}
  const title = trace.stage ? STAGE_LABEL[trace.stage] : `${trace.purpose} · ${trace.model}`
  return <div className="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-2)] p-2">
    <div className="mb-2 flex items-center justify-between gap-2"><p className="text-xs font-medium text-[var(--ui-text)]">{index + 1}. {title} <span className="font-normal text-[var(--ui-text-3)]">· {trace.model}</span></p>{isReview && result.passed !== undefined && <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${result.passed ? 'bg-[var(--ui-accent-soft)] text-[var(--ui-action)]' : 'bg-[var(--ui-danger-soft)] text-[var(--ui-danger)]'}`}>{result.passed ? '通过' : '未通过'}</span>}</div>
    {result.reason && <p className="mb-2 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)] p-2 text-[11px] text-[var(--ui-text-2)]">审核原因：{result.reason}</p>}
    <details open={trace.stage === 'first_chat' || !trace.stage}><summary className="cursor-pointer text-[11px] text-[var(--ui-text-2)]">输入消息 / Prompt</summary><pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)] p-2 text-[11px] text-[var(--ui-text)]">{trace.messages.map((message) => `[${message.role}]\n${message.content}`).join('\n\n')}</pre></details>
    <details open><summary className="cursor-pointer text-[11px] text-[var(--ui-text-2)]">{trace.error ? '错误' : '模型输出'}</summary><pre className={`mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)] p-2 text-[11px] ${trace.error ? 'text-[var(--ui-danger)]' : 'text-[var(--ui-text)]'}`}>{trace.output || trace.error || '（无输出）'}</pre></details>
    <p className="mt-1 text-right text-[10px] text-[var(--ui-text-3)]">输入 {trace.inputTokens} · 输出 {trace.outputTokens} tokens · {formatDuration(trace.durationMs)}</p>
  </div>
}

function Pager({ page, total, size, setPage }: { page: number; total: number; size: number; setPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size))
  return <div className="mt-3 flex justify-between text-xs text-[var(--ui-text-2)]"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="disabled:text-[var(--ui-text-3)]">上一页</button><span>{page + 1} / {pages}</span><button type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} className="disabled:text-[var(--ui-text-3)]">下一页</button></div>
}
