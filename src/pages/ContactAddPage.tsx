import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { AvatarPicker } from '../components/AvatarPicker'
import { WorldbookEntrySelector } from '../components/WorldbookEntrySelector'
import { useSettingsStore } from '../store/useSettingsStore'
import { useModuleEnabled } from '../features'
import { chatCompletionText as chatCompletion } from '../lib/deepseek'
import { AVATAR_EMOJIS } from '../lib/avatarEmojis'
import { pickRandomTrait } from '../lib/randomTraits'
import { initialWarmthForBase } from '../lib/relationship'
import { Dice5 } from 'lucide-react'
import { displayName } from '../lib/contact'
import { isAiTestId } from '../lib/aiTestIsolation'
import { OCCUPATION_OPTIONS } from '../lib/career'
import { retrieveWorldbookContext, selectedWorldbookEntriesText } from '../lib/worldbook'
import { featureActive, getPromptTemplate } from '../lib/promptModules'
import { customTraitsValidationError, hasOverlappingCustomTraitRules } from '../lib/contactCreator'
import { characterCardPersonaText, parseSillyTavernCharacterCard } from '../lib/characterCardImport'
import { parseWorldbookFile, type ParsedWorldbookImport } from '../lib/worldbookImport'
import { createContactGenerationTask } from '../lib/contactGenerationTasks'
import { storeCharacterCardInLibrary } from '../lib/library'
import { CONTACT_RELATION_LABELS, HOBBY_TAG_OPTIONS, PERSONALITY_TRAIT_OPTIONS, type ContactRelationLabel, type CustomPersonalityTrait, type PersonaCreationRecord } from '../types'
import {
  AGE_RANGE_OPTIONS,
  GENDER_OPTIONS,
  PERSONALITY_TAG_OPTIONS,
  RELATIONSHIP_OPTIONS,
  type PersonaGenerationResult,
} from '../lib/prompt'
import {
  NUWA_FIELD_LABELS,
  NUWA_FORM_JSON_SCHEMA,
  NUWA_FORM_KEYS,
  hasNuwaFormFields,
  localNuwaFormatIssues,
  nuwaFormOutputProtocol,
  parseNuwaReview,
  parseNuwaStructuredResult,
  type NuwaStructuredResult,
} from '../lib/nuwaPersona'

interface RelationRow {
  key: string
  targetContactId: string
  label: ContactRelationLabel
}
export function ContactAddPage() {
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const existingContacts = (useLiveQuery(() => db.contacts.toArray(), []) ?? []).filter((item) => !isAiTestId(item.id))
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
  const [initialWarmthMode, setInitialWarmthMode] = useState<'auto' | 'custom'>('auto')
  const [customInitialWarmth, setCustomInitialWarmth] = useState(0)
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
  const [worldbookSelectorOpen, setWorldbookSelectorOpen] = useState(false)
  const [selectedWorldbookEntryIds, setSelectedWorldbookEntryIds] = useState<string[]>([])
  const characterCardInputRef = useRef<HTMLInputElement | null>(null)
  const [importedFirstMessage, setImportedFirstMessage] = useState('')
  const [importedCardName, setImportedCardName] = useState('')
  const [pendingCardWorldbook, setPendingCardWorldbook] = useState<ParsedWorldbookImport | null>(null)
  const selectedWorldviewId = settings.activeWorldId || settings.defaultWorldviewId || ''

  useEffect(() => {
    if (settings.experienceMode === 'immersive' && isNuwaMode) {
      setIsNuwaMode(false)
      setPersonaDraft(null)
    }
  }, [settings.experienceMode, isNuwaMode])

  const compatibleContacts = existingContacts

  async function importCharacterCard(file: File) {
    try {
      const card = await parseSillyTavernCharacterCard(file, settings.userNickname || '用户')
      setIsNuwaMode(true)
      setPersonaDraft(null)
      setCustomRealName(card.name)
      setCustomNickname(card.name)
      setCustomTendencies(card.personality || card.tags.join('、'))
      setExtra(card.scenario)
      setSharedHistory(card.scenario)
      setNuwaPersonaSetting(characterCardPersonaText(card))
      setImportedFirstMessage(card.firstMessage)
      setImportedCardName(file.name)
      let cardLore: ParsedWorldbookImport | null = null
      try { cardLore = await parseWorldbookFile(file); setPendingCardWorldbook(cardLore) } catch { setPendingCardWorldbook(null) }
      await storeCharacterCardInLibrary({ name: card.name, content: characterCardPersonaText(card), keywords: card.tags, rawData: card.raw, sourceFileName: file.name }, cardLore ?? undefined)
      if (card.avatarDataUrl) { setAvatar(card.avatarDataUrl); setAvatarManuallySet(true) }
      setError('角色卡已保存到资料库并载入。请检查设定后生成初稿；内嵌世界书只作为本次参考资料，不会自动写入世界观。')
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError))
    } finally {
      if (characterCardInputRef.current) characterCardInputRef.current.value = ''
    }
  }

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
    if (!featureActive(settings, 'worldview')) return ''
    const [selectedText, retrievedText] = await Promise.all([
      selectedWorldbookEntriesText(selectedWorldbookEntryIds),
      retrieveWorldbookContext(query, { maxEntries: 8, maxChars: 6500, includeHighPriorityFallback: true, worldviewId: selectedWorldviewId }),
    ])
    return [
      selectedText ? `【用户为本次角色生成明确勾选的世界观——最高语义优先级】\n${selectedText}` : '',
      pendingCardWorldbook?.entries.length ? `【角色卡内嵌世界书——正史】\n${pendingCardWorldbook.entries.map((entry) => `【${entry.title}】\n${entry.content}`).join('\n\n')}` : '',
      retrievedText,
    ].filter(Boolean).join('\n\n')
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
    const automaticWarmth = initialWarmthForBase(profile.relationship || '朋友', personalityTrait)
    await db.savedPersonas.add({ id: uuid(), name: customNickname.trim() || customRealName.trim(), nickname: customNickname.trim() || undefined, realName: customRealName.trim() || undefined, birthday: customBirthday.trim() || undefined, profile, sharedHistory: profile.sharedHistory || undefined, personaConstraints: (isNuwaMode ? `${extra.trim()}\n${currentNuwaPersonaText()}` : extra.trim()) || undefined, customPersonalityTraits: isNuwaMode ? effectiveNuwaTraits() : customTraits, initialWarmth: isNuwaMode ? personaDraft?.initialWarmth : initialWarmthMode === 'custom' ? customInitialWarmth : automaticWarmth, initialWarmthMode: isNuwaMode ? 'ai' : initialWarmthMode, createdAt: now, updatedAt: now })
    setPersonaPage(0)
  }

  function applySavedPersona(saved: import('../types').SavedPersona) {
    const profile = saved.profile
    setNuwaPersonaSetting(saved.personaConstraints || profile.notes || '')
    const firstTrait = saved.customPersonalityTraits?.[0]
    setCustomTendencies(profile.personalityTendencies.join('、')); setCustomAge(profile.age); setCustomGender(profile.gender); setCustomRelationship(profile.relationship); setCustomOccupation(profile.occupation); setCustomHobbies(profile.hobbies.join('、')); setExtra(saved.personaConstraints || profile.notes || ''); setSharedHistory(saved.sharedHistory || profile.sharedHistory || ''); setCustomTraits(saved.customPersonalityTraits || []); setPersonalityTrait(firstTrait?.name || ''); setPersonalityTraitContent(firstTrait?.meaning || ''); setCustomRealName(saved.realName || ''); setCustomNickname(saved.nickname || ''); setCustomBirthday(saved.birthday || ''); setInitialWarmthMode(saved.initialWarmthMode === 'custom' ? 'custom' : 'auto'); if (typeof saved.initialWarmth === 'number') setCustomInitialWarmth(saved.initialWarmth); setPersonaPickerOpen(false)
  }

  async function deleteSavedPersona(saved: import('../types').SavedPersona) {
    const label = saved.nickname || saved.realName || saved.name || '未命名人设'
    if (!window.confirm(`确定删除已保存的人设“${label}”吗？\n已创建的联系人和创建历史不会受到影响。`)) return
    await db.savedPersonas.delete(saved.id)
    const remainingCount = Math.max(0, savedPersonas.length - 1)
    setPersonaPage((page) => Math.min(page, Math.max(0, Math.ceil(remainingCount / 5) - 1)))
  }

  async function deleteCreationRecord(record: PersonaCreationRecord) {
    const label = record.nickname || record.realName || record.name || '未命名人设'
    if (!window.confirm(`确定删除以前创建过的人设“${label}”吗？\n已经创建的联系人不会受到影响。`)) return
    await db.personaCreationRecords.delete(record.id)
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
      visualIdentity: record.visualIdentity,
      schedule: record.schedule || [],
      avatarKeyword: record.avatarKeyword || '',
      personalityTrait: record.personalityTrait || '',
      speechSamples: record.speechSamples || [],
      mbti: record.mbti || '',
      personaProfile: record.personaProfile,
      monthlySalary: record.monthlySalary,
      initialWarmth: record.initialWarmth,
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
    const firstAvailable = compatibleContacts.find((c) => !taken.has(c.id))
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
    const values = overrides ?? {
      tags: isNuwaMode ? customTendencies.split(/[、,，]+/).map((x) => x.trim()).filter(Boolean) : tags,
      ageRange: isNuwaMode ? customAge : ageRange,
      gender: isNuwaMode ? customGender : gender,
      relationship: isNuwaMode ? customRelationship : relationship,
      personalityTrait,
      hobbies: isNuwaMode ? customHobbies.split(/[、,，]+/).map((x) => x.trim()).filter(Boolean) : hobbies,
      occupation: isNuwaMode ? customOccupation.trim() : (occupation === '自定义' ? customOccupation.trim() : occupation),
      relationRows,
    }
    setGenerating(true)
    setError('')
    try {
      const taskId = await createContactGenerationTask({
        method: isNuwaMode ? 'precision' : 'discovery',
        experienceMode: settings.experienceMode,
        personaDraft: draftOverride,
        input: {
          personalityTags: values.tags,
          ageRange: values.ageRange,
          gender: values.gender,
          relationship: values.relationship,
          occupation: values.occupation,
          hobbies: values.hobbies,
          personalityTrait: values.personalityTrait,
          personalityTraitContent,
          roleDescription: extra.trim(),
          personaSetting: isNuwaMode ? currentNuwaPersonaText().trim() : '',
          sharedHistory: (isNuwaMode ? (sharedHistory || extra) : sharedHistory).trim(),
          realName: isNuwaMode ? customRealName.trim() : undefined,
          nickname: isNuwaMode ? customNickname.trim() : undefined,
          birthday: isNuwaMode ? customBirthday.trim() : undefined,
          avatar,
          avatarManuallySet,
          initialWarmthMode: isNuwaMode ? 'ai' : initialWarmthMode,
          initialWarmth: isNuwaMode ? draftOverride?.initialWarmth : customInitialWarmth,
          customPersonalityTraits: isNuwaMode ? effectiveNuwaTraits() : undefined,
          relations: values.relationRows.map((row) => ({ targetContactId: row.targetContactId, label: row.label })),
          worldviewId: selectedWorldviewId || settings.defaultWorldviewId,
          selectedWorldbookEntryIds,
          importedWorldbook: pendingCardWorldbook ?? undefined,
          importedFirstMessage,
          careerEnabled,
          relationshipEnabled: relEnabled,
          locationEnabled: settings.experienceMode === 'free' && settings.enabledModules.includes('location'),
        },
      })
      // On desktop the sidebar exposes active jobs, but mobile has no persistent
      // task pane. Go straight to the job page so mobile users can see progress,
      // review a precision draft, and recover from errors without hunting for it
      // in the contacts list.
      void navigate(`/contact-generation/${taskId}`)
      return
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    } finally {
      setGenerating(false)
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
    const randomRows: RelationRow[] = compatibleContacts.filter(() => Math.random() < 0.35).map((contact) => ({ key: uuid(), targetContactId: contact.id, label: pick(CONTACT_RELATION_LABELS) }))
    const randomOccupation = careerEnabled ? pick(OCCUPATION_OPTIONS) : ''
    const values = { tags: [pick(PERSONALITY_TAG_OPTIONS), pick(PERSONALITY_TAG_OPTIONS)].filter((v, i, a) => a.indexOf(v) === i), ageRange: pick(AGE_RANGE_OPTIONS), gender: pick(GENDER_OPTIONS.filter((x) => x !== '不限')), relationship: pick(RELATIONSHIP_OPTIONS), personalityTrait: personalityEnabled ? pick(PERSONALITY_TRAIT_OPTIONS.filter((x) => x.value !== '无')).value : '', hobbies: [...HOBBY_TAG_OPTIONS].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 4)), occupation: randomOccupation, relationRows: randomRows }
    setTags(values.tags); setAgeRange(values.ageRange); setGender(values.gender); setRelationship(values.relationship); setPersonalityTrait(values.personalityTrait); setHobbies(values.hobbies); setOccupation(randomOccupation); setRelationRows(randomRows); setInitialWarmthMode('auto')
    void handleGenerate(values)
  }

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="添加联系人" showBack />

      <div className="mt-3 flex-1 overflow-y-auto bg-white px-4 py-4">
        {settings.experienceMode === 'free' ? <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-1" role="group" aria-label="创建方式">
          <div className="grid grid-cols-2 gap-1">
            <button type="button" aria-pressed={!isNuwaMode} onClick={() => { setIsNuwaMode(false); setPersonaDraft(null); setError('') }} className={`rounded-lg py-2.5 text-sm ${!isNuwaMode ? 'bg-white font-medium text-gray-900 shadow-sm' : 'text-gray-500'}`}>帮我找人</button>
            <button type="button" aria-pressed={isNuwaMode} onClick={() => { setIsNuwaMode(true); setPersonaDraft(null); setError('') }} className={`rounded-lg py-2.5 text-sm ${isNuwaMode ? 'bg-[var(--ui-special)] font-medium text-white shadow-sm' : 'text-gray-500'}`}>精细创建</button>
          </div>
          <p className="px-2 pb-1 pt-2 text-[11px] leading-relaxed text-gray-400">帮我找人会随机补全所有未选择的项目；精细创建（女娲模式）会先生成可修改的完整初稿。</p>
        </div> : <div className="mb-4 rounded-xl border border-[var(--ui-special-border)] bg-[var(--ui-special-soft)] px-3 py-3"><p className="text-sm font-medium text-[var(--ui-special-ink)]">帮我找人</p><p className="mt-1 text-xs leading-relaxed text-[var(--ui-special-ink)]">只需选择你在意的条件，其他资料会在寻找过程中自然确定。</p></div>}
        {!isNuwaMode && <button type="button" onClick={completelyRandom} disabled={generating} className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg bg-gray-900 py-3 text-sm font-medium text-white transition active:scale-[.98] disabled:opacity-50"><Dice5 size={17} />完全随机寻找</button>}
        {settings.experienceMode === 'free' && <><button type="button" onClick={() => characterCardInputRef.current?.click()} disabled={generating} className="mb-4 w-full rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface-2)] py-2.5 text-sm text-[var(--ui-text-2)] disabled:opacity-50">导入角色卡到资料库并创建</button>
        <input ref={characterCardInputRef} type="file" accept=".png,.json,application/json,image/png" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importCharacterCard(file) }} />
        {importedCardName && <p className="-mt-2 mb-4 break-all text-[11px] text-[var(--ui-text-3)]">已载入：{importedCardName}</p>}</>}
        {isNuwaMode && <p className="mb-2 text-xs text-[var(--ui-special-ink)]">女娲模式：先写初稿建议和你确定的设定，AI只补全仍为空的内容。</p>}
        <p className="mb-4 text-xs text-gray-400">
          描述一下你想认识的这个人 名字会由对方自己来定；创建后可在管理员模式下修正完整设定
        </p>

        {isNuwaMode && <div className="mb-4 grid grid-cols-2 gap-2"><button type="button" onClick={() => void saveCurrentPersona()} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white">保存当前人设</button><button type="button" onClick={() => { setPersonaPage(0); setPersonaPickerOpen(true) }} className="rounded-lg border border-gray-300 bg-white py-2.5 text-sm text-gray-800">使用已保存的人设</button></div>}
        {isNuwaMode && <button type="button" onClick={() => setCreationPickerOpen(true)} className="mb-4 w-full rounded-lg border border-[var(--ui-special-border)] bg-[var(--ui-special-soft)] py-2.5 text-sm text-[var(--ui-special-ink)]">调用以前创建过的人设（{creationRecords.length}）</button>}
        {!draftMode && <>
        {settings.experienceMode === 'free' && <><label className="mb-1 block text-xs text-gray-400">头像</label>
        <button
          onClick={() => setPickingAvatar(true)}
          className="mb-1 flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2"
        >
          <Avatar avatar={avatar} size={44} />
          <span className="text-sm text-gray-500">点击选择</span>
        </button>
        <p className="mb-4 text-xs text-gray-400">
          不手动选的话 系统会按性格自动配一张动漫头像/风景照/网图人像/宠物照
        </p></>}
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
          <button onClick={addRandomTrait} className="flex items-center gap-1 rounded-lg bg-gray-100 px-3 py-1.5 text-xs text-gray-600">
            <Dice5 size={14} />随机词条
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
                className="flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1.5 text-xs text-gray-600"
              >
                <Dice5 size={13} />随机
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

        {relEnabled && !isNuwaMode && (
          <section className="mb-4 rounded-xl border border-gray-200 bg-white p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-gray-700">好感度</p>
                <p className="mt-0.5 text-[11px] text-gray-400">自动值会根据关系定位和性格特质计算</p>
              </div>
              <div className="flex rounded-lg bg-gray-100 p-0.5 text-xs">
                <button type="button" onClick={() => setInitialWarmthMode('auto')} className={`rounded-md px-2.5 py-1.5 ${initialWarmthMode === 'auto' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>自动</button>
                <button type="button" onClick={() => { setCustomInitialWarmth(initialWarmthForBase(relationship || '朋友', personalityTrait)); setInitialWarmthMode('custom') }} className={`rounded-md px-2.5 py-1.5 ${initialWarmthMode === 'custom' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>自定义</button>
              </div>
            </div>
            {initialWarmthMode === 'auto' ? (
              <p className="mt-3 text-center text-lg font-semibold text-[var(--ui-special-ink)]">{initialWarmthForBase(relationship || '朋友', personalityTrait)}</p>
            ) : (
              <div className="mt-3 flex items-center gap-3">
                <input type="range" min="-100" max="100" value={customInitialWarmth} onChange={(event) => setCustomInitialWarmth(Number(event.target.value))} className="min-w-0 flex-1 accent-[var(--ui-special)]" aria-label="好感度" />
                <input type="number" min="-100" max="100" value={customInitialWarmth} onChange={(event) => setCustomInitialWarmth(Math.max(-100, Math.min(100, Number(event.target.value) || 0)))} className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-center text-sm" />
              </div>
            )}
          </section>
        )}

        {careerEnabled && <div className="mb-4"><label className="mb-2 block text-xs font-medium text-gray-400">职业（可选，未选择则随机）</label><div className="flex flex-wrap gap-2"><button type="button" onClick={()=>setOccupation(OCCUPATION_OPTIONS[Math.floor(Math.random()*OCCUPATION_OPTIONS.length)])} className="flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1.5 text-xs text-gray-600"><Dice5 size={13} />随机</button>{[...OCCUPATION_OPTIONS,'自定义'].map(v=><button key={v} type="button" onClick={()=>setOccupation(v)} className={`rounded-full px-3 py-1.5 text-xs ${occupation===v?'bg-gray-900 text-white':'bg-gray-100 text-gray-600'}`}>{v}</button>)}</div>{occupation==='自定义'&&<input value={customOccupation} onChange={e=>setCustomOccupation(e.target.value)} placeholder="输入职业" className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/>}</div>}

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

        {!draftMode && isNuwaMode && <section className="mb-4"><div className="mb-2 flex items-center justify-between"><label className="text-xs font-medium text-gray-500">自定义性格特质</label><button type="button" onClick={addCustomTrait} className="text-xs text-[var(--ui-special-ink)]">+ 添加特质</button></div><div className="space-y-3">{customTraits.map((trait, traitIndex) => <div key={trait.id} className="rounded-xl border border-gray-200 p-3"><div className="mb-2 flex items-center justify-end gap-2 text-xs"><button onClick={() => moveCustomTrait(traitIndex, -1)} disabled={traitIndex === 0}>↑</button><button onClick={() => moveCustomTrait(traitIndex, 1)} disabled={traitIndex === customTraits.length - 1}>↓</button><button onClick={() => setCustomTraits((x) => x.filter((t) => t.id !== trait.id))} className="text-red-500">删除特质</button></div><div className="flex gap-2"><input value={trait.name} onChange={(e) => updateCustomTrait(trait.id, { name: e.target.value })} placeholder="特质名称" className="w-1/3 rounded-lg border px-2 py-1.5 text-sm"/><input value={trait.meaning} onChange={(e) => updateCustomTrait(trait.id, { meaning: e.target.value })} placeholder="特质含义" className="flex-1 rounded-lg border px-2 py-1.5 text-sm"/></div>{trait.rules.map((rule) => <div key={rule.id} className="mt-2 rounded-lg bg-gray-50 p-2"><div className="grid grid-cols-4 gap-1"><input type="number" value={rule.minWarmth} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, minWarmth: Number(e.target.value) } : r) })} title="最低好感" className="rounded border px-1 py-1 text-xs"/><input type="number" value={rule.maxWarmth} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, maxWarmth: Number(e.target.value) } : r) })} title="最高好感" className="rounded border px-1 py-1 text-xs"/><input type="number" min="0" max="10" step="0.1" value={rule.positiveMultiplier} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, positiveMultiplier: Number(e.target.value) } : r) })} title="上升倍率" className="rounded border px-1 py-1 text-xs"/><input type="number" min="0" max="10" step="0.1" value={rule.negativeMultiplier} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, negativeMultiplier: Number(e.target.value) } : r) })} title="下降倍率" className="rounded border px-1 py-1 text-xs"/></div><div className="mt-1 flex gap-1"><input value={rule.prompt} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, prompt: e.target.value } : r) })} placeholder="命中区间时给予的提示词" className="flex-1 rounded border px-2 py-1 text-xs"/><button onClick={() => updateCustomTrait(trait.id, { rules: trait.rules.filter((r) => r.id !== rule.id) })} className="text-xs text-red-500">删规则</button></div></div>)}<button type="button" onClick={() => updateCustomTrait(trait.id, { rules: [...trait.rules, { id: uuid(), minWarmth: -100, maxWarmth: 100, positiveMultiplier: 1, negativeMultiplier: 1, prompt: '' }] })} className="mt-2 text-xs text-[var(--ui-special-ink)]">+ 添加区间规则</button><span className="ml-2 text-[10px] text-gray-400">优先级 {traitIndex + 1}</span></div>)}</div></section>}

        {isNuwaMode && customTraits.some(hasOverlappingCustomTraitRules) && <p className="-mt-3 mb-4 text-xs text-amber-600">存在重叠区间；命中时倍率会相乘、提示词会合并。</p>}

        {existingContacts.length > 0 && !draftMode && (
          <>
            <div className="mb-2 flex items-center justify-between">
              <label className="block text-xs font-medium text-gray-400">TA与其他联系人的关系（可选）</label>
              <button
                onClick={addRelationRow}
                disabled={relationRows.length >= existingContacts.length}
                className="text-xs text-[var(--ui-special-ink)] disabled:opacity-40"
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
                    {compatibleContacts.map((c) => (
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
        {settings.experienceMode === 'free' && <section className="mb-4 rounded-xl border border-[var(--ui-special-border)] bg-[var(--ui-special-soft)] p-3">
          <div className="flex items-center justify-between gap-3">
            <div><p className="text-sm font-medium text-[var(--ui-special-ink)]">本次生成的参考资料</p><p className="mt-1 text-[11px] leading-relaxed text-[var(--ui-special-ink)]">从资料库选择角色卡、外部世界书或联网资料，只用于生成这个人物，不会自动写入世界正史。</p></div>
            <button type="button" onClick={() => setWorldbookSelectorOpen(true)} className="shrink-0 rounded-lg bg-[var(--ui-special)] px-3 py-2 text-xs text-white">选择资料</button>
          </div>
          <p className="mt-2 text-xs text-[var(--ui-special-ink)]">{selectedWorldbookEntryIds.length ? `已选择 ${selectedWorldbookEntryIds.length} 条资料` : '暂未额外选择，将使用所属世界的正史生成'}</p>
        </section>}
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
            <p className="mb-2 text-[11px] leading-relaxed text-gray-500">这里告诉 AI 你希望补全的方向、重点和边界。AI 会结合初稿建议、下方已填设定、所选资料和角色所属世界，只补空白项，不改动你已经填写的内容。</p>
            <button type="button" onClick={() => void polishNuwaPersona()} disabled={polishingPersona || generating} className="w-full rounded-lg bg-[var(--ui-special)] px-3 py-2 text-xs text-white disabled:opacity-50">{polishingPersona ? 'AI补全中…' : 'AI补全'}</button>
            {error && <p className="mt-2 text-xs leading-relaxed text-red-500">{error}</p>}
          </div>
        )}

        {isNuwaMode && (
          <section className="mt-4 rounded-xl border border-[var(--ui-special-border)] bg-[var(--ui-special-soft)] p-3" data-testid="nuwa-persona-setting">
            <label className="block text-sm font-medium text-[var(--ui-special-ink)]">角色设定</label>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--ui-special-ink)]">逐项填写你已经确定的内容，空白项可交给 AI 补全。性格特质和角色关系既可选用建议，也可完全自定义。</p>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs font-medium text-[var(--ui-special-ink)]">真名<input value={customRealName} onChange={(event) => setCustomRealName(event.target.value)} placeholder="可选" className="mt-1 w-full rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm" /></label>
                <label className="block text-xs font-medium text-[var(--ui-special-ink)]">网名/昵称<input value={customNickname} onChange={(event) => setCustomNickname(event.target.value)} placeholder="可选" className="mt-1 w-full rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm" /></label>
                <label className="col-span-2 block text-xs font-medium text-[var(--ui-special-ink)]">出生日期<input value={customBirthday} onChange={(event) => setCustomBirthday(event.target.value)} placeholder="例如：2000-06-15，可留空" className="mt-1 w-full rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm" /></label>
              </div>
              <label className="block text-xs font-medium text-[var(--ui-special-ink)]">性格倾向<input value={customTendencies} onChange={(event) => setCustomTendencies(event.target.value)} placeholder="例如：慢热、敏感、有主见；完全自由填写" className="mt-1 w-full rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm" /></label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs font-medium text-[var(--ui-special-ink)]">年龄<input value={customAge} onChange={(event) => setCustomAge(event.target.value)} placeholder="例如：24岁" className="mt-1 w-full rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm" /></label>
                <label className="block text-xs font-medium text-[var(--ui-special-ink)]">性别<input value={customGender} onChange={(event) => setCustomGender(event.target.value)} placeholder="例如：女性、非二元" className="mt-1 w-full rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm" /></label>
              </div>
              <label className="block text-xs font-medium text-[var(--ui-special-ink)]">关系定位<input value={customRelationship} onChange={(event) => setCustomRelationship(event.target.value)} placeholder="例如：青梅竹马、同事、暧昧对象" className="mt-1 w-full rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm" /></label>
              <label className="block text-xs font-medium text-[var(--ui-special-ink)]">职业<input value={customOccupation} onChange={(event) => setCustomOccupation(event.target.value)} placeholder="完全自由填写职业" className="mt-1 w-full rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm" /></label>
              <label className="block text-xs font-medium text-[var(--ui-special-ink)]">兴趣爱好<input value={customHobbies} onChange={(event) => setCustomHobbies(event.target.value)} placeholder="例如：摄影、烘焙、深夜散步" className="mt-1 w-full rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm" /></label>
              <div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs font-medium text-[var(--ui-special-ink)]">性格特质名称<input value={personalityTrait} onChange={(event) => setPersonalityTrait(event.target.value)} placeholder="例如：嘴硬心软" className="mt-1 w-full rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm" /></label>
                  <div className="flex items-end">
                    <button type="button" aria-expanded={traitPickerOpen} onClick={() => setTraitPickerOpen((open) => !open)} className="w-full rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm text-[var(--ui-special-ink)]">{traitPickerOpen ? '收起特质选项' : '展开特质选项'}</button>
                  </div>
                </div>
                {traitPickerOpen && (
                  <div className="mt-2 rounded-xl border border-[var(--ui-special-border)] bg-white p-3">
                    <p className="mb-2 text-[11px] font-medium text-[var(--ui-special-ink)]">系统性格特质</p>
                    <div className="flex flex-wrap gap-2">
                      {PERSONALITY_TRAIT_OPTIONS.filter((option) => option.value !== '无').map((option) => <button key={option.value} type="button" onClick={() => choosePersonalityTrait(option.value, option.description)} className="rounded-full bg-[var(--ui-special-soft)] px-3 py-1.5 text-xs text-[var(--ui-special-ink)]">{option.value}</button>)}
                    </div>
                    <p className="mb-2 mt-3 text-[11px] font-medium text-[var(--ui-special-ink)]">曾使用过的自定义特质</p>
                    {previouslyUsedTraits.length > 0 ? <div className="space-y-2">{previouslyUsedTraits.map((trait) => <button key={`${trait.name}:${trait.meaning}`} type="button" onClick={() => choosePersonalityTrait(trait.name, trait.meaning)} className="block w-full rounded-lg bg-gray-50 px-3 py-2 text-left"><span className="block text-xs font-medium text-gray-800">{trait.name}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-gray-500">{trait.meaning}</span></button>)}</div> : <p className="text-[11px] text-gray-400">还没有使用过自定义性格特质</p>}
                  </div>
                )}
                <label className="mt-2 block text-xs font-medium text-[var(--ui-special-ink)]">性格特质内容<textarea value={personalityTraitContent} onChange={(event) => setPersonalityTraitContent(event.target.value)} rows={3} placeholder="描述这个特质会怎样影响TA的行为、情绪反应和相处方式" className="mt-1 w-full resize-y rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm leading-relaxed" /></label>
              </div>
              {existingContacts.length > 0 && (
                <div className="rounded-xl border border-[var(--ui-special-border)] bg-white p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div><p className="text-xs font-medium text-[var(--ui-special-ink)]">与其他角色的关系</p><p className="mt-0.5 text-[10px] text-gray-400">从已有角色中选择，关系名称可自定义</p></div>
                    <button type="button" onClick={addRelationRow} disabled={relationRows.length >= existingContacts.length} className="shrink-0 text-xs text-[var(--ui-special-ink)] disabled:opacity-40">+ 添加关系</button>
                  </div>
                  <div className="mt-2 space-y-2">
                    {relationRows.map((row) => <div key={row.key} className="flex items-center gap-2"><select value={row.targetContactId} onChange={(event) => updateRelationRow(row.key, { targetContactId: event.target.value })} className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-2 text-xs">{existingContacts.map((contact) => <option key={contact.id} value={contact.id} disabled={relationRows.some((other) => other.key !== row.key && other.targetContactId === contact.id)}>{displayName(contact)}</option>)}</select><input value={row.label} onChange={(event) => updateRelationRow(row.key, { label: event.target.value })} placeholder="自定义关系" className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-2 text-xs"/><button type="button" onClick={() => removeRelationRow(row.key)} className="shrink-0 text-xs text-gray-400">删除</button></div>)}
                    {relationRows.length === 0 && <p className="text-[11px] text-gray-400">暂未设置与其他角色的关系</p>}
                  </div>
                </div>
              )}
              <label className="block text-xs font-medium text-[var(--ui-special-ink)]">其他角色设定（可选）</label>
              <textarea value={nuwaPersonaSetting} onChange={(event) => setNuwaPersonaSetting(event.target.value)} rows={6} placeholder="补充经历、边界、习惯、生活细节、说话方式、关系表现等……" className="w-full resize-y rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm leading-relaxed" />
            </div>
          </section>
        )}

        {isNuwaMode && personaDraft && (
          <section className="mt-4 rounded-xl border border-[var(--ui-special-border)] bg-[var(--ui-special-soft)] p-3" data-testid="nuwa-persona-draft">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div><h3 className="text-sm font-medium text-[var(--ui-special-ink)]">AI人设初稿</h3><p className="mt-0.5 text-[11px] text-[var(--ui-special-ink)]">直接检查和修改完整人设，确认后将用于创建联系人。</p></div>
              <button type="button" onClick={() => setPersonaDraft(null)} className="text-xs text-[var(--ui-special-ink)] underline">重新生成</button>
            </div>
            <div className="mb-3 space-y-3">
              <label className="block text-xs font-medium text-[var(--ui-special-ink)]">MBTI<input value={personaDraft.mbti ?? ''} onChange={(event) => setPersonaDraft((draft) => draft ? { ...draft, mbti: event.target.value } : draft)} placeholder="例如 INFP" className="mt-1 w-full rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm" /></label>
              <label className="block text-xs font-medium text-[var(--ui-special-ink)]">头像关键词<input value={personaDraft.avatarKeyword ?? ''} onChange={(event) => setPersonaDraft((draft) => draft ? { ...draft, avatarKeyword: event.target.value } : draft)} placeholder="用于头像搜索的英文关键词" className="mt-1 w-full rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm" /></label>
            </div>
            {relEnabled && <div className="mb-3 rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2"><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-medium text-[var(--ui-special-ink)]">好感度</p><p className="mt-0.5 text-[10px] text-[var(--ui-special-ink)]">AI已根据完整人设生成，你可以在创建前修改</p></div><input aria-label="女娲好感度数值" type="number" min="-100" max="100" value={personaDraft.initialWarmth ?? 0} onChange={(event) => setPersonaDraft((draft) => draft ? { ...draft, initialWarmth: Math.max(-100, Math.min(100, Number(event.target.value) || 0)) } : draft)} className="w-20 rounded-lg border border-[var(--ui-special-border)] px-2 py-1.5 text-center text-sm font-semibold text-[var(--ui-special-ink)]" /></div><input aria-label="女娲好感度" type="range" min="-100" max="100" value={personaDraft.initialWarmth ?? 0} onChange={(event) => setPersonaDraft((draft) => draft ? { ...draft, initialWarmth: Number(event.target.value) } : draft)} className="mt-2 w-full accent-[var(--ui-special)]" /></div>}
            <label className="block text-xs font-medium text-[var(--ui-special-ink)]">完整人设</label>
            <textarea value={personaDraft.persona} onChange={(e) => setPersonaDraft((draft) => draft ? { ...draft, persona: e.target.value } : draft)} rows={8} className="mt-1 w-full resize-y rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm leading-relaxed" />
            <label className="mt-3 block text-xs font-medium text-[var(--ui-special-ink)]">标准长相（用于保持生图一致性）</label>
            <textarea value={personaDraft.visualIdentity ?? ''} onChange={(e) => setPersonaDraft((draft) => draft ? { ...draft, visualIdentity: e.target.value } : draft)} rows={4} placeholder="稳定外貌描述，不包含衣服、动作、背景或画风" className="mt-1 w-full resize-y rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm leading-relaxed" />
            <label className="mt-3 block text-xs font-medium text-[var(--ui-special-ink)]">过去的经历（每行一条）</label>
            {(personaDraft.pastExperiences ?? []).length > 0 && <div className="mt-2 space-y-2">{(personaDraft.pastExperiences ?? []).map((experience, index) => <article key={`${experience.title}:${index}`} className="rounded-[var(--ui-radius-card)] border border-[var(--ui-special-border)] bg-[var(--ui-surface-2)] px-3 py-2"><div className="flex items-start justify-between gap-2"><p className="text-sm font-medium text-[var(--ui-text)]">{experience.title || '过去的经历'}</p><span className="shrink-0 text-[10px] text-[var(--ui-special-ink)]">长期记忆 · {experience.importance}</span></div><p className="mt-1 text-xs leading-relaxed text-[var(--ui-text-2)]">{experience.summary}</p><p className="mt-1 text-[10px] text-[var(--ui-text-3)]">{[experience.period, experience.relatedContactNames.length ? `参与者：${experience.relatedContactNames.join('、')}` : '', selectedWorldbookEntryIds.length || pendingCardWorldbook ? '含世界书正史来源' : 'AI/用户设定'].filter(Boolean).join(' · ')}</p></article>)}</div>}
            <textarea value={(personaDraft.pastExperiences ?? []).map((item) => [item.period, item.title, item.summary].filter(Boolean).join('｜')).join('\n')} onChange={(event) => setPersonaDraft((draft) => draft ? { ...draft, pastExperiences: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 10).map((line) => { const [period = '', title = '过去的经历', ...summary] = line.split('｜'); return { period, title, summary: summary.join('｜') || title, relatedContactNames: [], importance: 75 } }) } : draft)} rows={5} placeholder="时期｜标题｜具体发生过什么以及带来的影响" className="mt-1 w-full resize-y rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm leading-relaxed" />
            <label className="mt-3 block text-xs font-medium text-[var(--ui-special-ink)]">说话样例（每行一条）</label>
            <textarea value={(personaDraft.speechSamples ?? []).join('\n')} onChange={(e) => setPersonaDraft((draft) => draft ? { ...draft, speechSamples: e.target.value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 8) } : draft)} rows={5} className="mt-1 w-full resize-y rounded-lg border border-[var(--ui-special-border)] bg-white px-3 py-2 text-sm leading-relaxed" />
          </section>
        )}

        {!isNuwaMode && error && <p className="mt-3 text-xs text-red-500">{error}</p>}
      </div>

      <div className="sticky bottom-0 border-t border-gray-100 bg-white p-3">
        <button
          onClick={() => void handleGenerate(undefined, personaDraft ?? undefined)}
          disabled={generating}
          className="w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-40"
        >
          {generating ? '正在提交任务…' : personaDraft ? '确认修改并创建' : isNuwaMode ? '生成AI初稿' : '开始寻找'}
        </button>
      </div>

      {creationPickerOpen && <div className="absolute inset-0 z-40 flex items-center bg-black/30 p-4"><div className="max-h-[82%] w-full overflow-y-auto rounded-2xl bg-white p-4"><div className="mb-3 flex items-center justify-between"><div><h2 className="font-medium text-gray-900">以前创建过的人设</h2><p className="mt-1 text-[11px] text-gray-400">不会自动删除，但你可以手动移除不需要的记录</p></div><button type="button" onClick={() => setCreationPickerOpen(false)} className="text-sm text-gray-500">关闭</button></div><div className="space-y-2">{creationRecords.map((record) => <div key={record.id} className="flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2"><button type="button" onClick={() => applyCreationRecord(record)} className="min-w-0 flex-1 py-1 text-left"><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium text-gray-900">{record.nickname || record.name}</span><span className="shrink-0 text-[10px] text-gray-400">{new Date(record.createdAt).toLocaleString()}</span></div><p className="mt-1 line-clamp-2 text-xs text-gray-500">{record.personaSetting || record.persona}</p></button><button type="button" onClick={() => void deleteCreationRecord(record)} className="shrink-0 rounded-lg px-2 py-2 text-xs text-red-500">删除</button></div>)}{creationRecords.length === 0 && <p className="py-8 text-center text-sm text-gray-400">还没有创建记录</p>}</div></div></div>}

      {personaPickerOpen && <div className="absolute inset-0 z-30 flex items-center bg-black/30 p-4"><div className="w-full rounded-2xl bg-white p-4"><div className="mb-3 flex items-center justify-between"><h2 className="font-medium">已保存的人设</h2><button type="button" onClick={() => setPersonaPickerOpen(false)} className="text-sm text-gray-500">关闭</button></div><div className="space-y-2">{savedPersonas.slice(personaPage * 5, personaPage * 5 + 5).map((saved, index) => <div key={saved.id} className="flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2"><button type="button" onClick={() => applySavedPersona(saved)} className="min-w-0 flex-1 py-1 text-left"><span className="block truncate text-sm text-gray-900">{saved.nickname || saved.realName || `未命名人设${personaPage * 5 + index + 1}`}</span><span className="mt-0.5 block text-[11px] text-gray-400">点击使用</span></button><button type="button" onClick={() => void deleteSavedPersona(saved)} className="rounded-lg px-2 py-2 text-xs text-red-500" aria-label={`删除${saved.nickname || saved.realName || '未命名人设'}`}>删除</button></div>)}{savedPersonas.length === 0 && <p className="py-6 text-center text-sm text-gray-400">还没有保存的人设</p>}</div><div className="mt-4 flex items-center justify-between"><button type="button" disabled={personaPage === 0} onClick={() => setPersonaPage((page) => page - 1)} className="text-sm text-gray-600 disabled:text-gray-300">上一页</button><span className="text-xs text-gray-400">{personaPage + 1} / {Math.max(1, Math.ceil(savedPersonas.length / 5))}</span><button type="button" disabled={(personaPage + 1) * 5 >= savedPersonas.length} onClick={() => setPersonaPage((page) => page + 1)} className="text-sm text-gray-600 disabled:text-gray-300">下一页</button></div></div></div>}
      {pickingAvatar && (
        <AvatarPicker
          onSelect={(a) => {
            setAvatar(a)
            setAvatarManuallySet(true)
          }}
          onClose={() => setPickingAvatar(false)}
        />
      )}
      <WorldbookEntrySelector open={worldbookSelectorOpen} selectedIds={selectedWorldbookEntryIds} onChange={setSelectedWorldbookEntryIds} onClose={() => setWorldbookSelectorOpen(false)}/>
    </div>
  )
}
