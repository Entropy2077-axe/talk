import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'
import type { WalletOwnerId, WalletTransactionKind } from '../types'

export const USER_WALLET_ID = 'user'
export function localDateKey(date = new Date()): string {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
function dayNumber(key: string): number { return Math.floor(new Date(`${key}T12:00:00`).getTime() / 86400000) }
export function elapsedLocalDays(from: string, to: string): number { return Math.max(0, dayNumber(to) - dayNumber(from)) }

export async function ensureWallets(): Promise<void> {
  const settings = useSettingsStore.getState()
  await db.transaction('rw', db.walletAccounts, db.walletTransactions, db.contacts, async () => {
    if (!(await db.walletAccounts.get(USER_WALLET_ID))) {
      const amount = Math.max(0, Math.round(settings.walletBalance || 0))
      await db.walletAccounts.add({ ownerId: USER_WALLET_ID, balance: amount, updatedAt: Date.now() })
      if (amount) await db.walletTransactions.add({ id: uuid(), idempotencyKey: 'legacy-wallet-migration', kind: 'migration', toOwnerId: USER_WALLET_ID, amount, status: 'completed', createdAt: Date.now(), completedAt: Date.now() })
    }
    for (const contact of await db.contacts.toArray()) {
      if (!(await db.walletAccounts.get(contact.id))) await db.walletAccounts.add({ ownerId: contact.id, balance: 0, updatedAt: Date.now() })
    }
  })
  if (!settings.walletMigrated) settings.setSettings({ walletMigrated: true })
}

export async function balanceOf(ownerId: WalletOwnerId): Promise<number> { return (await db.walletAccounts.get(ownerId))?.balance ?? 0 }

export async function transferFunds(opts: { from?: WalletOwnerId; to?: WalletOwnerId; amount: number; kind: WalletTransactionKind; note?: string; idempotencyKey?: string }) {
  const amount = Math.round(opts.amount)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('金额必须是正整数')
  if (!opts.from && !opts.to) throw new Error('资金交易缺少账户')
  return db.transaction('rw', db.walletAccounts, db.walletTransactions, async () => {
    if (opts.idempotencyKey) {
      const existing = await db.walletTransactions.where('idempotencyKey').equals(opts.idempotencyKey).first()
      if (existing) return existing
    }
    const now = Date.now()
    if (opts.from) {
      const account = await db.walletAccounts.get(opts.from)
      if (!account || account.balance < amount) throw new Error('余额不足')
      await db.walletAccounts.update(opts.from, { balance: account.balance - amount, updatedAt: now })
    }
    if (opts.to) {
      const account = await db.walletAccounts.get(opts.to) ?? { ownerId: opts.to, balance: 0, updatedAt: now }
      await db.walletAccounts.put({ ...account, balance: account.balance + amount, updatedAt: now })
    }
    const row = { id: uuid(), idempotencyKey: opts.idempotencyKey, kind: opts.kind, fromOwnerId: opts.from, toOwnerId: opts.to, amount, note: opts.note, status: 'completed' as const, createdAt: now, completedAt: now }
    await db.walletTransactions.add(row)
    return row
  })
}

export async function setUserBalance(target: number) {
  return setWalletBalance(USER_WALLET_ID, target)
}
export async function setWalletBalance(ownerId: WalletOwnerId, target: number) {
  const rounded = Math.max(0, Math.round(target))
  await ensureWallets()
  const current = await balanceOf(ownerId)
  if (current === rounded) return
  await transferFunds({ from: current > rounded ? ownerId : undefined, to: rounded > current ? ownerId : undefined, amount: Math.abs(rounded - current), kind: 'admin_adjustment', note: `管理员设定余额为 ${rounded}` })
}
export async function reserveRedPacket(from: WalletOwnerId, amount: number, note?: string) {
  const tx = await transferFunds({ from, amount, kind: 'red_packet', note })
  await db.walletTransactions.update(tx.id, { status: 'reserved', completedAt: undefined })
  return { ...tx, status: 'reserved' as const }
}
export async function claimRedPacket(transactionId: string, to: WalletOwnerId) {
  return db.transaction('rw', db.walletAccounts, db.walletTransactions, async () => {
    const tx = await db.walletTransactions.get(transactionId)
    if (!tx || tx.kind !== 'red_packet' || tx.status !== 'reserved') throw new Error('红包已领取或不存在')
    const account = await db.walletAccounts.get(to) ?? { ownerId: to, balance: 0, updatedAt: Date.now() }
    await db.walletAccounts.put({ ...account, balance: account.balance + tx.amount, updatedAt: Date.now() })
    await db.walletTransactions.update(tx.id, { toOwnerId: to, status: 'completed', completedAt: Date.now() })
  })
}

export async function settleSalaries(): Promise<void> {
  const settings = useSettingsStore.getState()
  if (!settings.enabledModules.includes('career')) return
  await ensureWallets()
  const today = localDateKey()
  if (settings.userOccupation && settings.userMonthlySalary > 0 && settings.userLastSalaryDate) {
    const days = elapsedLocalDays(settings.userLastSalaryDate, today)
    if (days) {
      await transferFunds({ to: USER_WALLET_ID, amount: Math.round(settings.userMonthlySalary / 30 * days), kind: 'salary', note: `${settings.userOccupation}工资`, idempotencyKey: `salary:user:${today}` })
      settings.setSettings({ userLastSalaryDate: today })
    }
  }
  for (const c of await db.contacts.toArray()) {
    if (!c.occupation || !c.monthlySalary || !c.lastSalaryDate) continue
    const days = elapsedLocalDays(c.lastSalaryDate, today)
    if (!days) continue
    await transferFunds({ to: c.id, amount: Math.round(c.monthlySalary / 30 * days), kind: 'salary', note: `${c.occupation}工资`, idempotencyKey: `salary:${c.id}:${today}` })
    await db.contacts.update(c.id, { lastSalaryDate: today })
  }
}
