import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { ChevronLeft, ChevronRight, Phone, PhoneOff } from 'lucide-react'
import { db } from '../db/db'
import { chatCompletionText } from '../lib/deepseek'
import { syncContactLocationAt } from '../lib/locations'
import { defaultTasksOverlappingRange, normalizeScheduleBlock, scheduleOccurrencesForDate, specialTaskRange } from '../lib/schedule'
import { buildScheduleOptimizationPrompt, parseOptimizedSchedule, scheduleDistributionIssue } from '../lib/scheduleOptimization'
import type { AppSettings, Contact, ContactMemory, LocationNode, ScheduleBlock, ScheduleOverride } from '../types'

const HOUR_HEIGHT = 22
const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const EMPTY_LOCATIONS: LocationNode[] = []
type Target = { kind: 'default'; task: ScheduleBlock } | { kind: 'special'; task: ScheduleOverride } | { kind: 'create'; startsAt: number }

function monday(date: Date) { const value = new Date(date.getFullYear(), date.getMonth(), date.getDate()); value.setDate(value.getDate() - ((value.getDay() + 6) % 7)); return value }
function sameDay(a: Date, b: Date) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate() }
function dateInputValue(timestamp: number) { const date = new Date(timestamp); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
function timeInputValue(timestamp: number) { const date = new Date(timestamp); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` }
function tone(activity: string, location: string, special: boolean) { if (special) return 'special'; const text = `${activity} ${location}`; if (/睡觉|休息|午休|补觉/.test(text)) return 'rest'; if (/上班|工作|会议|汇报|课程|上课|公司|办公室|学校|教室/.test(text)) return 'work'; return 'personal' }
function titleSize(title: string, height: number) { return Math.max(8, Math.min(15, Math.floor(Math.sqrt((34 * Math.max(height - 8, 12)) / Math.max(title.length, 1) / 1.25)))) }

export function SchedulePlanner({ contact, settings, memories }: { contact: Contact; settings: AppSettings; memories: ContactMemory[] }) {
  const [weekStart, setWeekStart] = useState(() => monday(new Date()))
  const [now, setNow] = useState(() => new Date())
  const [editing, setEditing] = useState<Target | null>(null)
  const [pendingSlot, setPendingSlot] = useState<{ day: number; minute: number } | null>(null)
  const [error, setError] = useState('')
  const [optimizing, setOptimizing] = useState(false)
  const [candidate, setCandidate] = useState<ScheduleBlock[] | null>(null)
  const locations = useLiveQuery(() => db.locations.toArray(), []) ?? EMPTY_LOCATIONS
  const leafLocations = useMemo(() => locations.filter((location) => !locations.some((candidate) => candidate.parentId === location.id)), [locations])

  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(timer) }, [])
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => { const value = new Date(weekStart); value.setDate(weekStart.getDate() + index); return value }), [weekStart])
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const title = `${weekStart.getMonth() + 1}月 · 第${Math.ceil((weekStart.getDate() + ((new Date(weekStart.getFullYear(), weekStart.getMonth(), 1).getDay() + 6) % 7)) / 7)}周`

  async function optimize() {
    if (!settings.apiKey) { setError('请先在设置中填写 AI Key'); return }
    setError(''); setOptimizing(true)
    try {
      if (!leafLocations.length) throw new Error('请先在地点地图中创建可选的具体地点')
      const prompt = buildScheduleOptimizationPrompt(contact, memories, leafLocations, new Date())
      const requestOptimization = (instruction: string) => chatCompletionText({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, provider: settings.aiProvider, model: settings.utilityModel || settings.model, purpose: 'persona', jsonMode: true, temperature: 0.2, maxTokens: 3000, messages: [{ role: 'system', content: prompt }, { role: 'user', content: instruction }] })
      let raw = await requestOptimization('请生成优化后的固定周日程。不要原样复述现有日程，优先让安排合理分散到一周。')
      let optimized = parseOptimizedSchedule(raw, leafLocations)
      const distributionIssue = scheduleDistributionIssue(optimized)
      if (distributionIssue) {
        raw = await requestOptimization(`上一版候选不合格：${distributionIssue}。请重新生成一份分散、可执行的固定周日程；不得照抄或只把原日程集中在同一天。上一版候选：${JSON.stringify(optimized)}`)
        optimized = parseOptimizedSchedule(raw, leafLocations)
      }
      setCandidate(optimized)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '日程优化失败') } finally { setOptimizing(false) }
  }
  async function applyCandidate() { if (!candidate) return; await db.contacts.update(contact.id, { schedule: candidate }); await syncContactLocationAt(contact.id); setCandidate(null) }

  return <section className="mx-3 mt-4 rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] px-4 py-4 shadow-[var(--ui-shadow)]">
    <div className="mb-2 flex items-center justify-between gap-2"><div className="flex items-center gap-2"><h3 className="text-xs font-medium text-gray-400">日程表</h3><button type="button" onClick={() => void optimize()} disabled={optimizing} className="rounded-lg bg-gray-100 px-2 py-1 text-[11px] text-gray-700 disabled:opacity-50">{optimizing ? '优化中…' : 'AI 优化'}</button></div><div className="flex items-center gap-1 text-xs text-gray-600"><button type="button" aria-label="上一周" onClick={() => setWeekStart((value) => new Date(value.getFullYear(), value.getMonth(), value.getDate() - 7))} className="flex h-7 w-7 items-center justify-center rounded-md border border-gray-200"><ChevronLeft size={16} /></button><span className="min-w-20 text-center font-medium">{title}</span><button type="button" aria-label="下一周" onClick={() => setWeekStart((value) => new Date(value.getFullYear(), value.getMonth(), value.getDate() + 7))} className="flex h-7 w-7 items-center justify-center rounded-md border border-gray-200"><ChevronRight size={16} /></button></div></div>
    {error && <p className="mb-2 text-xs text-red-500">{error}</p>}
    <div className="schedule-week-scroll" aria-label="周日程时间轴"><div className="schedule-week-header"><span />{days.map((day, index) => <span key={day.getTime()} className={sameDay(day, today) ? 'schedule-week-today' : ''}>{DAY_NAMES[index]}<b>{day.getDate()}</b></span>)}</div><div className="schedule-week-body"><div className="schedule-week-hours">{Array.from({ length: 13 }, (_, index) => index * 2).map((hour) => <span key={hour} style={{ top: hour * HOUR_HEIGHT }}>{hour === 24 ? '23:59' : `${String(hour).padStart(2, '0')}:00`}</span>)}</div>{days.map((day) => <DayColumn key={day.getTime()} contact={contact} day={day} now={now} isToday={sameDay(day, today)} onEdit={setEditing} pendingMinute={pendingSlot?.day === day.getTime() ? pendingSlot.minute : null} onPickSlot={(minute) => setPendingSlot({ day: day.getTime(), minute })} onCreate={(minute) => { const startsAt = new Date(day); startsAt.setHours(Math.floor(minute / 60), minute % 60, 0, 0); setEditing({ kind: 'create', startsAt: startsAt.getTime() }); setPendingSlot(null) }} />)}</div></div>
    <div className="schedule-week-legend" data-ui-scope="special"><span><i className="schedule-week-swatch schedule-week-swatch--work" />绿色：工作/学习</span><span><i className="schedule-week-swatch schedule-week-swatch--personal" />紫色：个人安排</span><span><i className="schedule-week-swatch schedule-week-swatch--rest" />蓝灰：休息</span><span><i className="schedule-week-swatch schedule-week-swatch--special" />金色：特殊安排</span><span><i className="schedule-week-swatch schedule-week-swatch--current" />红色：当前进行中</span></div>
    {editing && <Editor contact={contact} target={editing} locations={leafLocations} onClose={() => setEditing(null)} />}
    {candidate && <Preview candidate={candidate} onCancel={() => setCandidate(null)} onApply={() => void applyCandidate()} />}
  </section>
}

function DayColumn({ contact, day, now, isToday, onEdit, pendingMinute, onPickSlot, onCreate }: { contact: Contact; day: Date; now: Date; isToday: boolean; onEdit: (target: Target) => void; pendingMinute: number | null; onPickSlot: (minute: number) => void; onCreate: (minute: number) => void }) {
  function pickSlot(event: React.MouseEvent<HTMLDivElement>) { if (event.target !== event.currentTarget) return; const rect = event.currentTarget.getBoundingClientRect(); const rawMinute = (event.clientY - rect.top) / rect.height * 24 * 60; onPickSlot(Math.max(0, Math.min(23 * 60 + 45, Math.round(rawMinute / 15) * 15))) }
  return <div className="schedule-week-day" onClick={pickSlot}>{scheduleOccurrencesForDate(contact, day).map((occurrence) => { const duration = occurrence.endsAt - occurrence.startsAt; const active = now.getTime() >= occurrence.startsAt && now.getTime() < occurrence.endsAt; const task = occurrence.task; const height = Math.max(duration / 3_600_000 * HOUR_HEIGHT - 2, 9); return <button type="button" key={occurrence.id} onClick={(event) => { event.stopPropagation(); onEdit(occurrence.kind === 'special' ? { kind: 'special', task: task as ScheduleOverride } : { kind: 'default', task: task as ScheduleBlock }) }} data-ui-scope="special" className={`schedule-week-event schedule-week-event--${active ? 'current' : tone(task.activity, task.location, occurrence.kind === 'special')}`} style={{ top: (new Date(occurrence.startsAt).getHours() * 60 + new Date(occurrence.startsAt).getMinutes()) / 60 * HOUR_HEIGHT + 1, height }} aria-label={`编辑 ${task.activity}`}>{duration >= 40 * 60_000 && <span className="schedule-week-event-title" style={{ fontSize: titleSize(task.activity, height) }}>{task.activity}</span>}{duration >= 20 * 60_000 && <span className="schedule-week-event-phone">{task.phoneAccess === 'available' ? <Phone size={11} /> : <PhoneOff size={11} />}</span>}</button> })}{pendingMinute !== null && <button type="button" onClick={(event) => { event.stopPropagation(); onCreate(pendingMinute) }} className="schedule-week-add" style={{ top: pendingMinute / 60 * HOUR_HEIGHT }} aria-label="在此时间新建日程">+</button>}{isToday && <span className="schedule-week-now" style={{ top: (now.getHours() * 60 + now.getMinutes()) / 60 * HOUR_HEIGHT }}><i /></span>}</div>
}

function Editor({ contact, target, locations, onClose }: { contact: Contact; target: Target; locations: LocationNode[]; onClose: () => void }) {
  const creating = target.kind === 'create'
  const special = target.kind === 'special' || creating
  const task: ScheduleBlock | ScheduleOverride = creating ? { id: uuid(), date: dateInputValue(target.startsAt), startHour: new Date(target.startsAt).getHours(), endHour: Math.min(24, new Date(target.startsAt).getHours() + 1), phoneAccess: 'available', location: '', activity: '', summary: '', priority: 'special', status: 'scheduled', startsAt: target.startsAt, endsAt: Math.min(target.startsAt + 60 * 60 * 1000, new Date(target.startsAt).setHours(24, 0, 0, 0)), createdAt: Date.now() } : target.task
  const specialTask = task as ScheduleOverride
  const defaultTask = task as ScheduleBlock
  const startsAt = special ? (specialTask.startsAt ?? new Date(`${specialTask.date}T${String(specialTask.startHour).padStart(2, '0')}:00`).getTime()) : 0
  const endsAt = special ? (specialTask.endsAt ?? new Date(`${specialTask.date}T${String(specialTask.endHour).padStart(2, '0')}:00`).getTime()) : 0
  const [activity, setActivity] = useState(task.activity); const [locationId, setLocationId] = useState(task.locationId ?? ''); const [phoneAccess, setPhoneAccess] = useState(task.phoneAccess)
  const [day, setDay] = useState(special ? specialTask.date : String(defaultTask.dayOfWeek)); const [start, setStart] = useState(special ? `${dateInputValue(startsAt)}T${timeInputValue(startsAt)}` : String(defaultTask.startHour)); const [end, setEnd] = useState(special ? `${dateInputValue(endsAt)}T${timeInputValue(endsAt)}` : String(defaultTask.endHour)); const [error, setError] = useState('')
  async function save() {
    const location = locations.find((item) => item.id === locationId)
    if (!location) { setError('请选择地图中的具体地点'); return }
    if (creating) {
      const startAt = new Date(start).getTime(); const endAt = new Date(end).getTime()
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt || endAt - startAt > 24 * 60 * 60 * 1000) { setError('结束时间需要晚于开始时间，且不超过 24 小时'); return }
      const next: ScheduleOverride = { ...specialTask, date: dateInputValue(startAt), startHour: new Date(startAt).getHours(), endHour: new Date(endAt).getHours() || 24, startsAt: startAt, endsAt: endAt, activity: activity.trim().slice(0, 16), location: location.name, locationId: location.id, phoneAccess, summary: activity.trim().slice(0, 40), cancelledDefaultTaskIds: defaultTasksOverlappingRange(contact, startAt, endAt).map((item) => item.id) }
      if (!next.activity) { setError('请填写活动'); return }
      const retained = (contact.scheduleOverrides ?? []).filter((item) => { const range = specialTaskRange(item); return item.status === 'cancelled' || range.endsAt <= startAt || range.startsAt >= endAt })
      await db.contacts.update(contact.id, { scheduleOverrides: [...retained, next] })
      await syncContactLocationAt(contact.id); onClose(); return
    }
    if (special) {
      const startAt = new Date(start).getTime(); const endAt = new Date(end).getTime()
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt || endAt - startAt > 24 * 60 * 60 * 1000) { setError('结束时间需要晚于开始时间，且不超过 24 小时'); return }
      const next: ScheduleOverride = { ...specialTask, date: dateInputValue(startAt), startHour: new Date(startAt).getHours(), endHour: new Date(endAt).getHours() || 24, startsAt: startAt, endsAt: endAt, activity: activity.trim().slice(0, 16), location: location.name, locationId: location.id, phoneAccess, summary: activity.trim().slice(0, 40) }
      if (!next.activity) { setError('请填写活动'); return }
      await db.contacts.update(contact.id, { scheduleOverrides: (contact.scheduleOverrides ?? []).map((item) => item.id === task.id ? next : item) })
    } else {
      const next = normalizeScheduleBlock({ dayOfWeek: Number(day), startHour: Number(start), endHour: Number(end), activity, location: location.name, locationId: location.id, phoneAccess }, task.id)
      if (!next) { setError('请检查时间和活动'); return }
      await db.contacts.update(contact.id, { schedule: (contact.schedule ?? []).map((item) => item.id === task.id ? next : item) })
    }
    await syncContactLocationAt(contact.id); onClose()
  }
  async function remove() { if (!special) return; await db.contacts.update(contact.id, { scheduleOverrides: (contact.scheduleOverrides ?? []).filter((item) => item.id !== task.id) }); await syncContactLocationAt(contact.id); onClose() }
  return <div className="absolute inset-0 z-40 flex items-end bg-black/40" onClick={onClose}><div className="max-h-[88%] w-full overflow-y-auto rounded-t-2xl bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]" onClick={(event) => event.stopPropagation()}><h3 className="text-base font-medium text-gray-900">编辑{special ? '特殊安排' : '固定日程'}</h3><div className="mt-3 space-y-3 text-sm"><label className="block">活动<input value={activity} maxLength={16} onChange={(event) => setActivity(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2" /></label><label className="block">地点<select value={locationId} onChange={(event) => setLocationId(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2"><option value="">请选择地图地点</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>{special ? <><label className="block">开始<input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2" /></label><label className="block">结束<input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2" /></label></> : <div className="grid grid-cols-3 gap-2"><label>星期<select value={day} onChange={(event) => setDay(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2">{['周日','周一','周二','周三','周四','周五','周六'].map((name, index) => <option key={name} value={index}>{name}</option>)}</select></label><label>开始<select value={start} onChange={(event) => setStart(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2">{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select></label><label>结束<select value={end} onChange={(event) => setEnd(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2">{Array.from({ length: 24 }, (_, index) => index + 1).map((hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select></label></div>}<label className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">可以接电话<select value={phoneAccess} onChange={(event) => setPhoneAccess(event.target.value as 'available' | 'unavailable')} className="bg-transparent text-sm"><option value="available">可以</option><option value="unavailable">不方便</option></select></label>{error && <p className="text-xs text-red-500">{error}</p>}<div className="flex gap-2"><button type="button" onClick={onClose} className="flex-1 rounded-xl bg-gray-100 py-2.5 text-sm text-gray-700">取消</button>{special && <button type="button" onClick={() => void remove()} className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-500">删除</button>}<button type="button" onClick={() => void save()} className="flex-1 rounded-xl bg-gray-900 py-2.5 text-sm text-white">保存</button></div></div></div></div>
}

function Preview({ candidate, onCancel, onApply }: { candidate: ScheduleBlock[]; onCancel: () => void; onApply: () => void }) { return <div className="absolute inset-0 z-40 flex items-end bg-black/40" onClick={onCancel}><div className="w-full rounded-t-2xl bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]" onClick={(event) => event.stopPropagation()}><h3 className="text-base font-medium text-gray-900">确认 AI 优化日程</h3><p className="mt-1 text-xs text-gray-400">将替换固定周日程；特殊安排保持不变。</p><div className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-700">{candidate.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startHour - b.startHour).map((task) => <p key={task.id}>{['周日','周一','周二','周三','周四','周五','周六'][task.dayOfWeek]} {String(task.startHour).padStart(2, '0')}:00–{String(task.endHour).padStart(2, '0')}:00　{task.activity} · {task.location}</p>)}</div><div className="mt-3 flex gap-2"><button type="button" onClick={onCancel} className="flex-1 rounded-xl bg-gray-100 py-2.5 text-sm text-gray-700">取消</button><button type="button" onClick={onApply} className="flex-1 rounded-xl bg-gray-900 py-2.5 text-sm text-white">应用</button></div></div></div> }
