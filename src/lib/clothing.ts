import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import {
  CLOTHING_CATEGORIES,
  type ClothingCategory,
  type ClothingDraftItem,
  type ClothingItem,
  type Contact,
  type ContactOutfit,
  type OutfitChangeAction,
} from '../types'

const CATEGORY_SET = new Set<string>(CLOTHING_CATEGORIES)

const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''

export function parseClothingItems(value: unknown, maxItems = 24): ClothingDraftItem[] {
  if (!Array.isArray(value)) return []
  const items: ClothingDraftItem[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const record = candidate as Record<string, unknown>
    const name = clean(record.name, 40)
    const rawCategory = clean(record.category, 12)
    const category: ClothingCategory = CATEGORY_SET.has(rawCategory) ? rawCategory as ClothingCategory : '其他'
    const color = clean(record.color, 24) || '未注明'
    const description = clean(record.description, 120) || name
    const key = `${category}:${name}`.toLocaleLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    items.push({ name, category, color, description })
    if (items.length >= maxItems) break
  }
  return items
}

function itemKey(item: Pick<ClothingDraftItem, 'name' | 'category'>) {
  return `${item.category}:${item.name}`.toLocaleLowerCase()
}

export function createInitialClothing(
  wardrobeDraft: ClothingDraftItem[] | undefined,
  currentNames: string[] | undefined,
  now = Date.now(),
): { wardrobe: ClothingItem[]; outfit: ContactOutfit } {
  const drafts = parseClothingItems(wardrobeDraft)
  const wardrobe = drafts.map((item) => ({ ...item, id: uuid(), createdAt: now }))
  const requested = new Set((currentNames ?? []).map((name) => name.trim().toLocaleLowerCase()).filter(Boolean))
  let worn = wardrobe.filter((item) => requested.has(item.name.toLocaleLowerCase()))
  if (!worn.length) worn = wardrobe.filter((item) => ['上装', '下装', '连体装', '鞋履'].includes(item.category)).slice(0, 4)
  return {
    wardrobe,
    outfit: {
      itemIds: worn.map((item) => item.id),
      summary: worn.length ? worn.map((item) => item.name).join('、') : '暂未记录穿着',
      updatedAt: now,
    },
  }
}

export function currentOutfitItems(contact: Contact): ClothingItem[] {
  const ids = new Set(contact.currentOutfit?.itemIds ?? [])
  return (contact.wardrobe ?? []).filter((item) => ids.has(item.id))
}

export function clothingContextText(contact: Contact): string {
  const worn = currentOutfitItems(contact)
  const wardrobe = contact.wardrobe ?? []
  const current = worn.length
    ? worn.map((item) => `${item.name}（${item.color}，${item.description}）`).join('；')
    : contact.currentOutfit?.summary || '暂未记录'
  const owned = wardrobe.length
    ? wardrobe.map((item) => `${item.name}[${item.category}/${item.color}]`).join('、')
    : '暂未记录'
  return `【衣物状态】\n当前穿着：${current}\n已有衣物：${owned}\n衣物是持续世界状态。只有实际完成换穿、脱下或穿上后才能改变；讨论、建议、假设、未来打算或被拒绝的请求都不能改变。`
}

export async function applyOutfitChange(
  contactId: string,
  change: OutfitChangeAction,
  options: { conversationId?: string; turnId?: string; now?: number } = {},
): Promise<ContactOutfit | null> {
  const items = parseClothingItems(change.items, 12)
  const summary = clean(change.summary, 120)
  if (!items.length || !summary) return null
  const now = options.now ?? Date.now()
  let result: ContactOutfit | null = null
  await db.transaction('rw', db.contacts, async () => {
    const contact = await db.contacts.get(contactId)
    if (!contact) return
    const wardrobe = [...(contact.wardrobe ?? [])]
    const byKey = new Map(wardrobe.map((item) => [itemKey(item), item]))
    const wornIds: string[] = []
    for (const draft of items) {
      const key = itemKey(draft)
      let stored = byKey.get(key)
      if (!stored) {
        stored = { ...draft, id: uuid(), createdAt: now }
        wardrobe.push(stored)
        byKey.set(key, stored)
      } else {
        Object.assign(stored, draft)
      }
      wornIds.push(stored.id)
    }
    result = {
      itemIds: [...new Set(wornIds)], summary, updatedAt: now,
      sourceConversationId: options.conversationId,
      sourceTurnId: options.turnId,
    }
    await db.contacts.update(contactId, { wardrobe, currentOutfit: result })
  })
  return result
}
