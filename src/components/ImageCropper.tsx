import { useEffect, useMemo, useRef, useState } from 'react'

interface ImageCropperProps {
  src: string
  onConfirm: (dataUrl: string) => void
  onCancel: () => void
  aspectRatio?: number
  title?: string
  mode?: 'image' | 'frame'
}

const IMAGE_VIEWPORT = 260
const FRAME_STAGE_W = 300
const FRAME_STAGE_H = 360
const OUTPUT_WIDTH = 720
const MIN_CROP_SIZE = 44

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

type DragState =
  | { type: 'image'; startX: number; startY: number; origin: { x: number; y: number } }
  | { type: 'move'; startX: number; startY: number; origin: Rect }
  | { type: 'resize'; corner: 'nw' | 'ne' | 'sw' | 'se'; startX: number; startY: number; origin: Rect }
  | { type: 'draw'; startX: number; startY: number }

export function ImageCropper({
  src,
  onConfirm,
  onCancel,
  aspectRatio = 1,
  title = '裁剪图片',
  mode = 'image',
}: ImageCropperProps) {
  const imgRef = useRef<HTMLImageElement>(null)
  const [natural, setNatural] = useState({ w: 1, h: 1 })
  const dragging = useRef<DragState | null>(null)

  if (mode === 'frame') {
    return (
      <FrameCropper
        src={src}
        title={title}
        aspectRatio={aspectRatio}
        natural={natural}
        setNatural={setNatural}
        imgRef={imgRef}
        dragging={dragging}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )
  }

  return (
    <ImageMoveCropper
      src={src}
      title={title}
      aspectRatio={aspectRatio}
      natural={natural}
      setNatural={setNatural}
      imgRef={imgRef}
      dragging={dragging}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}

function ImageMoveCropper({
  src,
  title,
  aspectRatio,
  natural,
  setNatural,
  imgRef,
  dragging,
  onConfirm,
  onCancel,
}: {
  src: string
  title: string
  aspectRatio: number
  natural: { w: number; h: number }
  setNatural: (value: { w: number; h: number }) => void
  imgRef: React.RefObject<HTMLImageElement | null>
  dragging: React.MutableRefObject<DragState | null>
  onConfirm: (dataUrl: string) => void
  onCancel: () => void
}) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const cropW = aspectRatio >= 1 ? IMAGE_VIEWPORT : IMAGE_VIEWPORT * aspectRatio
  const cropH = aspectRatio >= 1 ? IMAGE_VIEWPORT / aspectRatio : IMAGE_VIEWPORT
  const outputW = OUTPUT_WIDTH
  const outputH = Math.round(outputW / aspectRatio)
  const baseScale = Math.max(cropW / natural.w, cropH / natural.h) || 1
  const effectiveScale = baseScale * scale
  const displayedW = natural.w * effectiveScale
  const displayedH = natural.h * effectiveScale
  const maxOffsetX = Math.max(0, (displayedW - cropW) / 2)
  const maxOffsetY = Math.max(0, (displayedH - cropH) / 2)

  function clamp(o: { x: number; y: number }) {
    return {
      x: Math.min(maxOffsetX, Math.max(-maxOffsetX, o.x)),
      y: Math.min(maxOffsetY, Math.max(-maxOffsetY, o.y)),
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    dragging.current = { type: 'image', startX: e.clientX, startY: e.clientY, origin: offset }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent) {
    const state = dragging.current
    if (!state || state.type !== 'image') return
    setOffset(clamp({ x: state.origin.x + e.clientX - state.startX, y: state.origin.y + e.clientY - state.startY }))
  }

  function handleConfirm() {
    const img = imgRef.current
    if (!img) return
    const imgX = (cropW - displayedW) / 2 + offset.x
    const imgY = (cropH - displayedH) / 2 + offset.y
    drawCrop(img, -imgX / effectiveScale, -imgY / effectiveScale, cropW / effectiveScale, cropH / effectiveScale, outputW, outputH, onConfirm)
  }

  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/70 p-6">
      <p className="mb-3 text-sm font-medium text-white">{title}</p>
      <div
        className="relative overflow-hidden rounded-2xl bg-black touch-none"
        style={{ width: cropW, height: cropH }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (dragging.current = null)}
        onPointerLeave={() => (dragging.current = null)}
      >
        <CropImage
          imgRef={imgRef}
          src={src}
          setNatural={setNatural}
          width={natural.w * effectiveScale}
          height={natural.h * effectiveScale}
          transform={`translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`}
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
      <CropActions onCancel={onCancel} onConfirm={handleConfirm} />
    </div>
  )
}

function FrameCropper({
  src,
  title,
  aspectRatio,
  natural,
  setNatural,
  imgRef,
  dragging,
  onConfirm,
  onCancel,
}: {
  src: string
  title: string
  aspectRatio: number
  natural: { w: number; h: number }
  setNatural: (value: { w: number; h: number }) => void
  imgRef: React.RefObject<HTMLImageElement | null>
  dragging: React.MutableRefObject<DragState | null>
  onConfirm: (dataUrl: string) => void
  onCancel: () => void
}) {
  const fitScale = Math.min(FRAME_STAGE_W / natural.w, FRAME_STAGE_H / natural.h) || 1
  const displayedW = natural.w * fitScale
  const displayedH = natural.h * fitScale
  const imageLeft = (FRAME_STAGE_W - displayedW) / 2
  const imageTop = (FRAME_STAGE_H - displayedH) / 2
  const initialCrop = useMemo(() => {
    const w = Math.min(displayedW * 0.72, displayedH * 0.72 * aspectRatio)
    const h = w / aspectRatio
    return clampRect({ x: imageLeft + (displayedW - w) / 2, y: imageTop + (displayedH - h) / 2, w, h }, imageLeft, imageTop, displayedW, displayedH, aspectRatio)
  }, [aspectRatio, displayedH, displayedW, imageLeft, imageTop])
  const [crop, setCrop] = useState<Rect>(initialCrop)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setCrop(initialCrop)
  }, [initialCrop])

  function resetCropIfNeeded(w: number, h: number) {
    setNatural({ w, h })
    setLoaded(true)
  }

  function localPoint(e: React.PointerEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function onStagePointerDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).dataset.cropHandle || (e.target as HTMLElement).dataset.cropBox) return
    const p = localPoint(e)
    const start = clampPoint(p, imageLeft, imageTop, displayedW, displayedH)
    dragging.current = { type: 'draw', startX: start.x, startY: start.y }
    setCrop(clampRect({ x: start.x, y: start.y, w: MIN_CROP_SIZE, h: MIN_CROP_SIZE / aspectRatio }, imageLeft, imageTop, displayedW, displayedH, aspectRatio))
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent) {
    const state = dragging.current
    if (!state) return
    const p = localPoint(e)
    const point = clampPoint(p, imageLeft, imageTop, displayedW, displayedH)
    if (state.type === 'move') {
      setCrop(clampRect({ ...state.origin, x: state.origin.x + e.clientX - state.startX, y: state.origin.y + e.clientY - state.startY }, imageLeft, imageTop, displayedW, displayedH, aspectRatio))
    } else if (state.type === 'resize') {
      setCrop(resizeRect(state.origin, state.corner, e.clientX - state.startX, e.clientY - state.startY, imageLeft, imageTop, displayedW, displayedH, aspectRatio))
    } else if (state.type === 'draw') {
      setCrop(rectFromPoints(state.startX, state.startY, point.x, point.y, imageLeft, imageTop, displayedW, displayedH, aspectRatio))
    }
  }

  function handleConfirm() {
    const img = imgRef.current
    if (!img || !loaded) return
    const sx = (crop.x - imageLeft) / fitScale
    const sy = (crop.y - imageTop) / fitScale
    const sWidth = crop.w / fitScale
    const sHeight = crop.h / fitScale
    const outputW = OUTPUT_WIDTH
    const outputH = Math.round(outputW / aspectRatio)
    drawCrop(img, sx, sy, sWidth, sHeight, outputW, outputH, onConfirm)
  }

  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/75 p-4">
      <p className="mb-3 text-sm font-medium text-white">{title}</p>
      <div
        className="relative overflow-hidden rounded-2xl bg-black/40 touch-none"
        data-testid="frame-cropper-stage"
        style={{ width: FRAME_STAGE_W, height: FRAME_STAGE_H }}
        onPointerDown={onStagePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (dragging.current = null)}
        onPointerLeave={() => (dragging.current = null)}
      >
        <CropImage
          imgRef={imgRef}
          src={src}
          setNatural={(value) => resetCropIfNeeded(value.w, value.h)}
          width={displayedW}
          height={displayedH}
          transform="translate(-50%, -50%)"
        />
        <div className="pointer-events-none absolute bg-black/45" style={{ left: 0, top: 0, width: FRAME_STAGE_W, height: crop.y }} />
        <div className="pointer-events-none absolute bg-black/45" style={{ left: 0, top: crop.y + crop.h, width: FRAME_STAGE_W, bottom: 0 }} />
        <div className="pointer-events-none absolute bg-black/45" style={{ left: 0, top: crop.y, width: crop.x, height: crop.h }} />
        <div className="pointer-events-none absolute bg-black/45" style={{ left: crop.x + crop.w, top: crop.y, right: 0, height: crop.h }} />
        <div
          data-crop-box="true"
          className="absolute cursor-move border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
          style={{ left: crop.x, top: crop.y, width: crop.w, height: crop.h }}
          onPointerDown={(e) => {
            e.stopPropagation()
            dragging.current = { type: 'move', startX: e.clientX, startY: e.clientY, origin: crop }
            ;(e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId)
          }}
        >
          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <button
              key={corner}
              data-crop-handle={corner}
              aria-label={`调整裁剪框 ${corner}`}
              className={`absolute h-5 w-5 rounded-full border-2 border-white bg-[#aa3bff] ${
                corner.includes('n') ? '-top-2.5' : '-bottom-2.5'
              } ${corner.includes('w') ? '-left-2.5' : '-right-2.5'}`}
              onPointerDown={(e) => {
                e.stopPropagation()
                dragging.current = { type: 'resize', corner, startX: e.clientX, startY: e.clientY, origin: crop }
                const stage = e.currentTarget.parentElement?.parentElement
                stage?.setPointerCapture(e.pointerId)
              }}
            />
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs text-white/70">拖拽框选区域 拖动角点调整大小</p>
      <CropActions onCancel={onCancel} onConfirm={handleConfirm} />
    </div>
  )
}

function CropImage({
  imgRef,
  src,
  setNatural,
  width,
  height,
  transform,
}: {
  imgRef: React.RefObject<HTMLImageElement | null>
  src: string
  setNatural: (value: { w: number; h: number }) => void
  width: number
  height: number
  transform: string
}) {
  return (
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
      style={{ width, height, transform }}
    />
  )
}

function CropActions({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="mt-4 flex w-[260px] gap-2">
      <button onClick={onCancel} className="flex-1 rounded-lg bg-white/10 py-2 text-sm text-white">
        取消
      </button>
      <button onClick={onConfirm} className="flex-1 rounded-lg bg-white py-2 text-sm text-gray-900">
        确定
      </button>
    </div>
  )
}

function drawCrop(
  img: HTMLImageElement,
  sx: number,
  sy: number,
  sWidth: number,
  sHeight: number,
  outputW: number,
  outputH: number,
  onConfirm: (dataUrl: string) => void,
) {
  const canvas = document.createElement('canvas')
  canvas.width = outputW
  canvas.height = outputH
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, outputW, outputH)
  onConfirm(canvas.toDataURL('image/jpeg', 0.9))
}

function clampPoint(p: { x: number; y: number }, left: number, top: number, width: number, height: number) {
  return {
    x: Math.min(left + width, Math.max(left, p.x)),
    y: Math.min(top + height, Math.max(top, p.y)),
  }
}

function clampRect(rect: Rect, left: number, top: number, width: number, height: number, aspectRatio: number): Rect {
  const maxH = height
  let w = Math.max(MIN_CROP_SIZE, rect.w)
  let h = w / aspectRatio
  if (h > maxH) {
    h = maxH
    w = h * aspectRatio
  }
  let x = Math.min(left + width - w, Math.max(left, rect.x))
  let y = Math.min(top + height - h, Math.max(top, rect.y))
  if (!Number.isFinite(x)) x = left
  if (!Number.isFinite(y)) y = top
  return { x, y, w, h }
}

function resizeRect(
  origin: Rect,
  corner: 'nw' | 'ne' | 'sw' | 'se',
  dx: number,
  dy: number,
  left: number,
  top: number,
  width: number,
  height: number,
  aspectRatio: number,
): Rect {
  const signX = corner.includes('e') ? 1 : -1
  const signY = corner.includes('s') ? 1 : -1
  const delta = Math.abs(dx) > Math.abs(dy) ? dx * signX : dy * signY * aspectRatio
  let w = Math.max(MIN_CROP_SIZE, origin.w + delta)
  let h = w / aspectRatio
  if (h > height) {
    h = height
    w = h * aspectRatio
  }
  const x = corner.includes('w') ? origin.x + origin.w - w : origin.x
  const y = corner.includes('n') ? origin.y + origin.h - h : origin.y
  return clampRect({ x, y, w, h }, left, top, width, height, aspectRatio)
}

function rectFromPoints(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  left: number,
  top: number,
  width: number,
  height: number,
  aspectRatio: number,
): Rect {
  const signX = endX >= startX ? 1 : -1
  const signY = endY >= startY ? 1 : -1
  let w = Math.max(MIN_CROP_SIZE, Math.abs(endX - startX))
  let h = w / aspectRatio
  if (h > Math.abs(endY - startY) && Math.abs(endY - startY) >= MIN_CROP_SIZE / aspectRatio) {
    h = Math.abs(endY - startY)
    w = h * aspectRatio
  }
  return clampRect({ x: signX > 0 ? startX : startX - w, y: signY > 0 ? startY : startY - h, w, h }, left, top, width, height, aspectRatio)
}
