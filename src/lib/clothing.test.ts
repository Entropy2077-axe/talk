import { describe, expect, it } from 'vitest'
import type { ClothingDraftItem, Contact } from '../types'
import { createInitialClothing, currentOutfitItems, parseClothingItems } from './clothing'

const drafts: ClothingDraftItem[] = [
  { name: '白色T恤', category: '上装', color: '白色', description: '棉质T恤' },
  { name: '蓝色牛仔裤', category: '下装', color: '蓝色', description: '直筒牛仔裤' },
  { name: '白色运动鞋', category: '鞋履', color: '白色', description: '日常运动鞋' },
]

describe('clothing state', () => {
  it('normalizes categories and removes duplicate items', () => {
    expect(parseClothingItems([...drafts, drafts[0], { name: '帽子', category: '未知', color: '', description: '' }])).toEqual([
      ...drafts,
      { name: '帽子', category: '其他', color: '未注明', description: '帽子' },
    ])
  })

  it('creates stable wardrobe ids and resolves the selected current outfit', () => {
    const created = createInitialClothing(drafts, ['白色T恤', '白色运动鞋'], 123)
    const contact = { wardrobe: created.wardrobe, currentOutfit: created.outfit } as Contact
    expect(created.wardrobe.every((item) => item.createdAt === 123 && !!item.id)).toBe(true)
    expect(currentOutfitItems(contact).map((item) => item.name)).toEqual(['白色T恤', '白色运动鞋'])
  })
})
