export const CURRENCY_NAME = '金币'
export const CURRENCY_ICON = '🪙'
export const INITIAL_WALLET_BALANCE = 100

export function formatCurrency(amount: number): string {
  return `${CURRENCY_ICON} ${amount}`
}
