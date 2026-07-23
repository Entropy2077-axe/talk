import { describe, expect, it } from 'vitest'
import { inventoryProductKey, inventoryQuantity } from './inventory'

describe('inventory stacking', () => {
  it('uses a stable key for visually identical generated products', () => {
    expect(inventoryProductKey({ name: '  热 可可 ', description: '冬日  饮品', icon: '☕', price: 18 }))
      .toBe(inventoryProductKey({ name: '热 可可', description: '冬日 饮品', icon: '☕', price: 18 }))
  })

  it('treats legacy rows as one and retains an exhausted stack at zero', () => {
    const base = { id: 'item', name: '礼物', description: '测试', icon: '🎁', price: 10, acquiredAt: 1 }
    expect(inventoryQuantity(base)).toBe(1)
    expect(inventoryQuantity({ ...base, quantity: 0 })).toBe(0)
    expect(inventoryQuantity({ ...base, quantity: 3 })).toBe(3)
  })
})
