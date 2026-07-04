import { useRef } from 'react'

export function useLongPress(onLongPress: () => void, ms = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const moved = useRef(false)

  const start = () => {
    moved.current = false
    timer.current = setTimeout(() => {
      if (!moved.current) onLongPress()
    }, ms)
  }
  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
  }
  const onMove = () => {
    moved.current = true
    clear()
  }

  return {
    onPointerDown: start,
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerMove: onMove,
  }
}
