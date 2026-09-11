import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'
import type { AppSettings, Contact } from '../types'
import { buildConversationIllustrationDirectorPrompt, composeImagePrompt, createConversationIllustration, createMediaAsset, detectExplicitImageRequest } from './imageAssets'

vi.mock('./deepseek', () => ({
  chatCompletionText: vi.fn(async () => JSON.stringify({
    prompt: 'A candid close-up portrait of Ari resting beside a softly lit window at home, gentle tired eyes, relaxed shoulders, warm evening light, quiet intimate atmosphere, realistic photography.',
    caption: '她靠在窗边歇了一会儿，疲惫里透着被理解后的放松。',
    kind: 'portrait',
    includeUser: false,
    aspectRatio: '3:4',
  })),
  traceTurnEvent: vi.fn(async () => undefined),
}))

vi.mock('./remoteMedia', () => ({
  generateRemoteImage: vi.fn(async () => ({ url: 'data:image/png;base64,aW1hZ2U=', provider: 'atlas' })),
}))

function contact(id: string, name: string, identity: string): Contact {
  return {
    id, name, avatar: '🙂', avatarColor: '#ddd', systemPrompt: `${name} persona`,
    visualIdentity: identity, visualSeed: id.charCodeAt(0), createdAt: 1,
    memoryFacts: '', memoryStyle: '', memoryUpdatedAt: 1, memoryMessageCursor: 0,
    relationshipBase: 'friend', relationshipDynamic: '',
  }
}

function settings(style: AppSettings['imageProviders']['atlas']['visualStyle'] = 'asian-realistic'): AppSettings {
  const current = useSettingsStore.getState()
  return {
    ...current,
    imageProvider: 'atlas',
    userNickname: 'Mina',
    imageProviders: {
      ...current.imageProviders,
      atlas: { ...current.imageProviders.atlas, visualStyle: style, customVisualStyle: 'muted watercolor editorial art' },
    },
  }
}

beforeEach(async () => {
  await db.open()
  await db.mediaAssets.clear()
  await db.messages.clear()
  await db.contacts.clear()
})

describe('persistent image assets and prompt orchestration', () => {
  it('builds a visual-director request that forbids literal chat interfaces', () => {
    const prompt = buildConversationIllustrationDirectorPrompt({
      participantNames: ['Ari'],
      latestUserText: '今天有点累。',
      replyText: '那就先歇一会儿，我陪你。',
      mood: '温柔关心',
      context: 'Late evening at home',
    })
    expect(prompt).toContain('Ari')
    expect(prompt).toContain('今天有点累')
    expect(prompt).toContain('那就先歇一会儿')
    expect(prompt).toContain('Late evening at home')
    expect(prompt).toContain('严禁复制素材里的任何句子或词语')
    expect(prompt).toContain('手机屏幕、聊天框、UI、文字')
  })

  it.each([
    ['拍张自拍给我看看', 'selfie'],
    ['给我发一张近照吧', 'portrait'],
    ['今天看起来心情不错', null],
  ] as const)('detects explicit image request %s', (text, expected) => {
    expect(detectExplicitImageRequest(text)).toBe(expected)
  })

  it('composes Atlas style before stable identities with an exact people constraint', () => {
    const prompt = composeImagePrompt({
      scene: 'friends taking a photo beside a lake', kind: 'group',
      contacts: [contact('a', 'Ari', 'oval face, short black hair'), contact('b', 'Bea', 'round face, long brown hair')],
      includeUser: true, userIdentity: 'angular face, shoulder-length dark hair', settings: settings(), provider: 'atlas',
    })

    expect(prompt).toContain('authentic contemporary Asian people')
    expect(prompt).toContain('Person A (Ari): oval face, short black hair')
    expect(prompt).toContain('Person B (Bea): round face, long brown hair')
    expect(prompt).toContain('Person C (Mina): angular face, shoulder-length dark hair')
    expect(prompt).toContain('Show exactly 3 distinct people')
    expect(prompt).toContain('do not blend faces')
  })

  it('supports custom Atlas style but does not apply it to other providers', () => {
    const atlasPrompt = composeImagePrompt({ scene: 'portrait', kind: 'portrait', contacts: [], includeUser: false, settings: settings('custom'), provider: 'atlas' })
    const otherPrompt = composeImagePrompt({ scene: 'portrait', kind: 'portrait', contacts: [], includeUser: false, settings: settings('custom'), provider: 'novelai' })
    expect(atlasPrompt).toContain('muted watercolor editorial art')
    expect(otherPrompt).not.toContain('muted watercolor editorial art')
  })

  it.each([
    ['european-realistic', 'authentic contemporary European people'],
    ['anime', 'high-quality modern 2D anime illustration'],
  ] as const)('applies the %s Atlas preset', (style, expected) => {
    expect(composeImagePrompt({ scene: 'portrait', kind: 'portrait', contacts: [], includeUser: false, settings: settings(style), provider: 'atlas' })).toContain(expected)
  })

  it('persists a queued placeholder task without storing provider API keys', async () => {
    const configured = settings()
    configured.apiKey = 'chat-test-key'
    configured.imageProviders.atlas.apiKey = 'secret-key-that-must-not-be-stored'
    const asset = await createMediaAsset({ origin: 'chat', originId: 'message-1', conversationId: 'conversation-1', ownerContactIds: ['a'], scene: 'a quiet cafe', settings: configured })
    const stored = await db.mediaAssets.get(asset.id)
    expect(stored?.status).toBe('queued')
    expect(JSON.stringify(stored)).not.toContain('secret-key-that-must-not-be-stored')
  })

  it('creates exactly one durable illustration message per AI turn', async () => {
    const configured = settings()
    configured.apiKey = 'chat-test-key'
    configured.imageProviders.atlas.apiKey = 'test-key'
    useSettingsStore.setState(configured)
    await db.contacts.add(contact('a', 'Ari', 'oval face, short black hair'))
    const input = {
      conversationId: 'conversation-1', turnId: 'turn-1', ownerContactIds: ['a'], participantNames: ['Ari'],
      latestUserText: '晚安', replyText: '做个好梦。', mood: '温柔', settings: configured, createdAt: 10,
    }
    const first = await createConversationIllustration(input)
    const second = await createConversationIllustration({ ...input, createdAt: 11 })

    expect(second?.id).toBe(first?.id)
    expect(await db.messages.where('conversationId').equals(input.conversationId).count()).toBe(1)
    expect(await db.mediaAssets.filter((asset) => asset.turnId === input.turnId).count()).toBe(1)
    expect(first?.image?.presentation).toBe('illustration')
    expect(first?.image?.caption).toContain('靠在窗边')
    expect(first?.image?.query).not.toContain('晚安')
    expect((await db.mediaAssets.get(first!.image!.assetId!))?.origin).toBe('chat-illustration')
    expect((await db.mediaAssets.get(first!.image!.assetId!))?.aspectRatio).toBe('3:4')
    expect((await db.mediaAssets.get(first!.image!.assetId!))?.size).toBe('1536*2048')
    await vi.waitFor(async () => expect((await db.mediaAssets.get(first!.image!.assetId!))?.status).toBe('completed'))
  })

  it('turns a missed explicit selfie action into a normal sent-image message', async () => {
    const configured = settings()
    configured.apiKey = 'chat-test-key'
    configured.imageProviders.atlas.apiKey = 'test-key'
    useSettingsStore.setState(configured)
    await db.contacts.add(contact('a', 'Ari', 'oval face, short black hair'))

    const message = await createConversationIllustration({
      conversationId: 'conversation-2', turnId: 'turn-2', ownerContactIds: ['a'], participantNames: ['Ari'],
      latestUserText: '拍张自拍给我看', replyText: '好呀。', settings: configured, createdAt: 20,
      presentation: 'sent', requestedKind: 'selfie', speakerContactId: 'a',
    })

    const asset = await db.mediaAssets.get(message!.image!.assetId!)
    expect(message?.content).toBe('[图片]')
    expect(message?.image?.presentation).toBe('sent')
    expect(message?.speakerContactId).toBe('a')
    expect(asset?.origin).toBe('chat')
    expect(asset?.kind).toBe('selfie')
    expect(asset?.scene).toContain('Selfie-style first-person camera viewpoint')
    expect(asset?.aspectRatio).toBe('3:4')
    expect(message?.image?.query).not.toContain('拍张自拍')
  })
})
