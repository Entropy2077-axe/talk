export const CURRENCY_NAME = '金币'
export const CURRENCY_ICON = '🪙'
export const INITIAL_WALLET_BALANCE = 100

export function currencyIcon(settings?: { currencyIconMode?: string; customCurrencyEmoji?: string }): string {
  if (settings?.currencyIconMode === 'emoji') return settings.customCurrencyEmoji?.trim() || '💎'
  if (settings?.currencyIconMode === 'yen') return '¥'
  if (settings?.currencyIconMode === 'dollar') return '$'
  return CURRENCY_ICON
}

export function formatCurrency(amount: number, settings?: { currencyIconMode?: string; customCurrencyEmoji?: string }): string {
  return `${currencyIcon(settings)} ${amount}`
}
