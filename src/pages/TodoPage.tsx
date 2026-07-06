import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { formatCurrency } from '../lib/wallet'
import type { Todo } from '../types'

const EMPTY_ARRAY: never[] = []

export function TodoPage() {
  const todos = useLiveQuery(() => db.todos.orderBy('createdAt').reverse().toArray(), []) ?? EMPTY_ARRAY
  const settings = useSettingsStore()
  const [newTitle, setNewTitle] = useState('')

  async function addTodo() {
    const title = newTitle.trim()
    if (!title) return
    await db.todos.add({ id: uuid(), title, done: false, createdAt: Date.now() })
    setNewTitle('')
  }

  async function toggleTodo(todo: Todo) {
    await db.todos.update(todo.id, { done: !todo.done, completedAt: !todo.done ? Date.now() : undefined })
  }

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="待办" right={<span className="pr-1 text-sm text-gray-500">{formatCurrency(settings.walletBalance, settings)}</span>} />
      <div className="flex-1 overflow-y-auto">

      <section className="mt-3 bg-white px-4 py-4">
        <h2 className="mb-2 text-xs font-medium text-gray-400">我的待办</h2>
        <div className="mb-3 flex gap-2">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTodo()
              }
            }}
            placeholder="添加一条待办"
            className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
          <button onClick={addTodo} className="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white">
            添加
          </button>
        </div>
        {todos.length === 0 ? (
          <p className="text-sm text-gray-400">还没有待办事项</p>
        ) : (
          <div className="space-y-1">
            {todos.map((t) => (
              <div key={t.id} className="flex items-center gap-2 rounded-lg px-1 py-1.5">
                <button
                  onClick={() => toggleTodo(t)}
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                    t.done ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300'
                  }`}
                >
                  {t.done && '✓'}
                </button>
                <span className={`flex-1 text-sm ${t.done ? 'text-gray-300 line-through' : 'text-gray-800'}`}>
                  {t.title}
                </span>
                <button onClick={() => db.todos.delete(t.id)} className="text-xs text-gray-300">
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      </div>
    </div>
  )
}
