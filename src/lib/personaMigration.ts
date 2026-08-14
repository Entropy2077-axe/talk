const LEGACY_PERSONA_HEADINGS = [
  '补充设定：',
  '人物事实与行为：',
  '性格表现：',
  '说话方式参考：',
] as const

/**
 * Repairs the one-off v42 persona merge. Rich generated personas already
 * contain identity, behaviour and voice, so appending the former parallel
 * fields made the same character appear two or three times. Short personas
 * keep the legacy details so migration never erases their only useful data.
 */
export function compactLegacyPersonaText(value: unknown): string {
  const source = typeof value === 'string' ? value.trim() : ''
  if (!source) return ''
  const positions = LEGACY_PERSONA_HEADINGS
    .map((heading) => ({ heading, index: source.indexOf(`\n\n${heading}`) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index)
  if (!positions.length) return source

  const base = source.slice(0, positions[0].index).trim()
  const sections = positions.map((entry, index) => {
    const start = entry.index + 2 + entry.heading.length
    const end = positions[index + 1]?.index ?? source.length
    return source.slice(start, end).trim()
  })
  const supplemental = sections[positions.findIndex((entry) => entry.heading === '补充设定：')] || ''
  const candidates = base.length >= 160 ? [base, supplemental] : [base, ...sections]
  const unique: string[] = []
  for (const candidate of candidates) {
    const flat = candidate.replace(/^[-•]\s*/gm, '').replace(/\s+/g, ' ').trim()
    if (!flat) continue
    if (unique.some((existing) => existing.includes(flat) || flat.includes(existing))) {
      if (unique.length === 1 && flat.length > unique[0].length) unique[0] = flat
      continue
    }
    unique.push(flat)
  }
  return unique.join(' ').replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * v44 already flattened some contacts before we learned that their
 * supplemental field itself contained a second generated biography. Detect
 * that narrow shape: a biography starting with the contact's name and a later
 * second biography starting with the same name. Ordinary mid-paragraph name
 * mentions are left alone unless the suffix is long and looks like a complete
 * third-person profile.
 */
export function removeRepeatedPersonaBiography(value: unknown, contactName: unknown): string {
  const source = typeof value === 'string' ? value.trim() : ''
  const name = typeof contactName === 'string' ? contactName.trim() : ''
  if (!source || name.length < 2) return source
  const opener = new RegExp(`${escapeRegExp(name)}(?:是|是一|为)`, 'g')
  const matches = Array.from(source.matchAll(opener))
  if (matches.length < 2 || (matches[0].index ?? -1) > 6) return source

  const secondStart = matches[1].index ?? -1
  const suffix = source.slice(secondStart)
  if (secondStart < 120 || suffix.length < 60) return source
  const profileSignals = ['学生', '职业', '外表', '性格', '喜欢', '恋人', '朋友', '家人', '说话', '相处']
  if (profileSignals.filter((signal) => suffix.includes(signal)).length < 2) return source

  const prefix = source.slice(0, secondStart)
  const boundary = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('！'), prefix.lastIndexOf('？'))
  if (boundary < 80) return source
  return prefix.slice(0, boundary + 1).trim()
}
