import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { displayName } from '../lib/contact'
import { formatCurrency } from '../lib/wallet'
import { triggerAiTurn } from '../lib/chatEngine'
import type { Todo } from '../types'

const EMPTY_ARRAY: never[] = []

export function TodoPage() {
  const todos = useLiveQuery(() => db.todos.orderBy('createdAt').reverse().toArray(), []) ?? EMPTY_ARRAY
  const commissions = useLiveQuery(() => db.commissions.toArray(), []) ?? EMPTY_ARRAY
  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_ARRAY
  const stickers = useLiveQuery(() => db.stickers.toArray(), []) ?? EMPTY_ARRAY
  const settings = useSettingsStore()
  const { walletBalance, setSettings } = settings
  const [newTitle, setNewTitle] = useState('')

  const commissionById = useMemo(() => new Map(commissions.map((c) => [c.id, c])), [commissions])
  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts])

  const personalTodos = todos.filter((t) => t.source === 'user')
  const commissionTodos = todos.filter((t) => t.source === 'commission')

  async function addTodo() {
    const title = newTitle.trim()
    if (!title) return
    await db.todos.add({ id: uuid(), title, done: false, createdAt: Date.now(), source: 'user' })
    setNewTitle('')
  }

  async function togglePersonalTodo(todo: Todo) {
    await db.todos.update(todo.id, { done: !todo.done, completedAt: !todo.done ? Date.now() : undefined })
  }

  async function completeCommissionTodo(todo: Todo) {
    if (todo.done || !todo.commissionId) return
    const commission = commissionById.get(todo.commissionId)
    if (!commission || commission.status === 'completed') return

    await db.todos.update(todo.id, { done: true, completedAt: Date.now() })
    await db.commissions.update(todo.commissionId, { status: 'completed', completedAt: Date.now() })
    setSettings({ walletBalance: walletBalance + commission.reward })

    const conv = await db.conversations.where('contactId').equals(commission.contactId).first()
    if (conv) {
      await db.messages.add({
        id: uuid(),
        conversationId: conv.id,
        role: 'user',
        type: 'text',
        content: `我完成了「${commission.title}」这个委托`,
        createdAt: Date.now(),
      })
      await db.conversations.update(conv.id, { updatedAt: Date.now() })
      const contact = contactById.get(commission.contactId)
      if (contact) triggerAiTurn(conv.id, contact, settings, stickers)
    }
  }

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="待办" right={<span className="pr-1 text-sm text-gray-500">{formatCurrency(walletBalance, settings)}</span>} />
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
        {personalTodos.length === 0 ? (
          <p className="text-sm text-gray-400">还没有待办事项</p>
        ) : (
          <div className="space-y-1">
            {personalTodos.map((t) => (
              <div key={t.id} className="flex items-center gap-2 rounded-lg px-1 py-1.5">
                <button
                  onClick={() => togglePersonalTodo(t)}
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

      <section className="mt-3 flex-1 bg-white px-4 py-4">
        <h2 className="mb-2 text-xs font-medium text-gray-400">委托</h2>
        {commissionTodos.length === 0 ? (
          <p className="text-sm text-gray-400">还没有联系人给你发过委托</p>
        ) : (
          <div className="space-y-2">
            {commissionTodos.map((t) => {
              const commission = t.commissionId ? commissionById.get(t.commissionId) : undefined
              const contact = commission ? contactById.get(commission.contactId) : undefined
              return (
                <div key={t.id} className="rounded-lg bg-gray-50 px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <button
                      onClick={() => completeCommissionTodo(t)}
                      disabled={t.done}
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                        t.done ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300'
                      }`}
                    >
                      {t.done && '✓'}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm ${t.done ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                        {t.title}
                      </p>
                      {t.note && <p className="mt-0.5 text-xs text-gray-400">{t.note}</p>}
                      <p className="mt-1 text-xs text-gray-400">
                        {contact ? `来自 ${displayName(contact)}` : '来自未知联系人'}
                        {commission && ` · ${formatCurrency(commission.reward, settings)}`}
                      </p>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
      </div>
    </div>
  )
}
