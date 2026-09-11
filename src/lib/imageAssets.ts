import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'
import { useChatUiStore } from '../store/useChatUiStore'
import type { AiImageAspectRatio, AiImageKind, AppSettings, Contact, MediaAsset, Message } from '../types'
import { chatCompletionText } from './deepseek'
import { traceTurnEvent } from './deepseek'
import { appFetch } from './appFetch'
import { generateRemoteImage } from './remoteMedia'
import { parseJsonLoose } from './aiProtocol'
import { atlasImageModelPreset } from './mediaProviders'

const active = new Set<string>()
const identityWork = new Map<string, Promise<string>>()

const STYLE_PROMPTS = {
  'asian-realistic': 'authentic contemporary Asian people, realistic casual personal photography, natural skin texture, ordinary natural lighting, candid everyday composition',
  'european-realistic': 'authentic contemporary European people, realistic casual personal photography, natural skin texture, ordinary natural lighting, candid everyday composition',
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
  aspectRatio?: AiImageAspectRatio
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
  const kindRule = kind === 'selfie' ? 'natural selfie-style viewpoint with framing wide enough to preserve the requested pose, ongoing action, clothing, and surrounding environment; the photographing equipment stays outside the frame' : kind === 'portrait' ? 'person-centered environmental photograph with body language, ongoing action, and surrounding context clearly visible' : kind === 'group' ? 'balanced group photo composition with each person clearly distinguishable' : kind === 'object' ? 'object-focused composition' : 'environment-focused composition'
  const ratioRule = input.aspectRatio ? `Compose specifically for a ${input.aspectRatio} aspect ratio; use the extra frame area for meaningful action and environment.` : ''
  return [style, kindRule, ratioRule, `Visual scene to render faithfully:\n${scene}`, labels, countRule, 'Choose scene-appropriate clothing and natural poses. Correct anatomy and hands. The result is one uninterrupted real-world scene: no visible phones or screens, no chat elements, no interface, no panels, no collage, no symbols, no watermark, and no readable text of any kind.'].filter(Boolean).join('\n')
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
  width?: number
  height?: number
  aspectRatio?: AiImageAspectRatio
}

export interface CreateConversationIllustrationInput {
  conversationId: string
  turnId: string
  ownerContactIds: string[]
  participantNames: string[]
  latestUserText?: string
  replyText: string
  mood?: string
  context?: string
  settings: AppSettings
  createdAt: number
  presentation?: 'illustration' | 'sent'
  requestedKind?: AiImageKind
  speakerContactId?: string
}

interface ConversationImagePlan {
  prompt: string
  caption: string
  kind: AiImageKind
  includeUser: boolean
  aspectRatio: AiImageAspectRatio
}

const IMAGE_KIND_VALUES: AiImageKind[] = ['selfie', 'portrait', 'group', 'scene', 'object']
const IMAGE_ASPECT_RATIO_VALUES: AiImageAspectRatio[] = ['1:1', '4:3', '3:4', '16:9', '9:16']

/** Recognises direct requests that must produce a real chat image event. */
export function detectExplicitImageRequest(value: string): AiImageKind | null {
  const text = value.trim()
  if (!text) return null
  if (/(?:拍|发|来|给|看|想看|看看).{0,10}(?:自拍|自拍照)|(?:自拍|自拍照).{0,10}(?:拍|发|来|给|看|看看)/.test(text)) return 'selfie'
  if (/(?:拍|发|来|给我|让我看|看看).{0,10}(?:照片|相片|合照|近照|张照)|(?:照片|相片|合照|近照).{0,10}(?:拍|发|来|给我|看看)/.test(text)) return 'portrait'
  return null
}

export function buildConversationIllustrationDirectorPrompt(input: Pick<CreateConversationIllustrationInput, 'participantNames' | 'latestUserText' | 'replyText' | 'mood' | 'context' | 'presentation' | 'requestedKind'>): string {
  const names = input.participantNames.filter(Boolean).join(', ') || 'the conversation participants'
  const requested = input.presentation === 'sent'
  return [
    '你是影视分镜师。根据下方素材规划一张真实世界中的独立画面，而不是把素材本身画进图片。只输出 JSON：{"prompt":"...","caption":"...","kind":"selfie|portrait|group|scene|object","includeUser":false,"aspectRatio":"1:1|4:3|3:4|16:9|9:16"}。',
    'prompt 必须是 60-180 个英文单词的纯视觉场景描述，只写镜头实际看得到的人物、环境、动作、构图、光线与情绪。严禁出现或提及聊天、消息、对白、手机屏幕、聊天框、UI、文字、字幕、标牌、拼贴、分屏、信息图；严禁复制素材里的任何句子或词语。将交流的含义转译成一个自然瞬间。',
    '用户指定的动作、姿势、地点、服装、道具和镜头范围具有最高视觉优先级，必须逐项写入 prompt。不得把有动作或环境的要求简化成正对镜头的头像、证件照、棚拍半身像或空背景肖像；人物身份描述只用于保持长相，不能取代事件内容。',
    'caption 必须是 15-50 个汉字的自然中文，说明这张图表现了什么和它对应的情绪，不要使用“模型、提示词、本轮配图”等系统术语。',
    '只有素材明确说明人物处于同一地点时，才可让远程人物与用户同框；否则 includeUser=false。',
    'aspectRatio 必须按内容选择：动作明显、全身或日常自拍优先 3:4；需要大量纵向环境时选 9:16；多人或横向环境优先 4:3 或 16:9。只有中心对称、物品特写等确实适合方图的内容才选 1:1，普通自拍禁止默认选 1:1。',
    requested
      ? `这是用户明确索要的真实照片。必须准确落实用户想看的内容；kind=${input.requestedKind ?? 'portrait'}。若为自拍，只采用自拍视角，不强制人物正面站定或占满画面；动作和背景必须保留，拍摄设备不可见，画面中不得出现任何屏幕。`
      : '这是氛围配图：选取交流背后最有画面感的现实瞬间，不要表现人物正在聊天或查看消息。',
    `可用角色：${names}`,
    input.context?.trim() ? `情境素材：${input.context.trim().slice(0, 1_200)}` : '',
    input.latestUserText?.trim() ? `用户原话（只理解含义，不得复制进英文画面）：${input.latestUserText.trim().slice(0, 700)}` : '',
    input.replyText.trim() ? `角色回应（只理解含义，不得复制进英文画面）：${input.replyText.trim().slice(0, 1_400)}` : '',
    input.mood?.trim() ? `情绪：${input.mood.trim().slice(0, 80)}` : '',
  ].filter(Boolean).join('\n\n')
}

function fallbackConversationImagePlan(input: CreateConversationIllustrationInput): ConversationImagePlan {
  const requested = input.presentation === 'sent'
  const kind = input.requestedKind ?? (input.ownerContactIds.length > 1 ? 'group' : requested ? 'selfie' : 'portrait')
  return {
    prompt: requested
      ? 'A spontaneous vertical everyday photo of the established character naturally engaged in an ongoing activity, expressive body language, clothing and hands clearly visible, with meaningful room around the subject showing a lived-in environment, realistic ambient light, off-center candid framing, coherent anatomy and a believable sense of place.'
      : 'A natural environmental photograph of the established character engaged in an ordinary ongoing activity, expressive body language and hands clearly visible, with the surrounding location carrying the emotional atmosphere of the moment, realistic ambient light, layered depth, off-center cinematic framing and coherent anatomy.',
    caption: requested ? '这是对方按你的要求拍下的此刻模样。' : '画面记录了角色此刻的状态，也承接了刚才交流的情绪。',
    kind,
    includeUser: false,
    aspectRatio: kind === 'selfie' || kind === 'portrait' ? '3:4' : kind === 'group' || kind === 'scene' ? '4:3' : '1:1',
  }
}

async function planConversationImage(input: CreateConversationIllustrationInput): Promise<ConversationImagePlan> {
  const fallback = fallbackConversationImagePlan(input)
  if (!input.settings.apiKey.trim()) return fallback
  try {
    const raw = await chatCompletionText({
      apiKey: input.settings.apiKey,
      baseUrl: input.settings.baseUrl,
      model: input.settings.utilityModel || input.settings.model,
      provider: input.settings.aiProvider,
      purpose: 'other',
      automatic: true,
      thinking: 'disabled',
      temperature: 0.25,
      maxTokens: 700,
      jsonMode: true,
      trace: { turnId: input.turnId, conversationId: input.conversationId, stage: 'image_generation' },
      messages: [{ role: 'system', content: buildConversationIllustrationDirectorPrompt(input) }],
    })
    const parsed = parseJsonLoose<Partial<ConversationImagePlan>>(raw)
    const prompt = typeof parsed?.prompt === 'string' ? parsed.prompt.trim().slice(0, 1_800) : ''
    const caption = typeof parsed?.caption === 'string' ? parsed.caption.trim().slice(0, 120) : ''
    const kind = IMAGE_KIND_VALUES.includes(parsed?.kind as AiImageKind) ? parsed!.kind as AiImageKind : fallback.kind
    const aspectRatio = IMAGE_ASPECT_RATIO_VALUES.includes(parsed?.aspectRatio as AiImageAspectRatio) ? parsed!.aspectRatio as AiImageAspectRatio : fallback.aspectRatio
    if (!prompt || !caption) return fallback
    const finalKind = input.requestedKind ?? kind
    const finalAspectRatio = finalKind === 'selfie' && aspectRatio === '1:1' ? '3:4' : aspectRatio
    const faithfulPrompt = input.requestedKind === 'selfie'
      ? `Selfie-style first-person camera viewpoint. Preserve the requested action, pose, clothing, and environmental background instead of converting the scene into a centered headshot; all photographing equipment remains outside the frame. ${prompt}`
      : prompt
    return { prompt: faithfulPrompt, caption, kind: finalKind, includeUser: parsed?.includeUser === true, aspectRatio: finalAspectRatio }
  } catch {
    return fallback
  }
}

/**
 * Create the durable, system-presented illustration for one completed chat
 * turn. A utility model first translates the dialogue into a visual-only
 * scene; composeImagePrompt() then adds stable faces and provider styling.
 */
export async function createConversationIllustration(input: CreateConversationIllustrationInput): Promise<Message | undefined> {
  if (input.settings.imageProvider === 'none') return undefined
  const presentation = input.presentation ?? 'illustration'
  const existing = await db.messages.where('conversationId').equals(input.conversationId)
    .filter((message) => message.debugAiTurnId === input.turnId && message.image?.presentation === presentation)
    .first()
  if (existing) return existing

  const plan = await planConversationImage(input)
  const messageId = uuid()
  const asset = await createMediaAsset({
    origin: presentation === 'illustration' ? 'chat-illustration' : 'chat',
    originId: messageId,
    conversationId: input.conversationId,
    turnId: input.turnId,
    ownerContactIds: input.ownerContactIds,
    includeUser: plan.includeUser,
    scene: plan.prompt,
    kind: plan.kind,
    aspectRatio: plan.aspectRatio,
    settings: input.settings,
  })
  const message: Message = {
    id: messageId,
    conversationId: input.conversationId,
    role: 'assistant',
    type: 'image',
    content: presentation === 'illustration' ? '[本轮配图]' : '[图片]',
    image: { assetId: asset.id, query: plan.prompt, caption: plan.caption, provider: asset.provider, presentation },
    speakerContactId: input.speakerContactId,
    debugAiTurnId: input.turnId,
    createdAt: input.createdAt,
  }
  try {
    await db.messages.add(message)
  } catch (error) {
    await db.mediaAssets.delete(asset.id)
    throw error
  }
  startMediaAsset(asset.id)
  return message
}

function dimensionsForAspectRatio(settings: AppSettings, aspectRatio: AiImageAspectRatio): { size?: string; width?: number; height?: number } {
  const [ratioWidth, ratioHeight] = aspectRatio.split(':').map(Number)
  const target = ratioWidth / ratioHeight
  if (settings.imageProvider === 'atlas') {
    const preset = atlasImageModelPreset(settings.imageProviders.atlas.model)
    if (preset?.includeSize === false) return {}
    const sizes = preset?.sizes.length ? preset.sizes : ['1024*1024', '1536*1024', '1024*1536']
    const selected = sizes
      .map((size) => {
        const [width, height] = size.split('*').map(Number)
        return { size, distance: Math.abs(Math.log((width / height) / target)) }
      })
      .filter((candidate) => Number.isFinite(candidate.distance))
      .sort((a, b) => a.distance - b.distance)[0]
    return selected ? { size: selected.size } : {}
  }
  if (settings.imageProvider === 'novelai') {
    if (aspectRatio === '1:1') return { width: 1024, height: 1024 }
    return target > 1 ? { width: 1216, height: 832 } : { width: 832, height: 1216 }
  }
  if (settings.imageProvider === 'comfyui' || settings.imageProvider === 'stable-diffusion') {
    if (aspectRatio === '1:1') return { width: 768, height: 768 }
    return target > 1 ? { width: 1024, height: 768 } : { width: 768, height: 1024 }
  }
  return {}
}

export async function createMediaAsset(input: CreateMediaAssetInput): Promise<MediaAsset> {
  if (input.settings.imageProvider === 'none') throw new Error('未启用生图服务')
  const now = Date.now()
  const dimensions = input.aspectRatio ? dimensionsForAspectRatio(input.settings, input.aspectRatio) : undefined
  const asset: MediaAsset = {
    id: uuid(), origin: input.origin, originId: input.originId, conversationId: input.conversationId, turnId: input.turnId,
    ownerContactIds: input.ownerContactIds.slice(0, 4), includeUser: input.includeUser,
    provider: input.settings.imageProvider, status: 'queued', phase: 'queued', scene: input.scene,
    kind: input.kind ?? (input.ownerContactIds.length || input.includeUser ? 'portrait' : 'scene'), prompt: input.scene,
    stylePrompt: input.settings.imageProvider === 'atlas' ? atlasStylePrompt(input.settings) : undefined,
    providerPromptPrefix: input.settings.imageProvider === 'atlas' ? input.settings.imageProviders.atlas.promptPrefix : undefined,
    modelId: input.settings.imageProvider === 'atlas' ? input.settings.imageProviders.atlas.model : undefined,
    size: input.size || dimensions?.size || (input.settings.imageProvider === 'atlas' && !input.aspectRatio ? input.settings.imageProviders.atlas.size : undefined),
    width: input.width || dimensions?.width,
    height: input.height || dimensions?.height,
    aspectRatio: input.aspectRatio,
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
    prompt = composeImagePrompt({ scene: asset.scene, kind: asset.kind, contacts: stableContacts, includeUser: !!asset.includeUser, settings, userIdentity: user?.visualIdentity, provider: asset.provider, stylePrompt: asset.stylePrompt, aspectRatio: asset.aspectRatio })
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
  if (asset.provider === 'novelai' && asset.width && asset.height) {
    imageProviders.novelai.width = asset.width
    imageProviders.novelai.height = asset.height
  }
  if (asset.provider === 'comfyui' && asset.width && asset.height) {
    imageProviders.comfyui.width = asset.width
    imageProviders.comfyui.height = asset.height
  }
  if (asset.provider === 'stable-diffusion' && asset.width && asset.height) {
    imageProviders.stableDiffusion.width = asset.width
    imageProviders.stableDiffusion.height = asset.height
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
