import { formatBubbleTime } from './time'
import type { Message } from '../types'

export interface ChatCaptureSpeaker {
  name: string
  avatar: string
  avatarColor: string
}

export interface ChatCaptureOptions {
  title: string
  messages: Message[]
  speakerFor: (message: Message) => ChatCaptureSpeaker
  user: ChatCaptureSpeaker
  stickerUrlFor?: (message: Message) => string | undefined
}

const WIDTH = 750
const PADDING_X = 28
const AVATAR = 52
const GAP = 14
const MAX_BUBBLE_WIDTH = 455
const LINE_HEIGHT = 34
const FONT = '28px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const META_FONT = '20px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const char of Array.from(paragraph)) {
      const next = line + char
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line)
        line = char
      } else {
        line = next
      }
    }
    lines.push(line || ' ')
  }
  return lines
}

function drawAvatar(ctx: CanvasRenderingContext2D, speaker: ChatCaptureSpeaker, x: number, y: number) {
  ctx.save()
  roundedRect(ctx, x, y, AVATAR, AVATAR, 14)
  ctx.fillStyle = speaker.avatar.startsWith('data:') ? '#eef0f3' : speaker.avatarColor || '#eef0f3'
  ctx.fill()
  ctx.clip()
  if (speaker.avatar.startsWith('data:')) {
    // Data URL avatars could be drawn asynchronously, but keeping captures
    // synchronous avoids tainted-canvas and timing problems. Use a clean badge.
    ctx.fillStyle = '#dbe1ea'
    ctx.fillRect(x, y, AVATAR, AVATAR)
    ctx.fillStyle = '#667085'
    ctx.font = '22px system-ui'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText((speaker.name || '?').slice(0, 1).toUpperCase(), x + AVATAR / 2, y + AVATAR / 2)
  } else {
    ctx.font = '30px system-ui, "Apple Color Emoji", "Segoe UI Emoji"'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(speaker.avatar || '🙂', x + AVATAR / 2, y + AVATAR / 2 + 1)
  }
  ctx.restore()
}

function messageText(message: Message): string {
  if (message.type === 'sticker') return `[表情] ${message.content}`
  if (message.type === 'link') return `[链接] ${message.link?.label ?? message.content}`
  if (message.type === 'gift') return `送出了「${message.gift?.name ?? message.content}」`
  if (message.type === 'scheduleChange') return `[日程] ${message.scheduleChange?.summary ?? message.content}`
  return message.content
}

function measureMessage(ctx: CanvasRenderingContext2D, message: Message): { width: number; height: number; lines: string[] } {
  ctx.font = FONT
  if (message.type === 'sticker') return { width: 180, height: 150, lines: [messageText(message)] }
  const lines = wrapText(ctx, messageText(message), MAX_BUBBLE_WIDTH - 32)
  const textWidth = Math.min(
    MAX_BUBBLE_WIDTH,
    Math.max(96, ...lines.map((line) => ctx.measureText(line).width + 32)),
  )
  return { width: textWidth, height: Math.max(58, lines.length * LINE_HEIGHT + 24), lines }
}

function drawBubble(
  ctx: CanvasRenderingContext2D,
  message: Message,
  speaker: ChatCaptureSpeaker,
  user: ChatCaptureSpeaker,
  y: number,
) {
  const isUser = message.role === 'user'
  const { width, height, lines } = measureMessage(ctx, message)
  const avatarX = isUser ? WIDTH - PADDING_X - AVATAR : PADDING_X
  const bubbleX = isUser ? avatarX - GAP - width : PADDING_X + AVATAR + GAP
  const nameX = isUser ? bubbleX + width : bubbleX
  const name = isUser ? user.name : speaker.name

  drawAvatar(ctx, isUser ? user : speaker, avatarX, y + 26)

  ctx.font = META_FONT
  ctx.fillStyle = '#9ca3af'
  ctx.textAlign = isUser ? 'right' : 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(`${name}  ${formatBubbleTime(message.createdAt)}`, nameX, y)

  roundedRect(ctx, bubbleX, y + 28, width, height, 18)
  ctx.fillStyle = isUser ? '#95ec69' : '#ffffff'
  ctx.fill()

  if (message.type === 'sticker') {
    ctx.fillStyle = '#f3f4f6'
    roundedRect(ctx, bubbleX + 16, y + 44, width - 32, height - 32, 14)
    ctx.fill()
    ctx.fillStyle = '#6b7280'
    ctx.font = '24px system-ui'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(messageText(message), bubbleX + width / 2, y + 28 + height / 2)
    return
  }

  ctx.font = FONT
  ctx.fillStyle = '#111827'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  lines.forEach((line, index) => {
    ctx.fillText(line, bubbleX + 16, y + 40 + index * LINE_HEIGHT)
  })
}

export async function generateChatCaptureImage(options: ChatCaptureOptions): Promise<string> {
  const measureCanvas = document.createElement('canvas')
  const measureCtx = measureCanvas.getContext('2d')
  if (!measureCtx) throw new Error('当前环境不支持Canvas')

  const rows = options.messages.map((message) => {
    const measured = measureMessage(measureCtx, message)
    return { message, height: measured.height + 64 }
  })
  const contentHeight = rows.reduce((sum, row) => sum + row.height, 0)
  const height = Math.max(260, 92 + contentHeight + 46)
  const canvas = document.createElement('canvas')
  const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
  canvas.width = WIDTH * scale
  canvas.height = height * scale
  canvas.style.width = `${WIDTH}px`
  canvas.style.height = `${height}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前环境不支持Canvas')
  ctx.scale(scale, scale)
  ctx.fillStyle = '#ededed'
  ctx.fillRect(0, 0, WIDTH, height)

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, WIDTH, 72)
  ctx.fillStyle = '#111827'
  ctx.font = '28px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(options.title, WIDTH / 2, 36)
  ctx.fillStyle = '#9ca3af'
  ctx.font = META_FONT
  ctx.fillText(`${options.messages.length} 条聊天记录`, WIDTH / 2, 92)

  let y = 116
  for (const row of rows) {
    drawBubble(ctx, row.message, options.speakerFor(row.message), options.user, y)
    y += row.height
  }

  ctx.fillStyle = '#b5b5b5'
  ctx.font = '18px system-ui'
  ctx.textAlign = 'center'
  ctx.fillText('由 Talk 生成', WIDTH / 2, height - 24)
  return canvas.toDataURL('image/png')
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export async function shareDataUrl(dataUrl: string, filename: string): Promise<boolean> {
  if (!navigator.share) return false
  const blob = await (await fetch(dataUrl)).blob()
  const file = new File([blob], filename, { type: 'image/png' })
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean }
  if (nav.canShare && !nav.canShare({ files: [file] })) return false
  await navigator.share({ files: [file], title: '聊天记录截图' })
  return true
}
