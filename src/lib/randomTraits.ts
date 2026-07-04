export const RANDOM_TRAITS = [
  '喜欢深夜emo',
  '有点社恐',
  '追星脑子',
  '养了一只猫',
  '健身狂魔',
  '游戏上头',
  '嘴硬心软',
  '容易脸红',
  '喜欢下厨',
  '常年熬夜',
  '路痴',
  '雨天爱emo',
  '喝奶茶上瘾',
  '爱拍照发朋友圈',
  '爱吐槽自己老板',
  '收集手办',
  '喜欢撸猫撸狗',
  '有起床气',
  '爱看恐怖片',
  '爱听livehouse',
  '喜欢徒步露营',
  '嘴上说不要身体很诚实',
  '容易冷场王',
  '喜欢深夜煲电话粥',
  '有拖延症',
  '爱看小说追更',
  '喜欢囤零食',
  '话少但很闷骚',
  '喜欢和人抬杠',
  '容易感动哭',
]

export function pickRandomTrait(exclude: string[] = []): string {
  const pool = RANDOM_TRAITS.filter((t) => !exclude.includes(t))
  const source = pool.length > 0 ? pool : RANDOM_TRAITS
  return source[Math.floor(Math.random() * source.length)]
}
