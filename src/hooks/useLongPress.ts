import { useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'

const MOVE_TOLERANCE_PX = 12

export function useLongPress(onLongPress: () => void, ms = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPoint = useRef<{ x: number; y: number; pointerId: number } | null>(null)

  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    startPoint.current = null
  }

  const start = (event: ReactPointerEvent) => {
    clear()
    startPoint.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    timer.current = setTimeout(() => {
      timer.current = null
      if (startPoint.current) onLongPress()
    }, ms)
  }

  const onMove = (event: ReactPointerEvent) => {
    const start = startPoint.current
    if (!start || start.pointerId !== event.pointerId) return
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y)
    // Real touchscreens emit tiny pointer moves even when a finger appears
    // stationary. Only an intentional drag/scroll should cancel the press.
    if (distance > MOVE_TOLERANCE_PX) clear()
  }

  return {
    onPointerDown: start,
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onPointerMove: onMove,
    onContextMenu: (event: ReactMouseEvent) => event.preventDefault(),
  }
}
