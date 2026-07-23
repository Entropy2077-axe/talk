import { estimateTokens } from './aiUsage'
import type { WorldbookEntry } from '../types'

type TokenEntry = Pick<WorldbookEntry, 'title' | 'content'>

export function estimateWorldbookTokens(entries: TokenEntry[]): number {
  return entries.reduce((total, entry) => total + estimateTokens(`【${entry.title}】\n${entry.content}`), 0)
}

export function formatEstimatedTokens(tokens: number): string {
  return `约 ${tokens.toLocaleString()} Token`
}
