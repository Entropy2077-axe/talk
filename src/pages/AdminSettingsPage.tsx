import { useState } from 'react'

import { TopBar } from '../components/TopBar'

import { useSettingsStore } from '../store/useSettingsStore'
import { db } from '../db/db'

import { useLiveQuery } from 'dexie-react-hooks'
import { USER_WALLET_ID, setUserBalance } from '../lib/finance'
import { formatCurrency } from '../lib/wallet'

import { SettingsLinks } from '../components/SettingsMenu'
export function AdminSettingsPage() {

  const { adminModeEnabled, experienceMode } = useSettingsStore()
  const wallet = useLiveQuery(() => db.walletAccounts.get(USER_WALLET_ID), [])
  const [adminBalance, setAdminBalance] = useState('')

  return <div className="ui-page"><TopBar title="管理工具" showBack /><div className="ui-page-scroll pb-5">{adminModeEnabled && experienceMode === 'free' ? <><SettingsLinks entries={[{ to: '/sky-eye', label: '天眼', note: '查看运行状态、提示词和记忆', icon: '🔭' }, { to: '/ai-test-cards', label: 'AI 自动测试', note: '运行和管理评测用例', icon: '🧪' }]} /><section className="ui-section-card ui-section-spaced"><h2 className="text-sm font-medium text-[var(--ui-text)]">设定我的余额</h2><p className="mt-1 text-xs text-[var(--ui-text-3)]">当前 {formatCurrency(wallet?.balance ?? 0, useSettingsStore.getState())}</p><div className="mt-2 flex gap-2"><input type="number" min="0" value={adminBalance} onChange={e => setAdminBalance(e.target.value)} placeholder="目标余额" className="min-w-0 flex-1 rounded-lg border border-[var(--ui-border)] px-3 py-2 text-sm" /><button onClick={async () => { const n = Number(adminBalance); if (Number.isFinite(n) && n >= 0 && confirm(`确认将余额设为 ${Math.round(n)}？`)) { await setUserBalance(n); setAdminBalance('') } }} className="rounded-lg bg-[var(--ui-action)] px-4 text-sm text-[var(--ui-on-action)]">设定</button></div></section></> : <div className="ui-empty-state"><p>请在自由模式下，从功能管理开启管理员模式。</p></div>}</div></div>
}
