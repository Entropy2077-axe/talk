export const REALISTIC_REPLY_MAX_DELAY_MS = 5 * 60 * 1000

/** Returns a bounded, human-like delay. Keeping the random choice here makes
 * private and group engines behave consistently and keeps it testable. */
export function realisticReplyDelayMs(enabled: boolean, random = Math.random()): number {
  if (!enabled) return 0
  const normalized = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0
  return Math.round(normalized * REALISTIC_REPLY_MAX_DELAY_MS)
}
