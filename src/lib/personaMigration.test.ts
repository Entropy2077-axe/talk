import { describe, expect, it } from 'vitest'
import { compactLegacyPersonaText, removeRepeatedPersonaBiography } from './personaMigration'

describe('legacy persona compaction', () => {
  it('keeps a rich canonical narrative and removes appended parallel profiles', () => {
    const result = compactLegacyPersonaText(`她是十九岁的学生，表面毒舌，实际非常在意用户。她会用挑衅掩饰关心，并尊重关系边界。${'长期相处细节。'.repeat(20)}

补充设定：一个嘴硬但是很在乎我的恋人

人物事实与行为：
身份与背景：十九岁；学生
稳定习惯：嘴硬

性格表现：
毒舌

说话方式参考：
- 哼，才不是担心你`)

    expect(result).toContain('她是十九岁的学生')
    expect(result).toContain('一个嘴硬但是很在乎我的恋人')
    expect(result).not.toContain('人物事实与行为')
    expect(result).not.toContain('说话方式参考')
    expect(result).not.toContain('\n')
  })

  it('retains old details when the original persona was only a short stub', () => {
    const result = compactLegacyPersonaText('嘴硬。\n\n人物事实与行为：\n学生；怕冷\n\n性格表现：\n关心人但不直说')
    expect(result).toContain('嘴硬。')
    expect(result).toContain('学生；怕冷')
    expect(result).toContain('关心人但不直说')
  })

  it('leaves ordinary user-authored persona text unchanged', () => {
    const source = '第一段。\n第二段。'
    expect(compactLegacyPersonaText(source)).toBe(source)
  })

  it('removes a second flattened biography left behind by the first cleanup', () => {
    const first = `林语汐是设计专业的大二学生，外表娇小，说话嘴硬心软。${'她会认真记住恋人的喜好，也会准备手作礼物。'.repeat(8)}她希望一直陪在恋人身边。`
    const duplicate = '一个嘴硬但是很在乎我的恋人 林语汐是一名设计专业的大二学生，外表娇小可爱，喜欢穿洛丽塔风格便服。她与恋人是校园情侣，虽然嘴上总嫌弃对方，但手机备忘录里全是恋人的注意事项。'
    const result = removeRepeatedPersonaBiography(`${first} ${duplicate}`, '林语汐')

    expect(result).toBe(first)
    expect(result).not.toContain('一个嘴硬但是很在乎我的恋人')
  })

  it('does not cut an ordinary later mention of the contact name', () => {
    const source = `林语汐是设计专业学生。${'她平时喜欢画画。'.repeat(20)}朋友偶尔会说林语汐是个很可靠的人。`
    expect(removeRepeatedPersonaBiography(source, '林语汐')).toBe(source)
  })
})
