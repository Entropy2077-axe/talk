import { useEffect } from 'react'
import { useChatUiStore } from '../store/useChatUiStore'

export function RelationshipNotice() {
  const message = useChatUiStore((s) => s.relationshipNotice)
  const clear = useChatUiStore((s) => s.clearRelationshipNotice)

  useEffect(() => {
    if (!message) return
    const t = setTimeout(clear, 2600)
    return () => clearTimeout(t)
  }, [message, clear])

  if (!message) return null

  return (
    <div className="pointer-events-none absolute left-1/2 top-16 z-50 w-[min(22rem,calc(100%-2rem))] -translate-x-1/2 rounded-2xl bg-black/80 px-4 py-3 text-center text-xs leading-relaxed text-white shadow-lg">
      {message}
    </div>
  )
}
