import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { AvatarPicker } from '../components/AvatarPicker'
import { useSettingsStore } from '../store/useSettingsStore'
import { useModuleEnabled } from '../features'
import { chatCompletion } from '../lib/deepseek'
import { randomAvatarColor } from '../lib/colors'
import { AVATAR_EMOJIS } from '../lib/avatarEmojis'
import { pickRandomTrait } from '../lib/randomTraits'
import { initialWarmthForBase } from '../lib/relationship'
import { setPairedContactRelation } from '../lib/contactRelations'
import { rememberInitialContactRelation } from '../lib/memory'
import { displayName } from '../lib/contact'
import { pickAvatarCategory } from '../lib/avatarCategory'
import { OCCUPATION_OPTIONS, employmentPatch } from '../lib/career'
import { randomAnimeAvatar, searchPexelsPhoto } from '../lib/photoSearch'
import { retrieveWorldbookContext } from '../lib/worldbook'
import { getPromptTemplate, promptModuleEnabled } from '../lib/promptModules'
import { customTraitsValidationError, hasOverlappingCustomTraitRules } from '../lib/contactCreator'
import { CONTACT_RELATION_LABELS, HOBBY_TAG_OPTIONS, PERSONALITY_TRAIT_OPTIONS, type ContactRelationLabel, type CustomPersonalityTrait, type PersonaCreationRecord } from '../types'
import {
  AGE_RANGE_OPTIONS,
  GENDER_OPTIONS,
  PERSONALITY_TAG_OPTIONS,
  RELATIONSHIP_OPTIONS,
  buildPersonaGenerationPrompt,
  parsePersonaGeneration,
  type PersonaGenerationResult,
} from '../lib/prompt'

/** Contact creation has a few real async phases (persona LLM call, then optional photo fetch, then db writes) — reflect actual state transitions rather than a fake time-based animation. */
const PROGRESS_LABELS: Record<'persona' | 'avatar' | 'saving', string> = {
  persona: '正在为TA设计人设…',
  avatar: '正在匹配头像…',
  saving: '创建中…',
}
const PROGRESS_PERCENT: Record<'persona' | 'avatar' | 'saving', number> = {
  persona: 30,
  avatar: 70,
  saving: 95,
}

interface RelationRow {
  key: string
  targetContactId: string
  label: ContactRelationLabel
}

interface NuwaStructuredResult {
  realName: string
  nickname: string
  birthday: string
  tendencies: string
  age: string
  gender: string
  relationship: string
  occupation: string
  hobbies: string
  personalityTrait: string
  personalityTraitContent: string
  otherSetting: string
}

const NUWA_FORM_KEYS = ['realName', 'nickname', 'birthday', 'tendencies', 'age', 'gender', 'relationship', 'occupation', 'hobbies', 'personalityTrait', 'personalityTraitContent', 'otherSetting'] as const
const NUWA_FORM_JSON_SCHEMA = '{"realName":"","nickname":"","birthday":"","tendencies":"","age":"","gender":"","relationship":"","occupation":"","hobbies":"","personalityTrait":"","personalityTraitContent":"","otherSetting":""}'
const NUWA_FIELD_LABELS: Record<(typeof NUWA_FORM_KEYS)[number], string> = {
  realName: '真名', nickname: '网名/昵称', birthday: '出生日期', tendencies: '性格倾向', age: '年龄', gender: '性别', relationship: '关系定位', occupation: '职业', hobbies: '兴趣爱好', personalityTrait: '性格特质名称', personalityTraitContent: '性格特质内容', otherSetting: '其他角色设定',
}

function nuwaFormOutputProtocol() {
  return `【固定输出协议】这是不可编辑的界面数据协议，优先级高于前文的输出形式要求。
必须只返回一个合法 JSON 对象，禁止输出普通段落、Markdown、代码块、标题或解释。
JSON 的键必须完整且只能使用以下结构：
${NUWA_FORM_JSON_SCHEMA}
必须把原本为空的每一个字段都补成具体、非空的内容，不允许继续返回空字符串；已填写字段必须逐字保留。personalityTrait 是特质名称，personalityTraitContent 是该特质的具体行为与性格表现；otherSetting 返回完整正文。
hobbies 使用顿号分隔。即使初稿建议很简短，也要根据已有信息合理补齐全部字段，并保证彼此一致。`
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  const jsonText = cleaned.match(/\{[\s\S]*\}/)?.[0]
  if (!jsonText) return null
  try {
    const value = JSON.parse(jsonText)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function parseNuwaStructuredResult(raw: string): NuwaStructuredResult | null {
  const value = parseJsonRecord(raw)
  if (!value) return null
  try {
    const text = (...keys: string[]) => {
      const item = keys.map((key) => value[key]).find((candidate) => candidate !== undefined && candidate !== null)
      if (Array.isArray(item)) return item.map((entry) => String(entry).trim()).filter(Boolean).join('、')
      return typeof item === 'string' ? item.trim() : item == null ? '' : String(item).trim()
    }
    return {
      realName: text('realName', '真名'),
      nickname: text('nickname', '网名', '昵称'),
      birthday: text('birthday', '出生日期'),
      tendencies: text('tendencies', '性格倾向'),
      age: text('age', '年龄'),
      gender: text('gender', '性别'),
      relationship: text('relationship', '关系定位'),
      occupation: text('occupation', '职业'),
      hobbies: text('hobbies', '兴趣爱好'),
      personalityTrait: text('personalityTrait', '性格特质'),
      personalityTraitContent: text('personalityTraitContent', '性格特质内容', '特质内容'),
      otherSetting: text('otherSetting', 'personaSetting', '其他角色设定', '其他设定'),
    }
  } catch {
    return null
  }
}

function localNuwaFormatIssues(raw: string) {
  const value = parseJsonRecord(raw)
  if (!value) return ['输出不是合法的 JSON 对象']
  const missing = NUWA_FORM_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  const wrongTypes = NUWA_FORM_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(value, key) && typeof value[key] !== 'string')
  const extra = Object.keys(value).filter((key) => !NUWA_FORM_KEYS.includes(key as typeof NUWA_FORM_KEYS[number]))
  return [
    missing.length ? `缺少字段：${missing.join('、')}` : '',
    wrongTypes.length ? `字段必须是字符串：${wrongTypes.join('、')}` : '',
    extra.length ? `包含未允许字段：${extra.join('、')}` : '',
  ].filter(Boolean)
}

function parseNuwaReview(raw: string) {
  const value = parseJsonRecord(raw)
  if (!value) return null
  const issues = Array.isArray(value.issues) ? value.issues.map((item) => String(item).trim()).filter(Boolean) : []
  return { valid: value.valid === true, issues }
}

function hasNuwaFormFields(result: NuwaStructuredResult) {
  return [result.realName, result.nickname, result.birthday, result.tendencies, result.age, result.gender, result.relationship, result.occupation, result.hobbies, result.personalityTrait, result.personalityTraitContent].some(Boolean)
}

export function ContactAddPage() {
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const existingContacts = useLiveQuery(() => db.contacts.toArray(), []) ?? []
  const savedPersonas = useLiveQuery(() => db.savedPersonas.orderBy('updatedAt').reverse().toArray(), []) ?? []
  const creationRecords = useLiveQuery(() => db.personaCreationRecords.orderBy('createdAt').reverse().toArray(), []) ?? []

  const [tags, setTags] = useState<string[]>([])
  const [customTag, setCustomTag] = useState('')
  const [ageRange, setAgeRange] = useState('')
  const [gender, setGender] = useState('')
  const personalityEnabled = useModuleEnabled('personalityTraits')
  const relEnabled = useModuleEnabled('relationship')
  const [isNuwaMode, setIsNuwaMode] = useState(false)
  const draftMode = isNuwaMode
  const [relationship, setRelationship] = useState('')
  const [personalityTrait, setPersonalityTrait] = useState('')
  const [personalityTraitContent, setPersonalityTraitContent] = useState('')
  const [traitPickerOpen, setTraitPickerOpen] = useState(false)
  const [hobbies, setHobbies] = useState<string[]>([])
  const [extra, setExtra] = useState('')
  const [sharedHistory, setSharedHistory] = useState('')
  const careerEnabled = useModuleEnabled('career')
  const [occupation, setOccupation] = useState('')
  const [customOccupation, setCustomOccupation] = useState('')
  const [avatar, setAvatar] = useState(AVATAR_EMOJIS[Math.floor(Math.random() * AVATAR_EMOJIS.length)])
  const [avatarManuallySet, setAvatarManuallySet] = useState(false)
  const [pickingAvatar, setPickingAvatar] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [progressStep, setProgressStep] = useState<'persona' | 'avatar' | 'saving' | null>(null)
  const [error, setError] = useState('')
  const [relationRows, setRelationRows] = useState<RelationRow[]>([])
  const [customTraits, setCustomTraits] = useState<CustomPersonalityTrait[]>([])
  const [customTendencies, setCustomTendencies] = useState('')
  const [customAge, setCustomAge] = useState('')
  const [customGender, setCustomGender] = useState('')
  const [customRelationship, setCustomRelationship] = useState('')
  const [customHobbies, setCustomHobbies] = useState('')
  const [customRealName, setCustomRealName] = useState('')
  const [customNickname, setCustomNickname] = useState('')
  const [customBirthday, setCustomBirthday] = useState('')
  const [personaPickerOpen, setPersonaPickerOpen] = useState(false)
  const [creationPickerOpen, setCreationPickerOpen] = useState(false)
  const [personaPage, setPersonaPage] = useState(0)
  const [personaDraft, setPersonaDraft] = useState<PersonaGenerationResult | null>(null)
  const [nuwaPersonaSetting, setNuwaPersonaSetting] = useState('')
  const [polishingPersona, setPolishingPersona] = useState(false)

  const previouslyUsedTraits = (() => {
    const byName = new Map<string, CustomPersonalityTrait>()
    for (const trait of [...existingContacts.flatMap((contact) => contact.customPersonalityTraits ?? []), ...savedPersonas.flatMap((saved) => saved.customPersonalityTraits ?? [])]) {
      const name = trait.name.trim()
      const meaning = trait.meaning.trim()
      if (name && meaning && !byName.has(name)) byName.set(name, trait)
    }
    return [...byName.values()]
  })()

  function effectiveNuwaTraits(): CustomPersonalityTrait[] {
    const name = personalityTrait.trim()
    const meaning = personalityTraitContent.trim()
    if (!name && !meaning) return []
    return [{
      id: customTraits.find((trait) => trait.name.trim() === name)?.id || uuid(),
      name,
      meaning,
      rules: customTraits.find((trait) => trait.name.trim() === name)?.rules ?? [],
    }]
  }

  function choosePersonalityTrait(name: string, meaning: string) {
    setPersonalityTrait(name)
    setPersonalityTraitContent(meaning)
    setTraitPickerOpen(false)
  }

  function currentInterpersonalSetting() {
    return relationRows.map((row) => {
      const target = existingContacts.find((contact) => contact.id === row.targetContactId)
      return target ? `与已有角色“${displayName(target)}”的关系：${row.label.trim()}` : ''
    }).filter(Boolean).join('\n')
  }

  async function creationWorldbookContext(query: string) {
    if (!promptModuleEnabled(settings, 'worldview')) return ''
    return retrieveWorldbookContext(query, { maxEntries: 8, maxChars: 6500, includeHighPriorityFallback: true })
  }

  function fallbackBirthday(ageText: string) {
    const ages = [...ageText.matchAll(/\d+/g)].map((m) => Number(m[0])).filter(Number.isFinite)
    const age = ages.length ? Math.round(ages.reduce((sum, value) => sum + value, 0) / ages.length) : 25
    const now = new Date()
    return `${now.getFullYear() - age}-06-15`
  }

  function personaSnapshot() {
    return {
      personalityTendencies: isNuwaMode ? customTendencies.split(/[、,，]+/).map((item) => item.trim()).filter(Boolean) : tags,
      age: isNuwaMode ? customAge : ageRange,
      gender: isNuwaMode ? customGender : gender,
      relationship: isNuwaMode ? customRelationship : relationship,
      occupation: isNuwaMode ? customOccupation : occupation,
      hobbies: isNuwaMode ? customHobbies.split(/[、,，]+/).map((item) => item.trim()).filter(Boolean) : hobbies,
      notes: (isNuwaMode ? currentNuwaPersonaText() : extra).trim(),
      sharedHistory: (draftMode ? extra : sharedHistory).trim(),
    }
  }

  function structuredNuwaPersonaText() {
    if (!isNuwaMode) return ''
    return [
      customRealName.trim() ? `真名：${customRealName.trim()}` : '',
      customNickname.trim() ? `网名/昵称：${customNickname.trim()}` : '',
      customBirthday.trim() ? `出生日期：${customBirthday.trim()}` : '',
      customTendencies.trim() ? `性格倾向：${customTendencies.trim()}` : '',
      customAge.trim() ? `年龄：${customAge.trim()}` : '',
      customGender.trim() ? `性别：${customGender.trim()}` : '',
      customRelationship.trim() ? `关系定位：${customRelationship.trim()}` : '',
      customOccupation.trim() ? `职业：${customOccupation.trim()}` : '',
      customHobbies.trim() ? `兴趣爱好：${customHobbies.trim()}` : '',
      personalityTrait.trim() ? `性格特质名称：${personalityTrait.trim()}` : '',
      personalityTraitContent.trim() ? `性格特质内容：${personalityTraitContent.trim()}` : '',
    ].filter(Boolean).join('\n')
  }

  function currentNuwaPersonaText() {
    return [structuredNuwaPersonaText(), nuwaPersonaSetting.trim()].filter(Boolean).join('\n\n')
  }

  function currentNuwaFormValues(): NuwaStructuredResult {
    return {
      realName: customRealName.trim(),
      nickname: customNickname.trim(),
      birthday: customBirthday.trim(),
      tendencies: customTendencies.trim(),
      age: customAge.trim(),
      gender: customGender.trim(),
      relationship: customRelationship.trim(),
      occupation: customOccupation.trim(),
      hobbies: customHobbies.trim(),
      personalityTrait: personalityTrait.trim(),
      personalityTraitContent: personalityTraitContent.trim(),
      otherSetting: nuwaPersonaSetting.trim(),
    }
  }

  async function reviewNuwaFormResponse(raw: string) {
    const localIssues = localNuwaFormatIssues(raw)
    const parsed = parseNuwaStructuredResult(raw)
    const currentValues = currentNuwaFormValues()
    if (parsed) {
      const stillEmpty = NUWA_FORM_KEYS.filter((key) => !parsed[key].trim())
      if (stillEmpty.length) localIssues.push(`以下字段仍未补全：${stillEmpty.map((key) => NUWA_FIELD_LABELS[key]).join('、')}`)
      const overwritten = NUWA_FORM_KEYS.filter((key) => currentValues[key] && parsed[key] !== currentValues[key])
      if (overwritten.length) localIssues.push(`以下已填字段被改写：${overwritten.map((key) => NUWA_FIELD_LABELS[key]).join('、')}`)
    }
    if (parsed && !hasNuwaFormFields(parsed) && !structuredNuwaPersonaText()) localIssues.push('角色说明包含可提取信息，但所有表单字段均为空，只填写了 otherSetting')
    const reviewRaw = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.utilityModel || settings.model,
      messages: [
        { role: 'system', content: `你是多功能模型中的严格格式审查器。只审查候选输出，不负责改写内容。
必须只返回合法 JSON：{"valid":true,"issues":[]}。
判定为不合格的情况包括：不是纯 JSON 对象；缺少固定字段；字段不是字符串；出现额外字段；任意表单字段仍为空；初稿建议中可明确提取的信息没有进入对应表单字段、却只堆在 otherSetting；补全结果改写了用户已经填写的身份、关系、事实、边界或其他字段。
issues 要用简短中文列出具体错误。` },
        { role: 'user', content: `模式：只补全空字段
固定结构：${NUWA_FORM_JSON_SCHEMA}
初稿建议：${extra.trim() || '（未填写）'}
当前表单：${currentNuwaPersonaText() || '（未填写）'}
候选输出：${raw}` },
      ],
      jsonMode: true,
      thinking: 'disabled',
      purpose: 'persona',
      temperature: 0,
      maxTokens: 500,
    })
    const review = parseNuwaReview(reviewRaw)
    const issues = Array.from(new Set([...localIssues, ...(review?.issues ?? [])]))
    if (!review) issues.push('多功能模型没有返回有效的审查结果')
    if (review && !review.valid && issues.length === 0) issues.push('多功能模型判定格式不合格')
    return { valid: !!parsed && localIssues.length === 0 && review?.valid === true, issues, result: parsed }
  }

  async function generateReviewedNuwaPolish(prompt: string, temperature: number, maxTokens: number) {
    let rejection = ''
    let lastIssues: string[] = []
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const retryText = rejection
        ? `\n\n上一次输出已被多功能模型退回。必须修复以下问题：\n${rejection}\n请重新输出完整 JSON，不要解释。`
        : ''
      const raw = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        messages: [
          { role: 'system', content: `${prompt}\n\n${nuwaFormOutputProtocol()}${retryText}` },
          { role: 'user', content: '请只补全空字段，并返回包含全部字段的完整表单 JSON。' },
        ],
        jsonMode: true,
        thinking: 'disabled',
        purpose: 'persona',
        temperature,
        maxTokens,
      })
      const review = await reviewNuwaFormResponse(raw)
      if (review.valid && review.result) return review.result
      lastIssues = review.issues
      rejection = review.issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n') || '格式不符合固定表单协议'
    }
    throw new Error(`多功能模型连续退回 3 次：${lastIssues.join('；') || '格式不合格'}`)
  }

  async function saveCurrentPersona() {
    const now = Date.now()
    const profile = personaSnapshot()
    await db.savedPersonas.add({ id: uuid(), name: customNickname.trim() || customRealName.trim(), nickname: customNickname.trim() || undefined, realName: customRealName.trim() || undefined, birthday: customBirthday.trim() || undefined, profile, sharedHistory: profile.sharedHistory || undefined, personaConstraints: (isNuwaMode ? `${extra.trim()}\n${currentNuwaPersonaText()}` : extra.trim()) || undefined, customPersonalityTraits: isNuwaMode ? effectiveNuwaTraits() : customTraits, createdAt: now, updatedAt: now })
    setPersonaPage(0)
  }

  function applySavedPersona(saved: import('../types').SavedPersona) {
    const profile = saved.profile
    setNuwaPersonaSetting(saved.personaConstraints || profile.notes || '')
    const firstTrait = saved.customPersonalityTraits?.[0]
    setCustomTendencies(profile.personalityTendencies.join('、')); setCustomAge(profile.age); setCustomGender(profile.gender); setCustomRelationship(profile.relationship); setCustomOccupation(profile.occupation); setCustomHobbies(profile.hobbies.join('、')); setExtra(saved.personaConstraints || profile.notes || ''); setSharedHistory(saved.sharedHistory || profile.sharedHistory || ''); setCustomTraits(saved.customPersonalityTraits || []); setPersonalityTrait(firstTrait?.name || ''); setPersonalityTraitContent(firstTrait?.meaning || ''); setCustomRealName(saved.realName || ''); setCustomNickname(saved.nickname || ''); setCustomBirthday(saved.birthday || ''); setPersonaPickerOpen(false)
  }

  function applyCreationRecord(record: PersonaCreationRecord) {
    setIsNuwaMode(true)
    setExtra(record.roleDescription || '')
    setNuwaPersonaSetting(record.personaSetting || record.persona)
    setCustomRealName(record.realName || '')
    setCustomNickname(record.nickname || '')
    setCustomBirthday(record.birthday || '')
    setCustomAge(record.ageRange || '')
    setCustomGender(record.gender || '')
    setCustomRelationship(record.relationship || '')
    setCustomOccupation(record.occupation || '')
    setPersonalityTrait(record.personalityTrait || '')
    setPersonalityTraitContent('')
    setCustomHobbies((record.hobbies || []).join(', '))
    setSharedHistory(record.sharedHistory || '')
    setPersonaDraft({
      name: record.name,
      realName: record.realName,
      nickname: record.nickname,
      birthday: record.birthday,
      persona: record.persona,
      schedule: record.schedule || [],
      avatarKeyword: record.avatarKeyword || '',
      personalityTrait: record.personalityTrait || '',
      speechSamples: record.speechSamples || [],
      mbti: record.mbti || '',
      personaProfile: record.personaProfile,
      monthlySalary: record.monthlySalary,
      relationship: record.relationship,
      gender: record.gender,
      ageRange: record.ageRange,
      occupation: record.occupation,
    })
    setPersonaPickerOpen(false)
    setCreationPickerOpen(false)
    setError('已调用历史人设，你可以继续修改后创建')
  }

  async function polishNuwaPersona() {
    if (!settings.apiKey) { setError('还没有配置 API Key，请先去“我-设置”里填写'); return }
    const existing = currentNuwaPersonaText()
    const direction = extra.trim()
    if (!existing && !direction) { setError('请先填写初稿建议或至少一项角色设定，再让 AI 补全'); return }
    setPolishingPersona(true)
    setError('')
    try {
      const editablePrompt = getPromptTemplate(settings, 'nuwaMode', 'polish', { existingPersona: existing || '（暂未填写）', roleDescription: direction || '（暂未填写）' })
      if (!editablePrompt) throw new Error('女娲创建提示词模块已屏蔽')
      const worldbookText = await creationWorldbookContext([direction, existing, currentInterpersonalSetting()].filter(Boolean).join('\n'))
      const prompt = [editablePrompt, worldbookText ? `【创建角色时必须遵守的世界书】\n${worldbookText}\n世界书是正史硬约束。补全的身份、经历、职业、关系、能力边界和生活方式都必须与其一致，不得只在其他设定里提到一嘴。` : ''].filter(Boolean).join('\n\n')
      const result = await generateReviewedNuwaPolish(prompt, 0.65, 1800)
      if (result && Object.values(result).some(Boolean)) {
        const fillEmpty = (current: string, completion: string) => current.trim() ? current : completion
        setCustomRealName((current) => fillEmpty(current, result.realName))
        setCustomNickname((current) => fillEmpty(current, result.nickname))
        setCustomBirthday((current) => fillEmpty(current, result.birthday))
        setCustomTendencies((current) => fillEmpty(current, result.tendencies))
        setCustomAge((current) => fillEmpty(current, result.age))
        setCustomGender((current) => fillEmpty(current, result.gender))
        setCustomRelationship((current) => fillEmpty(current, result.relationship))
        setCustomOccupation((current) => fillEmpty(current, result.occupation))
        setCustomHobbies((current) => fillEmpty(current, result.hobbies))
        setPersonalityTrait((current) => fillEmpty(current, result.personalityTrait))
        setPersonalityTraitContent((current) => fillEmpty(current, result.personalityTraitContent))
        setNuwaPersonaSetting((current) => fillEmpty(current, result.otherSetting))
      } else throw new Error('AI 返回内容无法转换成表单，请重试一次')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPolishingPersona(false)
    }
  }

  function addRelationRow() {
    const taken = new Set(relationRows.map((r) => r.targetContactId))
    const firstAvailable = existingContacts.find((c) => !taken.has(c.id))
    if (!firstAvailable) return
    setRelationRows((prev) => [
      ...prev,
      { key: uuid(), targetContactId: firstAvailable.id, label: CONTACT_RELATION_LABELS[0] },
    ])
  }

  function updateRelationRow(key: string, patch: Partial<RelationRow>) {
    setRelationRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  function removeRelationRow(key: string) {
    setRelationRows((prev) => prev.filter((r) => r.key !== key))
  }

  function toggleTag(tag: string) {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
  }

  function addCustomTag() {
    const trimmed = customTag.trim()
    if (!trimmed || tags.includes(trimmed)) return
    setTags((prev) => [...prev, trimmed])
    setCustomTag('')
  }

  function addRandomTrait() {
    setTags((prev) => [...prev, pickRandomTrait(prev)])
  }

  async function handleGenerate(
    overrides?: { tags: string[]; ageRange: string; gender: string; relationship: string; personalityTrait: string; hobbies: string[]; occupation: string; relationRows: RelationRow[] },
    draftOverride?: PersonaGenerationResult,
  ) {
    if (!settings.apiKey) {
      setError('还没有配置API Key 请先去"我-设置"里填写')
      return
    }
    if (isNuwaMode) {
      const traitError = customTraitsValidationError(effectiveNuwaTraits())
      if (traitError) { setError(traitError); return }
      if (relationRows.some((row) => !row.targetContactId || !row.label.trim())) { setError('联系人关系不能留空'); return }
      if (new Set(relationRows.map((row) => row.targetContactId)).size !== relationRows.length) { setError('同一个联系人只能设置一条关系'); return }
    }
    setGenerating(true)
    const generationStartedAt = performance.now()
    setError('')
    setProgressStep('persona')
    try {
      if (!promptModuleEnabled(settings, 'nuwaMode')) throw new Error('女娲创建提示词模块已屏蔽')
      let values = overrides ?? {
        tags: isNuwaMode ? customTendencies.split(/[、,，]+/).map((x) => x.trim()).filter(Boolean) : tags,
        ageRange: isNuwaMode ? customAge : ageRange,
        gender: isNuwaMode ? customGender : gender,
        relationship: isNuwaMode ? customRelationship : relationship,
        personalityTrait,
        hobbies: isNuwaMode ? customHobbies.split(/[、,，]+/).map((x) => x.trim()).filter(Boolean) : hobbies,
        occupation: isNuwaMode ? customOccupation.trim() : (occupation === '自定义' ? customOccupation.trim() : occupation),
        relationRows,
      }
      const effectiveSharedHistory = (draftMode ? extra : sharedHistory).trim()
      const personaSettingText = (isNuwaMode ? currentNuwaPersonaText() : '').trim()
      const avatarCategory = pickAvatarCategory(values.tags)
      let parsed = draftOverride
      const roleDescription = extra
      if (!parsed) {
        const interpersonalSetting = currentInterpersonalSetting()
        const extra = [roleDescription, personaSettingText, interpersonalSetting].filter(Boolean).join('\n\n')
        const worldbookText = await creationWorldbookContext([values.tags.join(' '), values.ageRange, values.gender, values.relationship, values.personalityTrait, values.hobbies.join(' '), values.occupation, extra, personaSettingText].join('\n'))
        const raw = await chatCompletion({
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.model,
          messages: [
            {
              role: 'system',
              content: buildPersonaGenerationPrompt(
                {
                  personalityTags: values.tags,
                  ageRange: values.ageRange,
                  gender: values.gender,
                  relationship: values.relationship,
                  personalityTrait: values.personalityTrait,
                  hobbies: values.hobbies,
                  sharedHistory: effectiveSharedHistory,
                  draftMode: isNuwaMode,
                  extra: [extra, worldbookText ? `【创建角色时必须遵守的世界书】\n${worldbookText}` : ''].filter(Boolean).join('\n\n'),
                  occupation: values.occupation,
                },
                avatarCategory,
                settings.promptModules,
              ),
            },
            { role: 'user', content: '请生成' },
          ],
          jsonMode: true,
          thinking: 'disabled',
          temperature: 0.7,
          maxTokens: 2200,
          purpose: 'persona',
        })
        console.info(`[persona-perf] 主模型完成=${Math.round(performance.now() - generationStartedAt)}ms`)
        parsed = parsePersonaGeneration(raw) ?? undefined
      }
      if (!parsed) throw new Error('生成结果解析失败 请重试一次')
      if (personaSettingText && !parsed.persona.includes(personaSettingText)) {
        parsed = { ...parsed, persona: `${personaSettingText}\n\n${parsed.persona}` }
      }
      if (isNuwaMode) {
        if (!draftOverride) {
          setPersonaDraft(parsed)
          setError('初稿已生成，请检查并修改后再确认创建')
          return
        }
        values = {
          ...values,
          ageRange: parsed.ageRange || values.ageRange,
          gender: parsed.gender || values.gender,
          relationship: parsed.relationship || values.relationship,
          occupation: parsed.occupation || values.occupation,
          personalityTrait: values.personalityTrait || (parsed.personalityTrait === '无' ? '' : parsed.personalityTrait),
        }
      }

      // Auto-fetch a real photo avatar matching the code-chosen category —
      // only if the user hasn't already manually picked their own emoji/upload.
      // Best-effort: any failure (no Pexels key, network error, no results)
      // just falls back to the random emoji already sitting in `avatar`.
      let finalAvatar = avatar
      let avatarPhotographer: string | undefined
      let avatarPhotographerUrl: string | undefined
      if (!avatarManuallySet) {
        setProgressStep('avatar')
        try {
          const photo =
            avatarCategory === 'anime'
              ? await randomAnimeAvatar()
              : await searchPexelsPhoto(settings.pexelsApiKey, parsed.avatarKeyword || avatarCategory, 'square')
          if (photo) {
            finalAvatar = photo.url
            avatarPhotographer = photo.photographer
            avatarPhotographerUrl = photo.photographerUrl
          }
        } catch {
          // photo avatar is a nice-to-have; contact creation must still succeed
        }
      }

      setProgressStep('saving')
      const id = uuid()
      const now = Date.now()
      const chosenOccupation = values.occupation
      await db.contacts.add({
        id,
        name: parsed.name,
        realName: (isNuwaMode ? customRealName.trim() : '') || parsed.realName || parsed.name,
        nickname: (isNuwaMode ? customNickname.trim() : '') || (isNuwaMode ? parsed.nickname : parsed.name) || parsed.name,
        gender: values.gender || parsed.gender || parsed.personaProfile?.facts.find((fact) => fact.includes('性别')) || '',
        birthday: (isNuwaMode ? customBirthday.trim() : '') || parsed.birthday || fallbackBirthday(parsed.ageRange || values.ageRange),
        avatar: finalAvatar,
        avatarColor: randomAvatarColor(),
        avatarPhotographer,
        avatarPhotographerUrl,
        systemPrompt: parsed.persona,
        personaConstraints: extra.trim() || undefined,
        sharedHistory: effectiveSharedHistory || undefined,
        creatorProfile: { personalityTendencies: values.tags, age: values.ageRange || parsed.ageRange || '', gender: values.gender || parsed.gender || '', relationship: values.relationship || parsed.relationship || '', occupation: values.occupation || parsed.occupation || '', hobbies: values.hobbies, notes: extra.trim(), sharedHistory: effectiveSharedHistory },
        customPersonalityTraits: isNuwaMode ? effectiveNuwaTraits() : undefined,
        personaProfile: parsed.personaProfile,
        speechSamples: parsed.speechSamples,
        createdAt: now,
        memoryFacts: '',
        memoryStyle: '',
        memoryUpdatedAt: 0,
        memoryMessageCursor: 0,
        ...(relEnabled
          ? { warmth: initialWarmthForBase(values.relationship || parsed.relationship || '朋友', values.personalityTrait || parsed.personalityTrait) }
          : {}),
        relationshipBase: values.relationship || parsed.relationship || '朋友',
        relationshipDynamic: '',
        personalityTrait: values.personalityTrait || parsed.personalityTrait || '无',
        schedule: parsed.schedule,
        scheduleOverrides: [],
        mbti: parsed.mbti || undefined,
        ...(careerEnabled && (chosenOccupation || parsed.occupation) ? employmentPatch(chosenOccupation || parsed.occupation || '', parsed.monthlySalary ?? 6000) : {}),
      })
      if (personaSettingText) {
        await db.contacts.update(id, { personaConstraints: [extra.trim(), personaSettingText].filter(Boolean).join('\n\n') })
      }
      await db.conversations.add({
        id: uuid(),
        contactId: id,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      })
      for (const row of values.relationRows) {
        await setPairedContactRelation(id, row.targetContactId, row.label)
        await rememberInitialContactRelation({
          fromContactId: id,
          toContactId: row.targetContactId,
          label: row.label,
          now,
        })
      }
      await db.personaCreationRecords.add({
        id: uuid(),
        sourceContactId: id,
        name: parsed.name,
        realName: parsed.realName,
        nickname: parsed.nickname,
        birthday: parsed.birthday,
        gender: values.gender || parsed.gender,
        ageRange: values.ageRange || parsed.ageRange,
        relationship: values.relationship || parsed.relationship,
        occupation: values.occupation || parsed.occupation,
        personalityTrait: values.personalityTrait || parsed.personalityTrait,
        hobbies: values.hobbies,
        personaSetting: personaSettingText || parsed.persona,
        roleDescription: extra.trim() || undefined,
        persona: parsed.persona,
        personaProfile: parsed.personaProfile,
        speechSamples: parsed.speechSamples,
        mbti: parsed.mbti,
        schedule: parsed.schedule,
        avatarKeyword: parsed.avatarKeyword,
        monthlySalary: parsed.monthlySalary,
        sharedHistory: effectiveSharedHistory || undefined,
        createdAt: now,
      })
      navigate('/contacts')
      console.info(`[persona-perf] 创建完成=${Math.round(performance.now() - generationStartedAt)}ms`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
      setProgressStep(null)
    }
  }

  function addCustomTrait() {
    setCustomTraits((prev) => [...prev, { id: uuid(), name: '', meaning: '', rules: [{ id: uuid(), minWarmth: -100, maxWarmth: 100, positiveMultiplier: 1, negativeMultiplier: 1, prompt: '' }] }])
  }

  function updateCustomTrait(id: string, patch: Partial<CustomPersonalityTrait>) {
    setCustomTraits((prev) => prev.map((trait) => trait.id === id ? { ...trait, ...patch } : trait))
  }

  function moveCustomTrait(index: number, direction: -1 | 1) {
    setCustomTraits((prev) => {
      const target = index + direction
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]; [next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }


  function completelyRandom() {
    const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]
    const randomRows: RelationRow[] = existingContacts.filter(() => Math.random() < 0.35).map((contact) => ({ key: uuid(), targetContactId: contact.id, label: pick(CONTACT_RELATION_LABELS) }))
    const randomOccupation = careerEnabled ? pick(OCCUPATION_OPTIONS) : ''
    const values = { tags: [pick(PERSONALITY_TAG_OPTIONS), pick(PERSONALITY_TAG_OPTIONS)].filter((v, i, a) => a.indexOf(v) === i), ageRange: pick(AGE_RANGE_OPTIONS), gender: pick(GENDER_OPTIONS.filter((x) => x !== '不限')), relationship: pick(RELATIONSHIP_OPTIONS), personalityTrait: personalityEnabled ? pick(PERSONALITY_TRAIT_OPTIONS.filter((x) => x.value !== '无')).value : '', hobbies: [...HOBBY_TAG_OPTIONS].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 4)), occupation: randomOccupation, relationRows: randomRows }
    setTags(values.tags); setAgeRange(values.ageRange); setGender(values.gender); setRelationship(values.relationship); setPersonalityTrait(values.personalityTrait); setHobbies(values.hobbies); setOccupation(randomOccupation); setRelationRows(randomRows)
    void handleGenerate(values)
  }

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="添加联系人" showBack />

      <div className="mt-3 flex-1 overflow-y-auto bg-white px-4 py-4">
        <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-1" role="group" aria-label="创建模式">
          <div className="grid grid-cols-2 gap-1">
            <button type="button" aria-pressed={!isNuwaMode} onClick={() => { setIsNuwaMode(false); setPersonaDraft(null); setError('') }} className={`rounded-lg py-2.5 text-sm ${!isNuwaMode ? 'bg-white font-medium text-gray-900 shadow-sm' : 'text-gray-500'}`}>常规模式</button>
            <button type="button" aria-pressed={isNuwaMode} onClick={() => { setIsNuwaMode(true); setPersonaDraft(null); setError('') }} className={`rounded-lg py-2.5 text-sm ${isNuwaMode ? 'bg-purple-600 font-medium text-white shadow-sm' : 'text-gray-500'}`}>女娲模式</button>
          </div>
          <p className="px-2 pb-1 pt-2 text-[11px] leading-relaxed text-gray-400">女娲模式会先生成一份完整人设初稿，你可以逐项修改，确认后才会创建联系人。</p>
        </div>
        {!isNuwaMode && <button type="button" onClick={completelyRandom} disabled={generating} className="mb-4 w-full rounded-lg bg-gray-900 py-3 text-sm font-medium text-white transition active:scale-[.98] disabled:opacity-50">🎲 完全随机创建</button>}
        {isNuwaMode && <p className="mb-2 text-xs text-purple-600">女娲模式：先写初稿建议和你确定的设定，AI只补全仍为空的内容。</p>}
        <p className="mb-4 text-xs text-gray-400">
          描述一下你想认识的这个人 名字会由对方自己来定 确认添加后就正式加上了 之后不能再改TA的性格设定
        </p>

        {isNuwaMode && <div className="mb-4 grid grid-cols-2 gap-2"><button type="button" onClick={() => void saveCurrentPersona()} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white">保存当前人设</button><button type="button" onClick={() => { setPersonaPage(0); setPersonaPickerOpen(true) }} className="rounded-lg border border-gray-300 bg-white py-2.5 text-sm text-gray-800">使用已保存的人设</button></div>}
        {isNuwaMode && <button type="button" onClick={() => setCreationPickerOpen(true)} className="mb-4 w-full rounded-lg border border-purple-200 bg-purple-50 py-2.5 text-sm text-purple-700">调用以前创建过的人设（{creationRecords.length}）</button>}
        {!draftMode && <>
        <label className="mb-1 block text-xs text-gray-400">头像</label>
        <button
          onClick={() => setPickingAvatar(true)}
          className="mb-1 flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2"
        >
          <Avatar avatar={avatar} size={44} />
          <span className="text-sm text-gray-500">点击选择</span>
        </button>
        <p className="mb-4 text-xs text-gray-400">
          不手动选的话 系统会按性格自动配一张动漫头像/风景照/网图人像/宠物照
        </p>
        </>}

        {!isNuwaMode && <><label className="mb-2 block text-xs font-medium text-gray-400">性格倾向（可多选，也可以自己填）</label>
        <div className="mb-2 flex flex-wrap gap-2">
          {PERSONALITY_TAG_OPTIONS.map((tag) => (
            <button
              key={tag}
              onClick={() => toggleTag(tag)}
              className={`rounded-full px-3 py-1.5 text-xs ${
                tags.includes(tag) ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {tag}
            </button>
          ))}
          {tags
            .filter((t) => !PERSONALITY_TAG_OPTIONS.includes(t))
            .map((tag) => (
              <button
                key={tag}
                onClick={() => toggleTag(tag)}
                className="rounded-full bg-gray-900 px-3 py-1.5 text-xs text-white"
              >
                {tag} ×
              </button>
            ))}
        </div>
        <div className="mb-4 flex gap-2">
          <input
            value={customTag}
            onChange={(e) => setCustomTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addCustomTag()
              }
            }}
            placeholder="自定义一个性格标签"
            className="flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs"
          />
          <button onClick={addCustomTag} className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs text-gray-600">
            添加
          </button>
          <button onClick={addRandomTrait} className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs text-gray-600">
            🎲 随机词条
          </button>
        </div>

        <label className="mb-2 block text-xs font-medium text-gray-400">年龄段</label>
        <div className="mb-4 flex flex-wrap gap-2">
          {AGE_RANGE_OPTIONS.map((v) => (
            <button
              key={v}
              onClick={() => setAgeRange(ageRange === v ? '' : v)}
              className={`rounded-full px-3 py-1.5 text-xs ${
                ageRange === v ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {v}
            </button>
          ))}
        </div>

        <label className="mb-2 block text-xs font-medium text-gray-400">性别</label>
        <div className="mb-4 flex flex-wrap gap-2">
          {GENDER_OPTIONS.map((v) => (
            <button
              key={v}
              onClick={() => setGender(v === '不限' ? '' : v)}
              className={`rounded-full px-3 py-1.5 text-xs ${
                gender === v || (v === '不限' && !gender) ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {v}
            </button>
          ))}
        </div>

        <label className="mb-2 block text-xs font-medium text-gray-400">关系定位</label>
        <div className="mb-4 flex flex-wrap gap-2">
          {RELATIONSHIP_OPTIONS.map((v) => (
            <button
              key={v}
              onClick={() => setRelationship(relationship === v ? '' : v)}
              className={`rounded-full px-3 py-1.5 text-xs ${
                relationship === v ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {v}
            </button>
          ))}
        </div>

        {personalityEnabled && (
          <>
            <label className="mb-2 block text-xs font-medium text-gray-400">性格特质</label>
            <div className="mb-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  const traits = PERSONALITY_TRAIT_OPTIONS.filter((o) => o.value !== '无')
                  const pick = traits[Math.floor(Math.random() * traits.length)]
                  setPersonalityTrait(pick.value)
                }}
                className="rounded-full bg-gray-100 px-3 py-1.5 text-xs text-gray-600"
              >
                🎲 随机
              </button>
              {PERSONALITY_TRAIT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setPersonalityTrait(personalityTrait === opt.value ? '' : opt.value)}
                  className={`rounded-full px-3 py-1.5 text-xs ${
                    personalityTrait === opt.value ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                  title={opt.description}
                >
                  {opt.value}
                </button>
          ))}
            </div>
          </>
        )}

        {careerEnabled && <div className="mb-4"><label className="mb-2 block text-xs font-medium text-gray-400">职业（必选）</label><div className="flex flex-wrap gap-2"><button type="button" onClick={()=>setOccupation(OCCUPATION_OPTIONS[Math.floor(Math.random()*OCCUPATION_OPTIONS.length)])} className="rounded-full bg-gray-100 px-3 py-1.5 text-xs text-gray-600">🎲 随机</button>{[...OCCUPATION_OPTIONS,'自定义'].map(v=><button key={v} type="button" onClick={()=>setOccupation(v)} className={`rounded-full px-3 py-1.5 text-xs ${occupation===v?'bg-gray-900 text-white':'bg-gray-100 text-gray-600'}`}>{v}</button>)}</div>{occupation==='自定义'&&<input value={customOccupation} onChange={e=>setCustomOccupation(e.target.value)} placeholder="输入职业" className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/>}</div>}

        {/* 兴趣爱好（可选） */}
        <div className="mb-4">
          <label className="mb-2 block text-xs font-medium text-gray-400">兴趣爱好（可选）</label>
          <div className="flex flex-wrap gap-2">
            {HOBBY_TAG_OPTIONS.map((hobby) => (
              <button
                key={hobby}
                type="button"
                onClick={() =>
                  setHobbies(
                    hobbies.includes(hobby)
                      ? hobbies.filter((h) => h !== hobby)
                      : [...hobbies, hobby],
                  )
                }
                className={`rounded-full px-3 py-1.5 text-xs ${
                  hobbies.includes(hobby) ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
                }`}
              >
                {hobby}
              </button>
            ))}
          </div>
        </div></>}

        {!draftMode && isNuwaMode && <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl border border-gray-200 p-3"><label className="col-span-2 text-xs font-medium text-gray-500">身份资料（可留空，由 AI 补全）</label><input value={customRealName} onChange={(e) => setCustomRealName(e.target.value)} placeholder="真名" className="rounded-lg border border-gray-200 px-3 py-2 text-sm"/><input value={customNickname} onChange={(e) => setCustomNickname(e.target.value)} placeholder="网名" className="rounded-lg border border-gray-200 px-3 py-2 text-sm"/><input value={customBirthday} onChange={(e) => setCustomBirthday(e.target.value)} placeholder="出生年月日 YYYY-MM-DD" className="col-span-2 rounded-lg border border-gray-200 px-3 py-2 text-sm"/></div>}

        {!draftMode && isNuwaMode && <div className="mb-4 space-y-3"><div><label className="mb-1 block text-xs font-medium text-gray-400">性格倾向</label><input value={customTendencies} onChange={(e) => setCustomTendencies(e.target.value)} placeholder="例如：慢热、敏感、有主见（顿号分隔）" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/></div><div className="grid grid-cols-2 gap-2"><div><label className="mb-1 block text-xs text-gray-400">年龄</label><input value={customAge} onChange={(e) => setCustomAge(e.target.value)} placeholder="例如：24岁" className="w-full rounded-lg border px-3 py-2 text-sm"/></div><div><label className="mb-1 block text-xs text-gray-400">性别</label><input value={customGender} onChange={(e) => setCustomGender(e.target.value)} placeholder="自由填写" className="w-full rounded-lg border px-3 py-2 text-sm"/></div></div><div><label className="mb-1 block text-xs text-gray-400">关系定位</label><input value={customRelationship} onChange={(e) => setCustomRelationship(e.target.value)} placeholder="与用户是什么关系" className="w-full rounded-lg border px-3 py-2 text-sm"/></div>{careerEnabled && <div><label className="mb-1 block text-xs text-gray-400">职业</label><input value={customOccupation} onChange={(e) => setCustomOccupation(e.target.value)} placeholder="自由填写职业" className="w-full rounded-lg border px-3 py-2 text-sm"/></div>}<div><label className="mb-1 block text-xs text-gray-400">兴趣爱好</label><input value={customHobbies} onChange={(e) => setCustomHobbies(e.target.value)} placeholder="多个兴趣用顿号分隔" className="w-full rounded-lg border px-3 py-2 text-sm"/></div></div>}

        {!draftMode && isNuwaMode && <section className="mb-4"><div className="mb-2 flex items-center justify-between"><label className="text-xs font-medium text-gray-500">自定义性格特质</label><button type="button" onClick={addCustomTrait} className="text-xs text-purple-600">+ 添加特质</button></div><div className="space-y-3">{customTraits.map((trait, traitIndex) => <div key={trait.id} className="rounded-xl border border-gray-200 p-3"><div className="mb-2 flex items-center justify-end gap-2 text-xs"><button onClick={() => moveCustomTrait(traitIndex, -1)} disabled={traitIndex === 0}>↑</button><button onClick={() => moveCustomTrait(traitIndex, 1)} disabled={traitIndex === customTraits.length - 1}>↓</button><button onClick={() => setCustomTraits((x) => x.filter((t) => t.id !== trait.id))} className="text-red-500">删除特质</button></div><div className="flex gap-2"><input value={trait.name} onChange={(e) => updateCustomTrait(trait.id, { name: e.target.value })} placeholder="特质名称" className="w-1/3 rounded-lg border px-2 py-1.5 text-sm"/><input value={trait.meaning} onChange={(e) => updateCustomTrait(trait.id, { meaning: e.target.value })} placeholder="特质含义" className="flex-1 rounded-lg border px-2 py-1.5 text-sm"/></div>{trait.rules.map((rule) => <div key={rule.id} className="mt-2 rounded-lg bg-gray-50 p-2"><div className="grid grid-cols-4 gap-1"><input type="number" value={rule.minWarmth} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, minWarmth: Number(e.target.value) } : r) })} title="最低好感" className="rounded border px-1 py-1 text-xs"/><input type="number" value={rule.maxWarmth} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, maxWarmth: Number(e.target.value) } : r) })} title="最高好感" className="rounded border px-1 py-1 text-xs"/><input type="number" min="0" max="10" step="0.1" value={rule.positiveMultiplier} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, positiveMultiplier: Number(e.target.value) } : r) })} title="上升倍率" className="rounded border px-1 py-1 text-xs"/><input type="number" min="0" max="10" step="0.1" value={rule.negativeMultiplier} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, negativeMultiplier: Number(e.target.value) } : r) })} title="下降倍率" className="rounded border px-1 py-1 text-xs"/></div><div className="mt-1 flex gap-1"><input value={rule.prompt} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, prompt: e.target.value } : r) })} placeholder="命中区间时给予的提示词" className="flex-1 rounded border px-2 py-1 text-xs"/><button onClick={() => updateCustomTrait(trait.id, { rules: trait.rules.filter((r) => r.id !== rule.id) })} className="text-xs text-red-500">删规则</button></div></div>)}<button type="button" onClick={() => updateCustomTrait(trait.id, { rules: [...trait.rules, { id: uuid(), minWarmth: -100, maxWarmth: 100, positiveMultiplier: 1, negativeMultiplier: 1, prompt: '' }] })} className="mt-2 text-xs text-purple-600">+ 添加区间规则</button><span className="ml-2 text-[10px] text-gray-400">优先级 {traitIndex + 1}</span></div>)}</div></section>}

        {isNuwaMode && customTraits.some(hasOverlappingCustomTraitRules) && <p className="-mt-3 mb-4 text-xs text-amber-600">存在重叠区间；命中时倍率会相乘、提示词会合并。</p>}

        {existingContacts.length > 0 && !draftMode && (
          <>
            <div className="mb-2 flex items-center justify-between">
              <label className="block text-xs font-medium text-gray-400">TA与其他联系人的关系（可选）</label>
              <button
                onClick={addRelationRow}
                disabled={relationRows.length >= existingContacts.length}
                className="text-xs text-[#aa3bff] disabled:opacity-40"
              >
                + 添加关系
              </button>
            </div>
            <div className="mb-4 space-y-2">
              {relationRows.map((row) => (
                <div key={row.key} className="flex items-center gap-2">
                  <select
                    value={row.targetContactId}
                    onChange={(e) => updateRelationRow(row.key, { targetContactId: e.target.value })}
                    className="flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                  >
                    {existingContacts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {displayName(c)}
                      </option>
                    ))}
                  </select>
                  {isNuwaMode ? <input value={row.label} onChange={(e) => updateRelationRow(row.key, { label: e.target.value })} placeholder="自定义关系" className="flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-xs"/> : <select
                    value={row.label}
                    onChange={(e) =>
                      updateRelationRow(row.key, { label: e.target.value as ContactRelationLabel })
                    }
                    className="flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                  >
                    {CONTACT_RELATION_LABELS.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>}
                  <button onClick={() => removeRelationRow(row.key)} className="shrink-0 text-xs text-gray-300">
                    删除
                  </button>
                </div>
              ))}
              {relationRows.length === 0 && (
                <p className="text-xs text-gray-400">不设置的话TA和其他联系人之间默认没有关系 不会互相在朋友圈下面互动</p>
              )}
            </div>
          </>
        )}

        {!draftMode && <>
          <label className="mb-2 block text-xs font-medium text-gray-400">与用户的过往 / 共同经历（强烈建议填写）</label>
          <textarea
            value={sharedHistory}
            onChange={(e) => setSharedHistory(e.target.value)}
            placeholder="例如：你们在大学社团认识，TA曾陪你熬夜准备考试；这是首轮聊天必须能感受到的关系底色。"
            rows={3}
            className="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
        </>}
        <label className="mb-2 block text-xs font-medium text-gray-400">{draftMode ? '角色说明 / 初稿建议' : '补充说明（可选）'}</label>
        <textarea
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder={draftMode ? '例如：想要一个嘴硬但很在乎我的雌小鬼恋人，我们小时候就认识。AI会先生成初稿，之后你可以修改。' : '比如职业、爱好、说话口头禅、你们认识的契机…'}
          rows={4}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />

        {isNuwaMode && (
          <div className="mt-2">
            <p className="mb-2 text-[11px] leading-relaxed text-gray-500">这里告诉 AI 你希望补全的方向、重点和边界。AI 会结合初稿建议、下方已填设定和启用中的世界书，只补空白项，不改动你已经填写的内容。</p>
            <button type="button" onClick={() => void polishNuwaPersona()} disabled={polishingPersona || generating} className="w-full rounded-lg bg-purple-600 px-3 py-2 text-xs text-white disabled:opacity-50">{polishingPersona ? 'AI补全中…' : 'AI补全'}</button>
            {error && <p className="mt-2 text-xs leading-relaxed text-red-500">{error}</p>}
          </div>
        )}

        {isNuwaMode && (
          <section className="mt-4 rounded-xl border border-purple-200 bg-purple-50/40 p-3" data-testid="nuwa-persona-setting">
            <label className="block text-sm font-medium text-purple-900">角色设定</label>
            <p className="mt-1 text-[11px] leading-relaxed text-purple-600">逐项填写你已经确定的内容，空白项可交给 AI 补全。性格特质和角色关系既可选用建议，也可完全自定义。</p>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs font-medium text-purple-800">真名<input value={customRealName} onChange={(event) => setCustomRealName(event.target.value)} placeholder="可选" className="mt-1 w-full rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm" /></label>
                <label className="block text-xs font-medium text-purple-800">网名/昵称<input value={customNickname} onChange={(event) => setCustomNickname(event.target.value)} placeholder="可选" className="mt-1 w-full rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm" /></label>
                <label className="col-span-2 block text-xs font-medium text-purple-800">出生日期<input value={customBirthday} onChange={(event) => setCustomBirthday(event.target.value)} placeholder="例如：2000-06-15，可留空" className="mt-1 w-full rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm" /></label>
              </div>
              <label className="block text-xs font-medium text-purple-800">性格倾向<input value={customTendencies} onChange={(event) => setCustomTendencies(event.target.value)} placeholder="例如：慢热、敏感、有主见；完全自由填写" className="mt-1 w-full rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm" /></label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs font-medium text-purple-800">年龄<input value={customAge} onChange={(event) => setCustomAge(event.target.value)} placeholder="例如：24岁" className="mt-1 w-full rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm" /></label>
                <label className="block text-xs font-medium text-purple-800">性别<input value={customGender} onChange={(event) => setCustomGender(event.target.value)} placeholder="例如：女性、非二元" className="mt-1 w-full rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm" /></label>
              </div>
              <label className="block text-xs font-medium text-purple-800">关系定位<input value={customRelationship} onChange={(event) => setCustomRelationship(event.target.value)} placeholder="例如：青梅竹马、同事、暧昧对象" className="mt-1 w-full rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm" /></label>
              <label className="block text-xs font-medium text-purple-800">职业<input value={customOccupation} onChange={(event) => setCustomOccupation(event.target.value)} placeholder="完全自由填写职业" className="mt-1 w-full rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm" /></label>
              <label className="block text-xs font-medium text-purple-800">兴趣爱好<input value={customHobbies} onChange={(event) => setCustomHobbies(event.target.value)} placeholder="例如：摄影、烘焙、深夜散步" className="mt-1 w-full rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm" /></label>
              <div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs font-medium text-purple-800">性格特质名称<input value={personalityTrait} onChange={(event) => setPersonalityTrait(event.target.value)} placeholder="例如：嘴硬心软" className="mt-1 w-full rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm" /></label>
                  <div className="flex items-end">
                    <button type="button" aria-expanded={traitPickerOpen} onClick={() => setTraitPickerOpen((open) => !open)} className="w-full rounded-lg border border-purple-200 bg-white px-3 py-2 text-sm text-purple-700">{traitPickerOpen ? '收起特质选项' : '展开特质选项'}</button>
                  </div>
                </div>
                {traitPickerOpen && (
                  <div className="mt-2 rounded-xl border border-purple-100 bg-white p-3">
                    <p className="mb-2 text-[11px] font-medium text-purple-700">系统性格特质</p>
                    <div className="flex flex-wrap gap-2">
                      {PERSONALITY_TRAIT_OPTIONS.filter((option) => option.value !== '无').map((option) => <button key={option.value} type="button" onClick={() => choosePersonalityTrait(option.value, option.description)} className="rounded-full bg-purple-50 px-3 py-1.5 text-xs text-purple-700">{option.value}</button>)}
                    </div>
                    <p className="mb-2 mt-3 text-[11px] font-medium text-purple-700">曾使用过的自定义特质</p>
                    {previouslyUsedTraits.length > 0 ? <div className="space-y-2">{previouslyUsedTraits.map((trait) => <button key={`${trait.name}:${trait.meaning}`} type="button" onClick={() => choosePersonalityTrait(trait.name, trait.meaning)} className="block w-full rounded-lg bg-gray-50 px-3 py-2 text-left"><span className="block text-xs font-medium text-gray-800">{trait.name}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-gray-500">{trait.meaning}</span></button>)}</div> : <p className="text-[11px] text-gray-400">还没有使用过自定义性格特质</p>}
                  </div>
                )}
                <label className="mt-2 block text-xs font-medium text-purple-800">性格特质内容<textarea value={personalityTraitContent} onChange={(event) => setPersonalityTraitContent(event.target.value)} rows={3} placeholder="描述这个特质会怎样影响TA的行为、情绪反应和相处方式" className="mt-1 w-full resize-y rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm leading-relaxed" /></label>
              </div>
              {existingContacts.length > 0 && (
                <div className="rounded-xl border border-purple-100 bg-white p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div><p className="text-xs font-medium text-purple-800">与其他角色的关系</p><p className="mt-0.5 text-[10px] text-gray-400">从已有角色中选择，关系名称可自定义</p></div>
                    <button type="button" onClick={addRelationRow} disabled={relationRows.length >= existingContacts.length} className="shrink-0 text-xs text-purple-600 disabled:opacity-40">+ 添加关系</button>
                  </div>
                  <div className="mt-2 space-y-2">
                    {relationRows.map((row) => <div key={row.key} className="flex items-center gap-2"><select value={row.targetContactId} onChange={(event) => updateRelationRow(row.key, { targetContactId: event.target.value })} className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-2 text-xs">{existingContacts.map((contact) => <option key={contact.id} value={contact.id} disabled={relationRows.some((other) => other.key !== row.key && other.targetContactId === contact.id)}>{displayName(contact)}</option>)}</select><input value={row.label} onChange={(event) => updateRelationRow(row.key, { label: event.target.value })} placeholder="自定义关系" className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-2 text-xs"/><button type="button" onClick={() => removeRelationRow(row.key)} className="shrink-0 text-xs text-gray-400">删除</button></div>)}
                    {relationRows.length === 0 && <p className="text-[11px] text-gray-400">暂未设置与其他角色的关系</p>}
                  </div>
                </div>
              )}
              <label className="block text-xs font-medium text-purple-800">其他角色设定（可选）</label>
              <textarea value={nuwaPersonaSetting} onChange={(event) => setNuwaPersonaSetting(event.target.value)} rows={6} placeholder="补充经历、边界、习惯、生活细节、说话方式、关系表现等……" className="w-full resize-y rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm leading-relaxed" />
            </div>
          </section>
        )}

        {isNuwaMode && personaDraft && (
          <section className="mt-4 rounded-xl border border-purple-200 bg-purple-50/40 p-3" data-testid="nuwa-persona-draft">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div><h3 className="text-sm font-medium text-purple-900">AI人设初稿</h3><p className="mt-0.5 text-[11px] text-purple-600">直接检查和修改完整人设，确认后将用于创建联系人。</p></div>
              <button type="button" onClick={() => setPersonaDraft(null)} className="text-xs text-purple-600 underline">重新生成</button>
            </div>
            <div className="mb-3 space-y-3">
              <label className="block text-xs font-medium text-purple-800">MBTI<input value={personaDraft.mbti ?? ''} onChange={(event) => setPersonaDraft((draft) => draft ? { ...draft, mbti: event.target.value } : draft)} placeholder="例如 INFP" className="mt-1 w-full rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm" /></label>
              <label className="block text-xs font-medium text-purple-800">头像关键词<input value={personaDraft.avatarKeyword ?? ''} onChange={(event) => setPersonaDraft((draft) => draft ? { ...draft, avatarKeyword: event.target.value } : draft)} placeholder="用于头像搜索的英文关键词" className="mt-1 w-full rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm" /></label>
            </div>
            <label className="block text-xs font-medium text-purple-800">完整人设</label>
            <textarea value={personaDraft.persona} onChange={(e) => setPersonaDraft((draft) => draft ? { ...draft, persona: e.target.value } : draft)} rows={8} className="mt-1 w-full resize-y rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm leading-relaxed" />
            <label className="mt-3 block text-xs font-medium text-purple-800">说话样例（每行一条）</label>
            <textarea value={(personaDraft.speechSamples ?? []).join('\n')} onChange={(e) => setPersonaDraft((draft) => draft ? { ...draft, speechSamples: e.target.value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 8) } : draft)} rows={5} className="mt-1 w-full resize-y rounded-lg border border-purple-100 bg-white px-3 py-2 text-sm leading-relaxed" />
          </section>
        )}

        {!isNuwaMode && error && <p className="mt-3 text-xs text-red-500">{error}</p>}
      </div>

      <div className="sticky bottom-0 border-t border-gray-100 bg-white p-3">
        {generating && progressStep && (
          <div className="mb-2">
            <p className="mb-1 text-center text-xs text-gray-400">{PROGRESS_LABELS[progressStep]}</p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full bg-gray-900 transition-all duration-500"
                style={{ width: `${PROGRESS_PERCENT[progressStep]}%` }}
              />
            </div>
          </div>
        )}
        <button
          onClick={() => void handleGenerate(undefined, personaDraft ?? undefined)}
          disabled={generating || (!draftMode && careerEnabled && (isNuwaMode ? !customOccupation.trim() : (!occupation || (occupation === '自定义' && !customOccupation.trim()))))}
          className="w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-40"
        >
          {generating ? '正在处理…' : personaDraft ? '确认修改并创建' : isNuwaMode ? '生成AI初稿' : '确认添加'}
        </button>
      </div>

      {creationPickerOpen && <div className="absolute inset-0 z-40 flex items-center bg-black/30 p-4"><div className="max-h-[82%] w-full overflow-y-auto rounded-2xl bg-white p-4"><div className="mb-3 flex items-center justify-between"><div><h2 className="font-medium text-gray-900">以前创建过的人设</h2><p className="mt-1 text-[11px] text-gray-400">这些记录不会随联系人删除、回档或清空资料消失</p></div><button type="button" onClick={() => setCreationPickerOpen(false)} className="text-sm text-gray-500">关闭</button></div><div className="space-y-2">{creationRecords.map((record) => <button key={record.id} type="button" onClick={() => applyCreationRecord(record)} className="w-full rounded-xl bg-gray-50 px-3 py-3 text-left"><div className="flex items-center justify-between"><span className="text-sm font-medium text-gray-900">{record.nickname || record.name}</span><span className="text-[10px] text-gray-400">{new Date(record.createdAt).toLocaleString()}</span></div><p className="mt-1 line-clamp-2 text-xs text-gray-500">{record.personaSetting || record.persona}</p></button>)}{creationRecords.length === 0 && <p className="py-8 text-center text-sm text-gray-400">还没有创建记录</p>}</div></div></div>}

      {personaPickerOpen && <div className="absolute inset-0 z-30 flex items-center bg-black/30 p-4"><div className="w-full rounded-2xl bg-white p-4"><div className="mb-3 flex items-center justify-between"><h2 className="font-medium">已保存的人设</h2><button type="button" onClick={() => setPersonaPickerOpen(false)} className="text-sm text-gray-500">关闭</button></div><div className="space-y-2">{savedPersonas.slice(personaPage * 5, personaPage * 5 + 5).map((saved, index) => <button key={saved.id} type="button" onClick={() => applySavedPersona(saved)} className="flex w-full items-center justify-between rounded-xl bg-gray-50 px-3 py-3 text-left"><span className="text-sm text-gray-900">{saved.nickname || saved.realName || `未命名人设${personaPage * 5 + index + 1}`}</span><span className="text-xs text-gray-400">使用</span></button>)}{savedPersonas.length === 0 && <p className="py-6 text-center text-sm text-gray-400">还没有保存的人设</p>}</div><div className="mt-4 flex items-center justify-between"><button type="button" disabled={personaPage === 0} onClick={() => setPersonaPage((page) => page - 1)} className="text-sm text-gray-600 disabled:text-gray-300">上一页</button><span className="text-xs text-gray-400">{personaPage + 1} / {Math.max(1, Math.ceil(savedPersonas.length / 5))}</span><button type="button" disabled={(personaPage + 1) * 5 >= savedPersonas.length} onClick={() => setPersonaPage((page) => page + 1)} className="text-sm text-gray-600 disabled:text-gray-300">下一页</button></div></div></div>}
      {pickingAvatar && (
        <AvatarPicker
          onSelect={(a) => {
            setAvatar(a)
            setAvatarManuallySet(true)
          }}
          onClose={() => setPickingAvatar(false)}
        />
      )}
    </div>
  )
}
