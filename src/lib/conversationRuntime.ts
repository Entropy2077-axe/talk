export interface TurnController {
  begin: (conversationId: string, streamId: string) => void
  clearPending: (conversationId: string) => void
  isCurrent: (conversationId: string, streamId: string) => boolean
  setAbortController: (conversationId: string, controller: AbortController) => void
  addTimer: (conversationId: string, timer: ReturnType<typeof setTimeout>) => void
  trackTimers: (conversationId: string, timers: ReturnType<typeof setTimeout>[]) => void
  resetAll: () => void
}

/**
 * Owns the cancellable resources for one conversation engine. Each engine
 * gets its own controller, while private and group turns share the same
 * cancellation semantics.
 */
export function createTurnController(): TurnController {
  const streams = new Map<string, string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>()
  const abortControllers = new Map<string, AbortController>()

  const clearPending = (conversationId: string): void => {
    timers.get(conversationId)?.forEach(clearTimeout)
    timers.set(conversationId, [])
    abortControllers.get(conversationId)?.abort()
    abortControllers.delete(conversationId)
  }

  return {
    begin(conversationId, streamId) {
      streams.set(conversationId, streamId)
      clearPending(conversationId)
    },
    clearPending,
    isCurrent(conversationId, streamId) {
      return streams.get(conversationId) === streamId
    },
    setAbortController(conversationId, controller) {
      abortControllers.set(conversationId, controller)
    },
    addTimer(conversationId, timer) {
      timers.set(conversationId, [...(timers.get(conversationId) ?? []), timer])
    },
    trackTimers(conversationId, pendingTimers) {
      timers.set(conversationId, pendingTimers)
    },
    resetAll() {
      for (const conversationId of new Set([...streams.keys(), ...timers.keys(), ...abortControllers.keys()])) clearPending(conversationId)
      streams.clear()
      timers.clear()
      abortControllers.clear()
    },
  }
}

interface SequentialRevealOptions<T> {
  conversationId: string
  streamId: string
  items: T[]
  controller: TurnController
  delayMs: (item: T, index: number) => number
  reveal: (item: T, index: number) => Promise<void>
  onError: (error: unknown) => void
  onComplete?: () => void
}

/** Run reveal work strictly in order, including any asynchronous media work. */
export function revealSequentially<T>(options: SequentialRevealOptions<T>): void {
  const { conversationId, streamId, items, controller, delayMs, reveal, onError } = options
  if (!controller.isCurrent(conversationId, streamId)) return
  const timers: ReturnType<typeof setTimeout>[] = []
  controller.trackTimers(conversationId, timers)

  let sequence = Promise.resolve()
  items.forEach((item, index) => {
    sequence = sequence.then(() => new Promise<void>((resolve) => {
      const timer = setTimeout(async () => {
        try {
          if (!controller.isCurrent(conversationId, streamId)) return
          await reveal(item, index)
        } catch (error) {
          onError(error)
        } finally {
          resolve()
        }
      }, delayMs(item, index))
      timers.push(timer)
    }))
  })
  void sequence.then(() => {
    if (controller.isCurrent(conversationId, streamId)) options.onComplete?.()
  })
}
