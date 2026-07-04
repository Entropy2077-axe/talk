import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'

export function MapPage() {
  const locations = useLiveQuery(() => db.locations.toArray(), []) ?? []
  const { userLocationId, setSettings } = useSettingsStore()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('📍')

  async function handleAdd() {
    const trimmed = name.trim()
    if (!trimmed) return
    const exists = await db.locations.where('name').equals(trimmed).count()
    if (exists > 0) return
    await db.locations.add({ id: uuid(), name: trimmed, icon: icon.trim() || '📍', isPreset: false })
    setName('')
    setIcon('📍')
    setAdding(false)
  }

  return (
    <div className="flex min-h-full flex-col bg-[#f4f4f6]">
      <TopBar title="地图" showBack />

      <div
        className="mx-4 mt-3 rounded-2xl p-4"
        style={{
          backgroundImage:
            'radial-gradient(circle at 20% 20%, #f0e6ff 0, transparent 45%), radial-gradient(circle at 80% 70%, #e6f4ff 0, transparent 45%)',
          backgroundColor: '#fafafa',
        }}
      >
        <p className="mb-3 text-xs text-gray-400">点一个地点 把自己"传送"过去 联系人可以约你在这里见面</p>
        <div className="grid grid-cols-3 gap-3">
          {locations.map((loc) => {
            const active = loc.id === userLocationId
            return (
              <button
                key={loc.id}
                onClick={() => setSettings({ userLocationId: loc.id })}
                className={`flex flex-col items-center gap-1 rounded-xl border p-3 ${
                  active ? 'border-[#aa3bff] bg-[#aa3bff]/10' : 'border-gray-100 bg-white'
                }`}
              >
                <span className="text-2xl">{loc.icon}</span>
                <span className="truncate text-xs text-gray-700">{loc.name}</span>
                {active && <span className="text-[10px] text-[#aa3bff]">我在这</span>}
              </button>
            )
          })}
          <button
            onClick={() => setAdding(true)}
            className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-gray-300 p-3 text-gray-400"
          >
            <span className="text-2xl">＋</span>
            <span className="text-xs">添加地点</span>
          </button>
        </div>
      </div>

      {adding && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-8">
          <div className="w-full rounded-2xl bg-white p-4">
            <h2 className="mb-3 text-center text-[15px] font-medium text-gray-900">添加自定义地点</h2>
            <label className="mb-1 block text-xs text-gray-400">图标（emoji）</label>
            <input
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              maxLength={4}
              className="mb-3 w-20 rounded-lg border border-gray-200 px-3 py-2 text-center text-2xl"
            />
            <label className="mb-1 block text-xs text-gray-400">地点名字</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="比如 楼下奶茶店"
              maxLength={16}
              className="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setAdding(false)}
                className="flex-1 rounded-lg bg-gray-100 py-2 text-sm text-gray-600"
              >
                取消
              </button>
              <button onClick={handleAdd} className="flex-1 rounded-lg bg-gray-900 py-2 text-sm text-white">
                添加
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
