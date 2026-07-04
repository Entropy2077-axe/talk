export interface HighlightSegment {
  text: string
  matched: boolean
}

export function highlightSegments(source: string, query: string): HighlightSegment[] {
  if (!query) return [{ text: source, matched: false }]
  const idx = source.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return [{ text: source, matched: false }]
  const segs: HighlightSegment[] = []
  if (idx > 0) segs.push({ text: source.slice(0, idx), matched: false })
  segs.push({ text: source.slice(idx, idx + query.length), matched: true })
  if (idx + query.length < source.length) {
    segs.push({ text: source.slice(idx + query.length), matched: false })
  }
  return segs
}

/** Returns a short excerpt of `source` centered on the first match of `query`. */
export function excerptAround(source: string, query: string, radius = 12): string {
  const idx = source.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return source.slice(0, radius * 2)
  const start = Math.max(0, idx - radius)
  const end = Math.min(source.length, idx + query.length + radius)
  let excerpt = source.slice(start, end)
  if (start > 0) excerpt = '…' + excerpt
  if (end < source.length) excerpt = excerpt + '…'
  return excerpt
}

export function truncateName(name: string, max = 6): string {
  return name.length > max ? name.slice(0, max) + '…' : name
}
