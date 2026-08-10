/** Persist moods as short, readable words. Legacy emoji values are migrated on read. */
export const MOOD_TEXTS = ['开心', '期待', '放松', '平静', '疲惫', '好奇', '害羞', '委屈', '担心', '生气', '难过', '兴奋'] as const

const LEGACY_EMOJI_MOOD: Record<string, string> = {
  '😀': '开心', '😊': '开心', '🥰': '开心', '😌': '平静', '😶': '平静', '😴': '疲惫',
  '🤔': '好奇', '😳': '害羞', '🥺': '委屈', '😟': '担心', '😠': '生气', '😤': '生气',
  '😞': '难过', '😭': '难过', '😈': '兴奋',
}

export function normalizeMood(value: unknown, fallback = '平静'): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return fallback
  for (const [emoji, mood] of Object.entries(LEGACY_EMOJI_MOOD)) {
    if (raw.includes(emoji)) return mood
  }
  return raw.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '').trim().slice(0, 20) || fallback
}
