import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { AppSettings, ContactSpeechVoice, SpeechCacheRecord } from '../types'
import { appFetch } from './appFetch'
import { isSpeechProviderReady } from './speechProviders'

const MAX_CACHE_BYTES = 100 * 1024 * 1024

export interface SynthesizedSpeech {
  blob: Blob
  mimeType: string
  durationMs?: number
}

function base64ToBlob(value: string, mimeType: string): Blob {
  const normalized = value.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '')
  let binary: string
  try {
    binary = atob(normalized)
  } catch {
    throw new Error('接口返回的音频 Base64 无法解码')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mimeType })
}

async function responseError(response: Response, provider: string): Promise<never> {
  const body = await response.text().catch(() => '')
  let detail = body.slice(0, 300)
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || parsed.message || detail
  } catch { /* keep text response */ }
  throw new Error(`${provider} 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`)
}

function doubaoHeaders(config: AppSettings['speechProviders']['doubao']): Record<string, string> {
  const common = {
    'Content-Type': 'application/json',
    'X-Api-Resource-Id': config.resourceId.trim(),
    'X-Api-Request-Id': uuid(),
  }
  if (config.authMode === 'apiKey') return { ...common, 'X-Api-Key': config.apiKey.trim() }
  return {
    ...common,
    'X-Api-App-Id': config.appId.trim(),
    'X-Api-Access-Key': config.accessKey.trim(),
  }
}

function parseDoubaoStream(body: string, mimeType: string): SynthesizedSpeech {
  const candidates = body.split(/\r?\n/).map((line) => line.trim().replace(/^data:\s*/, '')).filter(Boolean)
  if (candidates.length === 0) throw new Error('豆包语音返回了空响应')
  const fragments: string[] = []
  let durationMs: number | undefined
  let lastMessage = ''
  for (const candidate of candidates) {
    let packet: { code?: number; data?: string; message?: string; addition?: { duration?: string | number } }
    try {
      packet = JSON.parse(candidate) as typeof packet
    } catch {
      if (candidates.length === 1) throw new Error(`豆包语音返回了无法识别的数据：${candidate.slice(0, 120)}`)
      continue
    }
    if (packet.message) lastMessage = packet.message
    if (typeof packet.data === 'string' && packet.data) fragments.push(packet.data)
    const parsedDuration = Number(packet.addition?.duration)
    if (Number.isFinite(parsedDuration) && parsedDuration > 0) durationMs = parsedDuration
    if (packet.code !== undefined && ![0, 3000, 20000000].includes(packet.code) && !packet.data) {
      throw new Error(`豆包语音合成失败（${packet.code}）：${packet.message || '未知错误'}`)
    }
  }
  if (fragments.length === 0) throw new Error(`豆包语音没有返回音频${lastMessage ? `：${lastMessage}` : ''}`)
  const blobs = fragments.map((fragment) => base64ToBlob(fragment, mimeType))
  return { blob: new Blob(blobs, { type: mimeType }), mimeType, durationMs }
}

async function synthesizeDoubao(text: string, config: AppSettings['speechProviders']['doubao']): Promise<SynthesizedSpeech> {
  const byteLength = new TextEncoder().encode(text).byteLength
  if (byteLength > 1024) throw new Error('豆包单次合成最多支持 1024 字节，请选择较短的消息')
  const mimeType = config.format === 'ogg_opus' ? 'audio/ogg; codecs=opus' : 'audio/mpeg'
  const audioParams: Record<string, unknown> = {
    format: config.format,
    sample_rate: config.sampleRate,
    speech_rate: Math.round((config.speedRatio - 1) * 100),
    loudness_rate: Math.round((config.loudnessRatio - 1) * 100),
  }
  const reqParams: Record<string, unknown> = {
    text,
    speaker: config.speaker.trim(),
    audio_params: audioParams,
    additions: JSON.stringify({ disable_markdown_filter: true, enable_language_detector: true }),
  }
  if (config.emotion.trim()) {
    reqParams.emotion = config.emotion.trim()
    reqParams.emotion_scale = config.emotionScale
  }
  const response = await appFetch(config.baseUrl.trim(), {
    method: 'POST',
    headers: doubaoHeaders(config),
    body: JSON.stringify({ user: { uid: 'talk-user' }, req_params: reqParams }),
  })
  if (!response.ok) return responseError(response, '豆包语音')
  return parseDoubaoStream(await response.text(), mimeType)
}

async function synthesizeMimo(text: string, config: AppSettings['speechProviders']['mimo']): Promise<SynthesizedSpeech> {
  const endpoint = `${config.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  if (config.styleInstruction.trim()) messages.push({ role: 'user', content: config.styleInstruction.trim() })
  messages.push({ role: 'assistant', content: text })
  const response = await appFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': config.apiKey.trim() },
    body: JSON.stringify({
      model: config.model,
      messages,
      audio: { format: config.format, voice: config.voice.trim() },
      temperature: config.temperature,
      stream: false,
    }),
  })
  if (!response.ok) return responseError(response, '小米 MiMo')
  const payload = await response.json() as {
    choices?: Array<{ message?: { audio?: { data?: string } } }>
    error?: { message?: string }
  }
  const audio = payload.choices?.[0]?.message?.audio?.data
  if (!audio) throw new Error(`小米 MiMo 没有返回音频${payload.error?.message ? `：${payload.error.message}` : ''}`)
  const mimeType = config.format === 'wav' ? 'audio/wav' : 'audio/mpeg'
  return { blob: base64ToBlob(audio, mimeType), mimeType }
}

function settingsWithContactVoice(settings: Pick<AppSettings, 'speechProvider' | 'speechProviders'>, voice?: ContactSpeechVoice): Pick<AppSettings, 'speechProvider' | 'speechProviders'> {
  if (!voice || settings.speechProvider === 'none') return settings
  if (settings.speechProvider === 'doubao') return {
    ...settings,
    speechProviders: { ...settings.speechProviders, doubao: { ...settings.speechProviders.doubao, speaker: voice.voiceId } },
  }
  return {
    ...settings,
    speechProviders: {
      ...settings.speechProviders,
      mimo: {
        ...settings.speechProviders.mimo,
        voice: voice.voiceId,
        styleInstruction: voice.styleInstruction?.trim() || settings.speechProviders.mimo.styleInstruction,
      },
    },
  }
}

export async function synthesizeSpeech(text: string, settings: Pick<AppSettings, 'speechProvider' | 'speechProviders'>, voice?: ContactSpeechVoice): Promise<SynthesizedSpeech> {
  if (Array.isArray((settings as Partial<AppSettings>).enabledModules) && !(settings as Partial<AppSettings>).enabledModules!.includes('speech')) throw new Error('语音功能已关闭')
  const normalized = text.trim()
  if (!normalized) throw new Error('这条消息没有可朗读的文字')
  const resolved = settingsWithContactVoice(settings, voice)
  if (!isSpeechProviderReady(resolved)) throw new Error('请先在“其他接口 / 语音生成”中完成服务配置')
  if (resolved.speechProvider === 'doubao') return synthesizeDoubao(normalized, resolved.speechProviders.doubao)
  if (resolved.speechProvider === 'mimo') return synthesizeMimo(normalized, resolved.speechProviders.mimo)
  throw new Error('请先选择语音生成服务')
}

function signatureSource(text: string, settings: Pick<AppSettings, 'speechProvider' | 'speechProviders'>, voice?: ContactSpeechVoice): string {
  const resolved = settingsWithContactVoice(settings, voice)
  const provider = resolved.speechProvider
  const config = provider === 'doubao'
    ? resolved.speechProviders.doubao
    : provider === 'mimo'
      ? resolved.speechProviders.mimo
      : null
  if (!config) return `none:${text}`
  const safeConfig = { ...config } as Record<string, unknown>
  delete safeConfig.apiKey
  delete safeConfig.accessKey
  return JSON.stringify([provider, safeConfig, text])
}

export function speechSignature(text: string, settings: Pick<AppSettings, 'speechProvider' | 'speechProviders'>, voice?: ContactSpeechVoice): string {
  const source = signatureSource(text, settings, voice)
  let hash = 2166136261
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `v1-${(hash >>> 0).toString(16)}-${source.length}`
}

async function trimSpeechCache(): Promise<void> {
  const rows = await db.speechCache.orderBy('lastAccessedAt').toArray()
  let total = rows.reduce((sum, row) => sum + row.size, 0)
  const deleteIds: string[] = []
  for (const row of rows) {
    if (total <= MAX_CACHE_BYTES) break
    total -= row.size
    deleteIds.push(row.id)
  }
  if (deleteIds.length > 0) await db.speechCache.bulkDelete(deleteIds)
}

export async function cacheSpeechForMessage(
  messageId: string,
  text: string,
  settings: Pick<AppSettings, 'speechProvider' | 'speechProviders'>,
  force = false,
  voice?: ContactSpeechVoice,
): Promise<SpeechCacheRecord> {
  const signature = speechSignature(text, settings, voice)
  const existing = await db.speechCache.get(messageId)
  if (!force && existing?.signature === signature) {
    await db.speechCache.update(messageId, { lastAccessedAt: Date.now() })
    return { ...existing, lastAccessedAt: Date.now() }
  }
  const result = await synthesizeSpeech(text, settings, voice)
  const now = Date.now()
  const provider = settings.speechProvider
  if (provider === 'none') throw new Error('请先选择语音生成服务')
  const record: SpeechCacheRecord = {
    id: messageId,
    messageId,
    signature,
    provider,
    mimeType: result.mimeType,
    audio: result.blob,
    size: result.blob.size,
    durationMs: result.durationMs,
    createdAt: now,
    lastAccessedAt: now,
  }
  await db.speechCache.put(record)
  await trimSpeechCache()
  return record
}

export async function speechCacheStats(): Promise<{ count: number; bytes: number }> {
  const rows = await db.speechCache.toArray()
  return { count: rows.length, bytes: rows.reduce((sum, row) => sum + row.size, 0) }
}
