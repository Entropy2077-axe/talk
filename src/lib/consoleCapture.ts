import { create } from 'zustand'

/**
 * Captures console output app-wide into an in-memory buffer, viewable from
 * the "天眼" admin page — mainly useful on a real phone browser where
 * there's no devtools to open. Patches the real console methods once (still
 * calls through to the original so normal devtools output is untouched);
 * always active regardless of admin mode being on, so there's already
 * history by the time someone turns the page on.
 */
export interface CapturedLog {
  id: number
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
  timestamp: number
}

interface ConsoleCaptureStore {
  logs: CapturedLog[]
  clear: () => void
}

const MAX_LOGS = 300
let nextId = 0

export const useConsoleCaptureStore = create<ConsoleCaptureStore>((set) => ({
  logs: [],
  clear: () => set({ logs: [] }),
}))

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack ?? arg.message
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function push(level: CapturedLog['level'], args: unknown[]) {
  const message = args.map(formatArg).join(' ')
  useConsoleCaptureStore.setState((s) => ({
    logs: [...s.logs, { id: nextId++, level, message, timestamp: Date.now() }].slice(-MAX_LOGS),
  }))
}

let installed = false

export function installConsoleCapture(): void {
  if (installed) return
  installed = true
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  }
  console.log = (...args: unknown[]) => {
    original.log(...args)
    push('log', args)
  }
  console.info = (...args: unknown[]) => {
    original.info(...args)
    push('info', args)
  }
  console.warn = (...args: unknown[]) => {
    original.warn(...args)
    push('warn', args)
  }
  console.error = (...args: unknown[]) => {
    original.error(...args)
    push('error', args)
  }
}
