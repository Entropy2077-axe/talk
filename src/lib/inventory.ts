import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { transferFunds, USER_WALLET_ID } from './finance'
import type { InventoryItem } from '../types'

export interface InventoryProduct {
  name: string
  description: string
  icon: string
  price: number
}

function normalizedPart(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

export function inventoryProductKey(product: InventoryProduct): string {
  return JSON.stringify([
    normalizedPart(product.name),
    normalizedPart(product.description),
    product.icon.trim(),
    Math.round(product.price * 100) / 100,
  ])
}

export function inventoryQuantity(item: InventoryItem): number {
  return Number.isFinite(item.quantity) ? Math.max(0, Math.floor(item.quantity!)) : 1
}

export async function addInventoryProduct(product: InventoryProduct): Promise<InventoryItem> {
  const productKey = inventoryProductKey(product)
  const now = Date.now()
  let result!: InventoryItem
  await db.transaction('rw', db.inventory, async () => {
    const existing = await db.inventory.filter((item) => (item.productKey || inventoryProductKey(item)) === productKey).first()
    if (existing) {
      result = { ...existing, productKey, quantity: inventoryQuantity(existing) + 1, updatedAt: now }
      await db.inventory.put(result)
      return
    }
    result = {
      id: uuid(),
      productKey,
      name: product.name,
      description: product.description,
      icon: product.icon,
      price: product.price,
      quantity: 1,
      acquiredAt: now,
      updatedAt: now,
    }
    await db.inventory.add(result)
  })
  return result
}

export async function consumeInventoryItem(itemId: string): Promise<boolean> {
  let consumed = false
  await db.transaction('rw', db.inventory, async () => {
    const item = await db.inventory.get(itemId)
    if (!item || inventoryQuantity(item) <= 0) return
    await db.inventory.update(itemId, {
      quantity: inventoryQuantity(item) - 1,
      productKey: item.productKey || inventoryProductKey(item),
      updatedAt: Date.now(),
    })
    consumed = true
  })
  return consumed
}

export async function purchaseInventoryProduct(product: InventoryProduct, note = product.name): Promise<InventoryItem> {
  let purchased!: InventoryItem
  await db.transaction('rw', db.walletAccounts, db.walletTransactions, db.inventory, async () => {
    await transferFunds({ from: USER_WALLET_ID, amount: product.price, kind: 'purchase', note })
    purchased = await addInventoryProduct(product)
  })
  return purchased
}
