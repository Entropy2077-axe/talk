import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'
import { useChatUiStore } from '../store/useChatUiStore'
import type { AiImageKind, AppSettings, Contact, MediaAsset } from '../types'
import { chatCompletionText } from './deepseek'
import { traceTurnEvent } from './deepseek'
import { appFetch } from './appFetch'
import { generateRemoteImage } from './remoteMedia'

const active = new Set<string>()
const identityWork = new Map<string, Promise<string>>()

const STYLE_PROMPTS = {
  'asian-realistic': 'authentic contemporary Asian people, realistic casual smartphone photography, natural skin texture, ordinary natural lighting, candid social-media composition',
  'european-realistic': 'authentic contemporary European people, realistic casual smartphone photography, natural skin texture, ordinary natural lighting, candid social-media composition',
  anime: 'high-quality modern 2D anime illustration, clean expressive line art, soft cel shading, consistent character design',
} as const

function atlasStylePrompt(settings: AppSettings): string {
  const atlas = settings.imageProviders.atlas
  return atlas.visualStyle === 'custom'
    ? atlas.customVisualStyle.trim()
    : STYLE_PROMPTS[atlas.visualStyle]
}

function fallbackContactIdentity(contact: Contact): string {
  const facts = contact.systemPrompt.slice(0, 240)
  return `${contact.name}, ${contact.gender || 'adult person'}, stable recognizable facial features and hairstyle, ${facts}`
}

function fallbackUserIdentity(settings: AppSettings): string {
  return `${settings.userNickname || 'the user'}, ${settings.userGender || 'adult person'}, stable recognizable facial features and hairstyle, ${settings.userBio || 'natural everyday appearance'}`
}

async function generateIdentity(label: string, context: string, settings: AppSettings): Promise<string> {
  if (!settings.apiKey.trim()) return context
  try {
    return (await chatCompletionText({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.utilityModel || settings.model,
      provider: settings.aiProvider,
      purpose: 'other',
      automatic: true,
      thinking: 'disabled',
      temperature: 0.4,
      maxTokens: 220,
      messages: [
        { role: 'system', content: 'Write one concise English visual identity for consistent image generation. Include apparent adult age, face shape, eyes, nose, lips, skin tone, hairstyle, build, and distinctive permanent features. Never include clothes, pose, scene, lighting, camera, mood, ethnicity not established by the input, or art style. Output only the description.' },
        { role: 'user', content: `${label}\n${context.slice(0, 1800)}` },
      ],
    })).trim().slice(0, 800) || context
  } catch {
    return context
  }
}

export async function ensureContactVisualIdentity(contact: Contact, settings: AppSettings): Promise<Contact> {
  if (contact.visualIdentity?.trim() && typeof contact.visualSeed === 'number') return contact
  const key = `contact:${contact.id}`
  let work = identityWork.get(key)
  if (!work) {
    work = generateIdentity(`Character: ${contact.name}`, fallbackContactIdentity(contact), settings)
    identityWork.set(key, work)
  }
  const visualIdentity = contact.visualIdentity?.trim() || await work
  const visualSeed = typeof contact.visualSeed === 'number' ? contact.visualSeed : Math.floor(Math.random() * 2_147_483_647)
  await db.contacts.update(contact.id, { visualIdentity, visualSeed })
  identityWork.delete(key)
  return { ...contact, visualIdentity, visualSeed }
}

export async function ensureUserVisualIdentity(settings: AppSettings): Promise<{ visualIdentity: string; visualSeed: number }> {
  if (settings.userVisualIdentity?.trim() && typeof settings.userVisualSeed === 'number') {
    return { visualIdentity: settings.userVisualIdentity.trim(), visualSeed: settings.userVisualSeed }
  }
  const key = 'user'
  let work = identityWork.get(key)
  if (!work) {
    work = generateIdentity(`User: ${settings.userNickname || 'User'}`, fallbackUserIdentity(settings), settings)
    identityWork.set(key, work)
  }
  const visualIdentity = settings.userVisualIdentity?.trim() || await work
  const visualSeed = typeof settings.userVisualSeed === 'number' ? settings.userVisualSeed : Math.floor(Math.random() * 2_147_483_647)
  useSettingsStore.getState().setSettings({ userVisualIdentity: visualIdentity, userVisualSeed: visualSeed })
  identityWork.delete(key)
  return { visualIdentity, visualSeed }
}

export async function regenerateContactVisualIdentity(contact: Contact, settings: AppSettings): Promise<string> {
  return generateIdentity(`Character: ${contact.name}`, fallbackContactIdentity({ ...contact, visualIdentity: undefined }), settings)
}

export async function regenerateUserVisualIdentity(settings: AppSettings): Promise<string> {
  return generateIdentity(`User: ${settings.userNickname || 'User'}`, fallbackUserIdentity({ ...settings, userVisualIdentity: undefined }), settings)
}

function combinedSeed(seeds: number[]): number {
  let hash = 2166136261
  for (const seed of seeds) {
    hash ^= seed
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash | 0) || 1
}

export function visualIdentitySeed(identity: string): number {
  return combinedSeed(Array.from(identity || 'Talk character', (character) => character.codePointAt(0) || 0))
}

export function composeImagePrompt(input: {
  scene: string
  kind: AiImageKind
  contacts: Contact[]
  includeUser: boolean
  settings: AppSettings
  userIdentity?: string
  provider?: AppSettings['imageProvider']
  stylePrompt?: string
}): string {
  const { scene, kind, contacts, includeUser, settings } = input
  const style = (input.provider ?? settings.imageProvider) === 'atlas'
    ? input.stylePrompt ?? atlasStylePrompt(settings)
    : ''
  const people = [
    ...contacts.map((contact) => ({ name: contact.name, identity: contact.visualIdentity || fallbackContactIdentity(contact) })),
    ...(includeUser ? [{ name: settings.userNickname || 'User', identity: input.userIdentity || fallbackUserIdentity(settings) }] : []),
  ].slice(0, 4)
  const labels = people.map((person, index) => `Person ${String.fromCharCode(65 + index)} (${person.name}): ${person.identity}`).join('\n')
  const countRule = people.length
    ? `Show exactly ${people.length} distinct ${people.length === 1 ? 'person' : 'people'}. Preserve each identity, do not blend faces, duplicate people, swap features, or add extra people.`
    : 'No people in the image unless an incidental distant figure is essential to the scene.'
  const kindRule = kind === 'selfie' ? 'casual handheld selfie composition' : kind === 'portrait' ? 'natural portrait composition' : kind === 'group' ? 'balanced group photo composition with each person clearly distinguishable' : kind === 'object' ? 'object-focused composition' : 'environment-focused composition'
  return [style, kindRule, `Image request from the JSON query (follow this request faithfully):\n${scene}`, labels, countRule, 'Choose scene-appropriate clothing and natural poses. Correct anatomy and hands. No watermark, captions, UI, or unrelated text.'].filter(Boolean).join('\n')
}

export interface CreateMediaAssetInput {
  origin: MediaAsset['origin']
  originId: string
  conversationId?: string
  turnId?: string
  ownerContactIds: string[]
  includeUser?: boolean
  scene: string
  kind?: AiImageKind
  settings: AppSettings
  size?: string
}

export async function createMediaAsset(input: CreateMediaAssetInput): Promise<MediaAsset> {
  if (input.settings.imageProvider === 'none') throw new Error('未启用生图服务')
  const now = Date.now()
  const asset: MediaAsset = {
    id: uuid(), origin: input.origin, originId: input.originId, conversationId: input.conversationId, turnId: input.turnId,
    ownerContactIds: input.ownerContactIds.slice(0, 4), includeUser: input.includeUser,
    provider: input.settings.imageProvider, status: 'queued', phase: 'queued', scene: input.scene,
    kind: input.kind ?? (input.ownerContactIds.length || input.includeUser ? 'portrait' : 'scene'), prompt: input.scene,
    stylePrompt: input.settings.imageProvider === 'atlas' ? atlasStylePrompt(input.settings) : undefined,
    providerPromptPrefix: input.settings.imageProvider === 'atlas' ? input.settings.imageProviders.atlas.promptPrefix : undefined,
    modelId: input.settings.imageProvider === 'atlas' ? input.settings.imageProviders.atlas.model : undefined,
    size: input.size || (input.settings.imageProvider === 'atlas' ? input.settings.imageProviders.atlas.size : undefined),
    attempt: 0, createdAt: now, updatedAt: now,
  }
  await db.mediaAssets.add(asset)
  return asset
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取结果格式错误'))
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

async function persistResult(url: string): Promise<Pick<MediaAsset, 'dataUrl' | 'remoteUrl' | 'mimeType'>> {
  if (url.startsWith('data:image/')) return { dataUrl: url, mimeType: url.slice(5, url.indexOf(';')) }
  try {
    const response = await appFetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    if (!blob.type.startsWith('image/') || blob.size === 0) throw new Error('返回内容不是图片')
    return { dataUrl: await blobToDataUrl(blob), remoteUrl: url, mimeType: blob.type }
  } catch {
    return { remoteUrl: url }
  }
}

async function notifyChatImageCompleted(asset: MediaAsset): Promise<void> {
  if (asset.origin !== 'chat' || !asset.conversationId || useChatUiStore.getState().activeConversationId === asset.conversationId) return
  const conversation = await db.conversations.get(asset.conversationId)
  if (!conversation) return
  if (conversation.groupId) {
    const group = await db.groups.get(conversation.groupId)
    if (!group) return
    useChatUiStore.getState().showNotification({ id: uuid(), conversationId: conversation.id, contactName: group.name, contactAvatar: group.avatar, contactAvatarColor: group.avatarColor, preview: '图片已生成' })
    return
  }
  const message = await db.messages.get(asset.originId)
  const contact = await db.contacts.get(message?.speakerContactId || conversation.contactId || asset.ownerContactIds[0])
  if (!contact) return
  useChatUiStore.getState().showNotification({ id: uuid(), conversationId: conversation.id, contactName: contact.remark || contact.nickname || contact.name, contactAvatar: contact.avatar, contactAvatarColor: contact.avatarColor, preview: '图片已生成' })
}

async function runAsset(assetId: string): Promise<void> {
  const asset = await db.mediaAssets.get(assetId)
  if (!asset || asset.status === 'completed') return
  const startedAt = Date.now()
  const settings = useSettingsStore.getState()
  let prompt = asset.prompt
  let seed = asset.seed
  if (asset.attempt === 0) {
    const contacts = (await Promise.all(asset.ownerContactIds.map((id) => db.contacts.get(id)))).filter((value): value is Contact => !!value)
    const stableContacts = await Promise.all(contacts.map((contact) => ensureContactVisualIdentity(contact, settings)))
    const user = asset.includeUser ? await ensureUserVisualIdentity(settings) : undefined
    prompt = composeImagePrompt({ scene: asset.scene, kind: asset.kind, contacts: stableContacts, includeUser: !!asset.includeUser, settings, userIdentity: user?.visualIdentity, provider: asset.provider, stylePrompt: asset.stylePrompt })
    if (asset.provider === 'atlas' && asset.providerPromptPrefix?.trim()) prompt = `${asset.providerPromptPrefix.trim()}\n${prompt}`
    const identitySeeds = [...stableContacts.map((contact) => contact.visualSeed!), ...(user ? [user.visualSeed] : [])]
    seed = identitySeeds.length ? combinedSeed(identitySeeds) : Math.floor(Math.random() * 2_147_483_647)
  }
  await db.mediaAssets.update(assetId, { status: asset.predictionId ? 'polling' : 'submitting', phase: asset.predictionId ? 'polling' : 'submitting', prompt, seed, attempt: asset.attempt + 1, updatedAt: Date.now(), error: undefined })
  const imageProviders = structuredClone(settings.imageProviders)
  if (asset.provider === 'atlas') {
    if (asset.modelId) imageProviders.atlas.model = asset.modelId
    if (asset.size) imageProviders.atlas.size = asset.size
    imageProviders.atlas.promptPrefix = ''
  }
  const result = await generateRemoteImage({ imageProvider: asset.provider, imageProviders }, prompt, {
    predictionId: asset.predictionId,
    seed,
    onPredictionId: (predictionId) => db.mediaAssets.update(assetId, { predictionId, status: 'polling', phase: 'polling', updatedAt: Date.now() }).then(() => undefined),
    onProgress: (progress) => { void db.mediaAssets.update(assetId, { status: progress.stage === 'queued' ? 'polling' : progress.stage === 'submitting' ? 'submitting' : 'generating', phase: progress.stage === 'queued' ? 'polling' : progress.stage === 'submitting' ? 'submitting' : 'generating', updatedAt: Date.now() }) },
  })
  if (!result) throw new Error('生图服务没有返回图片')
  const persisted = await persistResult(result.url)
  await db.mediaAssets.update(assetId, { ...persisted, status: 'completed', phase: 'completed', completedAt: Date.now(), updatedAt: Date.now(), error: undefined })
  void traceTurnEvent({ turnId: asset.turnId, conversationId: asset.conversationId, stage: 'image_generation', input: prompt, output: `生成完成：assetId=${assetId}\n${persisted.dataUrl ? '[本地图片已保存]' : persisted.remoteUrl ?? '无图片地址'}`, durationMs: Date.now() - startedAt, diagnostics: { assetId, provider: asset.provider, remoteUrl: persisted.remoteUrl } })
  await notifyChatImageCompleted(asset)
}

export function startMediaAsset(assetId: string): void {
  if (active.has(assetId)) return
  active.add(assetId)
  void runAsset(assetId)
    .catch((error) => db.mediaAssets.update(assetId, { status: 'failed', phase: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() }))
    .finally(() => active.delete(assetId))
}

export async function retryMediaAsset(assetId: string): Promise<void> {
  const asset = await db.mediaAssets.get(assetId)
  if (!asset) return
  const terminal = /生图失败|标记任务完成|没有返回图片/i.test(asset.error || '')
  await db.mediaAssets.update(assetId, { status: 'queued', phase: 'queued', error: undefined, ...(terminal ? { predictionId: undefined } : {}), updatedAt: Date.now() })
  startMediaAsset(assetId)
}

export async function resumeMediaAssets(): Promise<void> {
  const pending = await db.mediaAssets.where('status').anyOf('queued', 'submitting', 'polling', 'generating').toArray()
  for (const asset of pending) {
    if (asset.provider === 'atlas' || asset.status === 'queued') startMediaAsset(asset.id)
    else await db.mediaAssets.update(asset.id, { status: 'failed', phase: 'failed', error: '应用关闭时任务尚未完成，请手动重试', updatedAt: Date.now() })
  }
}
