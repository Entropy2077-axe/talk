/**
 * Product generation is deliberately kept separate from the chat persona
 * system: its own prompt, and the user can point it at a different model
 * (settings.utilityModel) than the one used for conversations — this is a
 * distinct, single-turn (system+user only) generation task, unrelated to
 * any contact's persona or chat history.
 */
export function buildShopPrompt(query: string | null): string {
  const task = query
    ? `用户在虚拟网购小程序里搜索了"${query}" 请生成6件和这个搜索词相关的商品`
    : `请为虚拟网购小程序的首页生成6件适合日常浏览、有意思、有点小惊喜的商品 品类尽量不要重复`

  return `你是一个虚拟网购小程序的商品生成器 只输出JSON 不要有任何其他文字

${task}

输出格式:
{"products": [{"name": "商品名字", "description": "一句话卖点描述", "price": 39, "icon": "🎁"}]}

要求:
- name简短 不超过12个字
- description一句话 不超过20个字 突出卖点或者趣味性
- price是5到300之间的整数 符合商品本身的合理定价
- icon是一个最能代表这个商品的emoji 不要用文字
- 6件商品尽量不要重复、不要太严肃刻板 可以有点生活气息或者惊喜感
- 只输出JSON 不要有markdown代码块标记`
}

export interface GeneratedProduct {
  name: string
  description: string
  price: number
  icon: string
}

const MIN_PRICE = 5
const MAX_PRICE = 300
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
