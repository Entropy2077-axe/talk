import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { TopBar } from '../components/TopBar'
import { db } from '../db/db'
import { deleteSaveSlot, loadSaveSlot, writeSaveSlot } from '../lib/saveSlots'

export function SaveLoadPage() {
  const saves = useLiveQuery(() => db.saveSlots.toArray(), []) ?? []
  const [page, setPage] = useState(0); const [busy, setBusy] = useState<number | null>(null); const [message, setMessage] = useState('')
  const bySlot = new Map(saves.map((save) => [save.slot, save]))
  const slots = Array.from({ length: 5 }, (_, index) => page * 5 + index + 1)
  async function saveSlot(slot: number) { const current = bySlot.get(slot); const name = window.prompt('存档名称', current?.name ?? `存档 ${slot}`); if (name === null) return; setBusy(slot); try { await writeSaveSlot(slot, name); setMessage('存档完成') } catch (e) { setMessage(String(e)) } finally { setBusy(null) } }
  async function loadSlot(slot: number) { if (!window.confirm('回档会覆盖当前所有业务数据和设置，确定继续吗？')) return; setBusy(slot); try { await loadSaveSlot(slot); setMessage('回档完成') } catch (e) { setMessage(String(e)) } finally { setBusy(null) } }
  return <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]"><TopBar title="存档与回档" showBack /><div className="flex-1 overflow-y-auto p-4"><p className="mb-3 text-xs text-gray-400">存档仅保存在本机，包含全部设置与 API Key。</p><div className="space-y-3">{slots.map((slot) => { const save = bySlot.get(slot); return <div key={slot} className="rounded-xl bg-white p-3"><div className="flex justify-between"><b className="text-sm">#{slot} {save?.name ?? '空存档'}</b>{save && <span className="text-[11px] text-gray-400">{new Date(save.updatedAt).toLocaleString()}</span>}</div><div className="mt-3 flex gap-2"><button type="button" onClick={() => void saveSlot(slot)} disabled={busy === slot} className="flex-1 rounded-lg bg-gray-900 py-2 text-sm text-white">{save ? '覆盖存档' : '创建存档'}</button>{save && <><button type="button" onClick={() => void loadSlot(slot)} disabled={busy === slot} className="flex-1 rounded-lg bg-green-600 py-2 text-sm text-white">回档</button><button type="button" onClick={() => void deleteSaveSlot(slot)} className="rounded-lg bg-red-50 px-3 text-sm text-red-500">删</button></>}</div></div>})}</div><div className="mt-4 flex items-center justify-between"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="text-sm disabled:text-gray-300">上一页</button><span className="text-xs text-gray-400">{page + 1} / 20</span><button type="button" disabled={page === 19} onClick={() => setPage(page + 1)} className="text-sm disabled:text-gray-300">下一页</button></div>{message && <p className="mt-3 text-center text-xs text-gray-500">{message}</p>}</div></div>
}
