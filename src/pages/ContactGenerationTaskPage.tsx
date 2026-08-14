import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import type { ContactGenerationTask } from '../types'
import type { PersonaGenerationResult } from '../lib/prompt'
import {
  confirmContactGenerationDraft,
  deleteContactGenerationTask,
  formatContactGenerationDiagnostic,
  pauseContactGenerationTask,
  resumeContactGenerationTask,
} from '../lib/contactGenerationTasks'

const FIELD_LABELS: Record<string, string> = {
  name: '姓名', realName: '真名', nickname: '昵称', gender: '性别', ageRange: '年龄', relationship: '关系定位', occupation: '职业', birthday: '生日', hobbies: '兴趣爱好', persona: '完整人设', speechExamples: '说话示例（将合并进人设）', schedule: '日程安排', avatarKeyword: '头像关键词', monthlySalary: '收入资料',
}

export function ContactGenerationTaskPage() {
  const { taskId = '' } = useParams()
  const navigate = useNavigate()
  const task = useLiveQuery(async () => (await db.contactGenerationTasks.get(taskId)) ?? null, [taskId])
  const [draft, setDraft] = useState<PersonaGenerationResult | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const personaFieldRef = useRef<HTMLTextAreaElement>(null)

  function fitPersonaField() {
    const field = personaFieldRef.current
    if (!field) return
    field.style.height = '0px'
    field.style.height = `${field.scrollHeight}px`
  }

  useLayoutEffect(() => {
    fitPersonaField()
  }, [draft?.persona])

  useEffect(() => {
    if (task?.status === 'awaiting_review' && task.personaDraft) setDraft(structuredClone(task.personaDraft))
  }, [task?.id, task?.status, task?.personaDraft])

  if (task === undefined) {
    return <div className="ui-page"><TopBar title="生成任务" showBack/><div className="flex flex-1 items-center justify-center text-sm text-[var(--ui-text-3)]">正在读取任务…</div></div>
  }
  if (task === null) {
    return <div className="ui-page"><TopBar title="生成任务" showBack/><div className="flex flex-1 flex-col items-center justify-center px-6 text-center"><p className="text-sm text-[var(--ui-text-3)]">这个任务已完成或不存在</p><button type="button" onClick={() => navigate('/contacts')} className="ui-primary-action mt-4 px-5 py-2.5 text-sm">返回联系人</button></div></div>
  }
  const currentTask = task

  const immersive = task.experienceMode === 'immersive'
  const fields = Object.entries(task.partialFields ?? {}).filter(([key]) => FIELD_LABELS[key])
  const active = ['queued', 'preparing', 'retrieving_context', 'extracting_canon', 'generating', 'validating', 'fetching_avatar', 'committing'].includes(task.status)

  async function copyDiagnostic(current: ContactGenerationTask) {
    const text = formatContactGenerationDiagnostic(current)
    try { await navigator.clipboard.writeText(text); setCopyStatus('故障信息已复制') }
    catch { setCopyStatus('复制失败，请检查剪贴板权限') }
  }

  async function confirmDraft() {
    if (!draft) return
    await confirmContactGenerationDraft(currentTask.id, draft)
    void navigate('/contacts')
  }

  async function cancelAndReturn() {
    // Android WebView can retain a native input/keyboard session for a short
    // time when navigation races an in-flight request. Release it before the
    // route changes; otherwise the next form can receive taps but fail to
    // summon its keyboard until WebView eventually cleans the session up.
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement) activeElement.blur()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await deleteContactGenerationTask(currentTask.id)
    void navigate('/contacts')
  }

  return (
    <div className="ui-page">
      <TopBar title={immersive ? '寻找联系人' : task.method === 'precision' ? '精细创建 · 女娲模式' : '联系人生成'} showBack />
      <div className="ui-page-scroll px-3 pt-3">
        <section className="ui-section-card ui-section-flush">
          <div className="flex items-center gap-3">
            <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${task.status === 'failed' ? 'bg-red-50 text-red-500' : task.status === 'awaiting_review' ? 'bg-green-50 text-green-600' : 'bg-[var(--ui-special-soft)] text-[var(--ui-special-ink)]'}`}>{task.status === 'failed' ? '!' : task.status === 'awaiting_review' ? '✓' : '◌'}</div>
            <div className="min-w-0 flex-1"><h2 className="text-base font-medium text-gray-900">{task.stageLabel}</h2><p className="mt-0.5 text-xs text-gray-400">任务 {task.id.slice(0, 8)} · 第 {Math.max(1, task.attempt)} 次尝试</p></div>
          </div>
          {active && <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-gray-100"><div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--ui-special)]" /></div>}
        </section>

        {!immersive && active && (task.generationActivity?.length ?? 0) > 0 && (
          <section className="mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] p-4 shadow-[var(--ui-shadow)]">
            <h3 className="text-sm font-medium text-gray-900">生成过程</h3>
            <div className="mt-3 space-y-2">
              {task.generationActivity!.slice(-6).map((item, index, rows) => (
                <p key={`${item}-${index}`} className={`text-xs ${index === rows.length - 1 ? 'text-[var(--ui-special-ink)]' : 'text-gray-400'}`}>
                  {index === rows.length - 1 ? '●' : '✓'} {item}
                </p>
              ))}
            </div>
          </section>
        )}

        {!immersive && fields.length > 0 && task.status !== 'awaiting_review' && (
          <section className="mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] p-4 shadow-[var(--ui-shadow)]">
            <h3 className="text-sm font-medium text-gray-900">已经生成的内容</h3>
            <div className="mt-3 space-y-3">{fields.map(([key, value]) => <div key={key}><p className="text-xs text-green-600">✓ {FIELD_LABELS[key]}</p><p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{previewValue(value)}</p></div>)}</div>
          </section>
        )}

        {immersive && active && (
          <section className="mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] p-4 text-sm text-[var(--ui-text-2)] shadow-[var(--ui-shadow)]">
            <p>✓ 已确认你的寻找偏好</p>
            <p className="mt-2 text-[var(--ui-special-ink)]">● {task.stageLabel}</p>
            <p className="mt-2 text-gray-300">○ 正在确认是否适合认识</p>
          </section>
        )}

        {task.status === 'awaiting_review' && draft && (
          <section className="mt-3 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] p-4 shadow-[var(--ui-shadow)]">
            <div className="mb-3"><h3 className="text-base font-medium text-gray-900">AI人设初稿</h3><p className="mt-1 text-xs text-gray-400">初稿已完成。你可以二次修改，确认后联系人正式上线。</p></div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-gray-500">姓名<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" /></label>
            </div>
            <div className="mt-3 rounded-lg border border-gray-200 px-3 py-3">
              <div className="flex items-center justify-between"><label className="text-xs text-gray-500">初始好感度</label><input aria-label="女娲好感度数值" type="number" min="-100" max="100" value={draft.initialWarmth ?? 0} onChange={(event) => setDraft({ ...draft, initialWarmth: Math.max(-100, Math.min(100, Number(event.target.value) || 0)) })} className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-center text-sm" /></div>
              <input aria-label="女娲好感度" type="range" min="-100" max="100" value={draft.initialWarmth ?? 0} onChange={(event) => setDraft({ ...draft, initialWarmth: Number(event.target.value) })} className="mt-2 w-full accent-[var(--ui-special)]" />
            </div>
            <label className="mt-3 block text-xs text-gray-500">完整人设<textarea ref={personaFieldRef} value={draft.persona} onInput={fitPersonaField} onChange={(event) => setDraft({ ...draft, persona: event.target.value })} rows={1} className="mt-1 w-full resize-none overflow-hidden rounded-lg border border-gray-200 px-3 py-2 text-sm leading-relaxed" /></label>
            <button onClick={() => void confirmDraft()} disabled={!draft.name.trim() || !draft.persona.trim()} className="mt-4 w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-40">确认修改并创建联系人</button>
          </section>
        )}

        {task.error && (
          <section className="mt-3 rounded-[var(--ui-radius-card)] border border-[var(--ui-danger)] bg-[var(--ui-surface)] p-4 shadow-[var(--ui-shadow)]">
            <h3 className="text-sm font-medium text-red-600">{task.error.message}</h3>
            <p className="mt-2 text-xs leading-relaxed text-gray-500">失败阶段：{task.error.stage}<br/>错误代码：{task.error.code}<br/>技术原因：{task.error.technicalMessage}</p>
            {task.error.validation && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700">
              <p className="font-medium">检测结果{task.error.validation.repairAttempted ? '（已尝试自动修复）' : ''}</p>
              <ul className="mt-1 list-disc pl-4">{task.error.validation.issues.map((issue, index) => <li key={`${issue.code}-${issue.field ?? index}`}>{issue.message}</li>)}</ul>
              {task.error.validation.repair && <><p className="mt-2 font-medium">自动修复后</p><ul className="mt-1 list-disc pl-4">{task.error.validation.repair.issues.map((issue, index) => <li key={`${issue.code}-${issue.field ?? index}`}>{issue.message}</li>)}</ul></>}
              {task.error.failedFields?.length ? <p className="mt-2">受影响字段：{task.error.failedFields.join('、')}</p> : null}
              <p className="mt-2 text-red-600/80">建议：{task.error.code === 'PERSONA_JSON_TRUNCATED' ? '精简世界书或附加设定后重试。' : task.error.code === 'PERSONA_EMPTY_OUTPUT' ? '重试；若持续发生，请更换模型或检查模型服务。' : '可直接重试；持续发生时请复制故障信息。'}</p>
            </div>}
            <div className="mt-3 grid grid-cols-2 gap-2">
              {task.error.retryable && <button onClick={() => void resumeContactGenerationTask(task.id)} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white">重试当前步骤</button>}
              <button onClick={() => void copyDiagnostic(task)} className="rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700">复制故障信息</button>
            </div>
            {copyStatus && <p className="mt-2 text-xs text-gray-400">{copyStatus}</p>}
          </section>
        )}

        {(active || task.status === 'paused' || task.status === 'failed') && <button onClick={() => { if (window.confirm('确定取消并删除这个生成任务吗？')) void cancelAndReturn() }} className="mt-4 w-full rounded-lg bg-white py-2.5 text-sm text-red-500">取消并删除任务</button>}
        {active && <button onClick={() => void pauseContactGenerationTask(task.id)} className="mt-2 w-full py-2 text-xs text-gray-400">暂停当前任务</button>}
      </div>
    </div>
  )
}

function previewValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('、')
  return JSON.stringify(value, null, 2)
}
