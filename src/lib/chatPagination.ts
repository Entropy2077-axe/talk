export const CHAT_PAGE_SIZE_OPTIONS = [10, 20, 40, 60, 100, 200] as const
export const DEFAULT_CHAT_PAGE_SIZE = 40

export function normalizeChatPageSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_CHAT_PAGE_SIZE
  return CHAT_PAGE_SIZE_OPTIONS.reduce((closest, option) =>
    Math.abs(option - value!) < Math.abs(closest - value!) ? option : closest,
  DEFAULT_CHAT_PAGE_SIZE)
}
