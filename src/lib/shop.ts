/**
 * Product generation is deliberately kept separate from the chat persona
 * system: its own prompt, and the user can point it at a different model
 * (settings.utilityModel) than the one used for conversations — this is a
 * distinct, single-turn (system+user only) generation task, unrelated to
 * any contact's persona or chat history.
 */
import type { AppSettings } from '../types'
import { createDefaultPromptModules, getPromptTemplate } from './promptModules'

export function buildShopPrompt(query: string | null, settings?: Pick<AppSettings, 'promptModules'>): string {
  const editable = getPromptTemplate(settings ?? { promptModules: createDefaultPromptModules() }, 'shop', 'catalog', { query: query || '首页随机推荐' })
  if (!editable) return ''
  return `${editable}

固定输出格式:
{"products": [{"name": "商品名字", "description": "一句话卖点描述", "price": 39, "icon": "🎁"}]}

要求:
- name简短 不超过12个字
- description一句话 不超过20个字 突出卖点或者趣味性
- price是5到100000之间的现实人民币整数价格 符合商品本身的合理定价
- icon是一个最能代表这个商品的emoji 不要用文字
- 只输出JSON 不要有markdown代码块标记`
}

export interface GeneratedProduct {
  name: string
  description: string
  price: number
  icon: string
}

const MIN_PRICE = 5
const MAX_PRICE = 100000
function clampPrice(price: number): number {
  if (!Number.isFinite(price)) return MIN_PRICE
  return Math.round(Math.min(MAX_PRICE, Math.max(MIN_PRICE, price)))
}

export function parseShopProducts(raw: string): GeneratedProduct[] {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  if (!text) return []

  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed?.products)) return []
    return parsed.products
      .filter(
        (p: unknown): p is GeneratedProduct =>
          !!p &&
          typeof p === 'object' &&
          typeof (p as GeneratedProduct).name === 'string' &&
          (p as GeneratedProduct).name.trim().length > 0 &&
          typeof (p as GeneratedProduct).description === 'string' &&
          typeof (p as GeneratedProduct).price === 'number' &&
          typeof (p as GeneratedProduct).icon === 'string',
      )
      .map((p: GeneratedProduct) => ({
        name: p.name.trim(),
        description: p.description.trim(),
        price: clampPrice(p.price),
        icon: p.icon.trim() || '🎁',
      }))
  } catch {
    return []
  }
}
