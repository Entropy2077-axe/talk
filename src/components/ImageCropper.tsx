import { useRef, useState } from 'react'

interface ImageCropperProps {
  src: string
  onConfirm: (dataUrl: string) => void
  onCancel: () => void
}

const VIEWPORT = 260
const OUTPUT = 320

export function ImageCropper({ src, onConfirm, onCancel }: ImageCropperProps) {
  const imgRef = useRef<HTMLImageElement>(null)
  const [natural, setNatural] = useState({ w: 1, h: 1 })
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragging = useRef<{ startX: number; startY: number; origin: { x: number; y: number } } | null>(null)

  const baseScale = Math.max(VIEWPORT / natural.w, VIEWPORT / natural.h) || 1
  const effectiveScale = baseScale * scale
  const displayedW = natural.w * effectiveScale
  const displayedH = natural.h * effectiveScale
  const maxOffsetX = Math.max(0, (displayedW - VIEWPORT) / 2)
  const maxOffsetY = Math.max(0, (displayedH - VIEWPORT) / 2)

  function clamp(o: { x: number; y: number }) {
    return {
      x: Math.min(maxOffsetX, Math.max(-maxOffsetX, o.x)),
      y: Math.min(maxOffsetY, Math.max(-maxOffsetY, o.y)),
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    dragging.current = { startX: e.clientX, startY: e.clientY, origin: offset }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging.current) return
    const dx = e.clientX - dragging.current.startX
    const dy = e.clientY - dragging.current.startY
    setOffset(clamp({ x: dragging.current.origin.x + dx, y: dragging.current.origin.y + dy }))
  }
  function onPointerUp() {
    dragging.current = null
  }

  function handleConfirm() {
    const img = imgRef.current
    if (!img) return
    const imgX = (VIEWPORT - displayedW) / 2 + offset.x
    const imgY = (VIEWPORT - displayedH) / 2 + offset.y
    const sx = -imgX / effectiveScale
    const sy = -imgY / effectiveScale
    const sSize = VIEWPORT / effectiveScale

    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT
    canvas.height = OUTPUT
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUTPUT, OUTPUT)
    onConfirm(canvas.toDataURL('image/jpeg', 0.9))
  }

  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/70 p-6">
      <div
        className="relative overflow-hidden rounded-2xl bg-black touch-none"
        style={{ width: VIEWPORT, height: VIEWPORT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <img
          ref={imgRef}
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const el = e.currentTarget
            setNatural({ w: el.naturalWidth, h: el.naturalHeight })
          }}
          className="absolute left-1/2 top-1/2 select-none"
          style={{
            width: natural.w * effectiveScale,
            height: natural.h * effectiveScale,
            transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`,
          }}
        />
        <div className="pointer-events-none absolute inset-0 rounded-2xl ring-2 ring-white/80" />
      </div>

      <input
        type="range"
        min={1}
        max={3}
        step={0.01}
        value={scale}
        onChange={(e) => {
          setScale(Number(e.target.value))
          setOffset((o) => clamp(o))
        }}
        className="mt-4 w-[260px]"
      />
      <p className="mt-1 text-xs text-white/70">拖动调整位置 滑动条缩放</p>

      <div className="mt-4 flex w-[260px] gap-2">
        <button onClick={onCancel} className="flex-1 rounded-lg bg-white/10 py-2 text-sm text-white">
          取消
        </button>
        <button onClick={handleConfirm} className="flex-1 rounded-lg bg-white py-2 text-sm text-gray-900">
          确定
        </button>
      </div>
    </div>
  )
}
