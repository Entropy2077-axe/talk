import { db } from '../db/db'
import type { AppSettings, Contact, Message } from '../types'
import { createContactGenerationTask } from './contactGenerationTasks'
import { displayName } from './contact'

export interface ContactRecommendationData {
  version: 1
  candidateName: string
  relationToRecommender: string
  recommendationReason: string
  shortDescription: string
  gender: string
  ageRange: string
  occupation: string
  hobbies: string[]
  personalityClues: string[]
  recommenderContactId?: string
  recommenderName?: string
  status: 'pending' | 'accepted' | 'declined'
  taskId?: string
  contactId?: string
  resolvedAt?: number
}

const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const cleanList = (value: unknown) => Array.isArray(value)
  ? value.map((item) => clean(item, 60)).filter(Boolean).slice(0, 6)
  : []

export function recommendationFromMessage(message: Message): ContactRecommendationData | null {
  if (message.type !== 'link' || message.link?.app !== 'contact_recommendation') return null
  const raw = message.link.data
  if (!raw || typeof raw !== 'object') return null
  const candidateName = clean(raw.candidateName, 40)
  const relationToRecommender = clean(raw.relationToRecommender, 40)
  const recommendationReason = clean(raw.recommendationReason, 240)
  const shortDescription = clean(raw.shortDescription, 300)
  if (!candidateName || !relationToRecommender || !recommendationReason || !shortDescription) return null
  return {
    version: 1,
    candidateName,
    relationToRecommender,
    recommendationReason,
    shortDescription,
    gender: clean(raw.gender, 30),
    ageRange: clean(raw.ageRange, 30),
    occupation: clean(raw.occupation, 60),
    hobbies: cleanList(raw.hobbies),
    personalityClues: cleanList(raw.personalityClues),
    recommenderContactId: clean(raw.recommenderContactId, 80) || undefined,
    recommenderName: clean(raw.recommenderName, 40) || undefined,
    status: raw.status === 'accepted' ? 'accepted' : raw.status === 'declined' ? 'declined' : 'pending',
    taskId: clean(raw.taskId, 80) || undefined,
    contactId: clean(raw.contactId, 80) || undefined,
    resolvedAt: typeof raw.resolvedAt === 'number' ? raw.resolvedAt : undefined,
  }
}

export async function declineContactRecommendation(message: Message): Promise<void> {
  const recommendation = recommendationFromMessage(message)
  if (!recommendation || recommendation.status !== 'pending') return
  const next = { ...recommendation, status: 'declined' as const, resolvedAt: Date.now() }
  await db.messages.update(message.id, { link: { ...message.link!, data: next } })
}

export async function acceptContactRecommendation(options: {
  message: Message
  recommender: Contact
  settings: AppSettings
  careerEnabled: boolean
  relationshipEnabled: boolean
  locationEnabled: boolean
}): Promise<string> {
  const { message, recommender, settings } = options
  const recommendation = recommendationFromMessage(message)
  if (!recommendation) throw new Error('这张推荐卡的信息不完整')
  if (recommendation.status === 'accepted' && recommendation.taskId) return recommendation.taskId
  if (recommendation.status !== 'pending') throw new Error('这张推荐已经处理过了')
  if (!settings.apiKey.trim()) throw new Error('还没有配置 API Key，请先去“我－设置”里填写')
  if (recommendation.recommenderContactId && recommendation.recommenderContactId !== recommender.id) throw new Error('推荐人与当前会话不一致')

  const normalizedName = recommendation.candidateName.toLocaleLowerCase()
  const duplicate = await db.contacts.filter((contact) => [contact.name, contact.realName, contact.nickname, displayName(contact)]
    .some((name) => name?.trim().toLocaleLowerCase() === normalizedName)).first()
  if (duplicate) throw new Error(`联系人“${displayName(duplicate)}”已经存在`)

  const recommenderName = displayName(recommender)
  const knownFacts = [
    `姓名或常用昵称：${recommendation.candidateName}`,
    recommendation.gender && recommendation.gender !== '不确定' ? `性别：${recommendation.gender}` : '',
    recommendation.ageRange && recommendation.ageRange !== '不确定' ? `年龄：${recommendation.ageRange}` : '',
    recommendation.occupation && recommendation.occupation !== '不确定' ? `职业或身份：${recommendation.occupation}` : '',
    recommendation.personalityClues.length ? `性格线索：${recommendation.personalityClues.join('、')}` : '',
    recommendation.hobbies.length ? `兴趣：${recommendation.hobbies.join('、')}` : '',
    `与${recommenderName}的关系：${recommendation.relationToRecommender}`,
    `可公开介绍：${recommendation.shortDescription}`,
  ].filter(Boolean)
  const introductionHistory = `${new Date().toLocaleDateString()}，${recommenderName}因为“${recommendation.recommendationReason}”向用户介绍了${recommendation.candidateName}。在这次介绍之前，用户与${recommendation.candidateName}并不认识；不得虚构双方已有共同经历。`

  const taskId = await createContactGenerationTask({
    method: 'precision',
    experienceMode: settings.experienceMode,
    input: {
      personalityTags: recommendation.personalityClues,
      ageRange: recommendation.ageRange === '不确定' ? '' : recommendation.ageRange,
      gender: recommendation.gender === '不确定' ? '' : recommendation.gender,
      relationship: '由熟人介绍的新认识',
      occupation: recommendation.occupation === '不确定' ? '' : recommendation.occupation,
      hobbies: recommendation.hobbies,
      personalityTrait: '无',
      roleDescription: `由联系人${recommenderName}推荐认识。${recommendation.shortDescription}`,
      personaSetting: `以下是推荐人${recommenderName}明确知道的事实，必须保留；未知部分可以合理补全，但不能把推荐人的主观印象扩写成虚假正史：\n${knownFacts.join('\n')}`,
      sharedHistory: introductionHistory,
      realName: recommendation.candidateName,
      nickname: recommendation.candidateName,
      avatar: '👤',
      avatarManuallySet: false,
      initialWarmthMode: 'ai',
      relations: [{ targetContactId: recommender.id, label: recommendation.relationToRecommender }],
      worldviewId: recommender.worldviewId || settings.activeWorldId || settings.defaultWorldviewId,
      selectedWorldbookEntryIds: [],
      careerEnabled: options.careerEnabled,
      relationshipEnabled: options.relationshipEnabled,
      locationEnabled: options.locationEnabled,
      recommendation: {
        sourceMessageId: message.id,
        recommenderContactId: recommender.id,
        recommenderName,
        acceptedAt: Date.now(),
      },
    },
  })

  const next = { ...recommendation, recommenderContactId: recommender.id, recommenderName, status: 'accepted' as const, taskId, resolvedAt: Date.now() }
  await db.messages.update(message.id, { link: { ...message.link!, data: next } })
  return taskId
}
