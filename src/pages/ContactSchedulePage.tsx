import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useParams } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { DAY_TYPE_LABELS, upcomingTasks } from '../lib/schedule'
import { locationLabel } from '../lib/locations'
import type { ScheduleTask } from '../types'

export function ContactSchedulePage() {
  const { contactId } = useParams()
  const [adding, setAdding] = useState(false)
  const [date, setDate] = useState('')
  const [startTime, setStartTime] = useState('20:00')
  const [endTime, setEndTime] = useState('22:00')
  const [locationId, setLocationId] = useState('')
  const [label, setLabel] = useState('')

  const contact = useLiveQuery(() => (contactId ? db.contacts.get(contactId) : undefined), [contactId])
  const locations = useLiveQuery(() => db.locations.toArray(), []) ?? []
  const locationById = new Map(locations.map((l) => [l.id, l]))
  const tasks =
    useLiveQuery(
      () =>
        contactId
          ? db.tasks.where('contactId').equals(contactId).toArray()
          : Promise.resolve([] as ScheduleTask[]),
      [contactId],
    ) ?? []
  const upcoming = upcomingTasks(tasks, new Date())

  if (!contact) return null

  async function handleAddTask() {
    if (!contactId || !date || !locationId || !label.trim()) return
    await db.tasks.add({
      id: uuid(),
      contactId,
      date,
      startTime,
      endTime,
      locationId,
      label: label.trim(),
      createdAt: Date.now(),
      source: 'user',
    })
    setAdding(false)
    setDate('')
    setLabel('')
  }

  return (
    <div className="relative flex min-h-full flex-col bg-[#f4f4f6]">
      <TopBar title="日程与约会" showBack />

      <section className="mt-3 bg-white px-4 py-4">
        <h3 className="mb-2 text-xs font-medium text-gray-400">日常routine</h3>
        {contact.dailySchedule.length === 0 ? (
          <p className="text-sm text-gray-400">还没有日程安排</p>
        ) : (
          <div className="space-y-2">
            {contact.dailySchedule.map((b) => (
              <div key={b.id} className="flex items-center gap-2 text-sm text-gray-700">
                <span className="w-12 shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-center text-[10px] text-gray-500">
                  {DAY_TYPE_LABELS[b.dayType]}
                </span>
                <span className="w-24 shrink-0 text-xs text-gray-400">
                  {b.startTime}-{b.endTime}
                </span>
                <span>{locationLabel(locationById.get(b.locationId))}</span>
                {b.label && <span className="text-xs text-gray-400">· {b.label}</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-3 flex-1 bg-white px-4 py-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-medium text-gray-400">约好的安排（会覆盖日常routine）</h3>
          <button onClick={() => setAdding(true)} className="text-xs text-[#aa3bff]">
            + 添加
          </button>
        </div>
        {upcoming.length === 0 ? (
          <p className="text-sm text-gray-400">暂时没有约定的安排</p>
        ) : (
          <div className="space-y-2">
            {upcoming.map((t) => (
              <div key={t.id} className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{t.label}</span>
                  <span className="text-xs text-gray-400">{t.source === 'ai' ? 'TA提议的' : '我安排的'}</span>
                </div>
                <p className="mt-0.5 text-xs text-gray-400">
                  {t.date} {t.startTime}-{t.endTime} · {locationLabel(locationById.get(t.locationId))}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {adding && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-6">
          <div className="w-full rounded-2xl bg-white p-4">
            <h2 className="mb-3 text-center text-[15px] font-medium text-gray-900">添加一个约定</h2>

            <label className="mb-1 block text-xs text-gray-400">日期</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />

            <div className="mb-3 flex gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-xs text-gray-400">开始</label>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs text-gray-400">结束</label>
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                />
              </div>
            </div>

            <label className="mb-1 block text-xs text-gray-400">地点</label>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            >
              <option value="">选择地点</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.icon} {l.name}
                </option>
              ))}
            </select>

            <label className="mb-1 block text-xs text-gray-400">备注</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="比如 一起看电影"
              className="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />

            <div className="flex gap-2">
              <button
                onClick={() => setAdding(false)}
                className="flex-1 rounded-lg bg-gray-100 py-2 text-sm text-gray-600"
              >
                取消
              </button>
              <button
                onClick={handleAddTask}
                disabled={!date || !locationId || !label.trim()}
                className="flex-1 rounded-lg bg-gray-900 py-2 text-sm text-white disabled:opacity-40"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
