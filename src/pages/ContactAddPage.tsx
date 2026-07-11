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
import { customTraitsValidationError, hasOverlappingCustomTraitRules } from '../lib/contactCreator'
import { CONTACT_RELATION_LABELS, HOBBY_TAG_OPTIONS, PERSONALITY_TRAIT_OPTIONS, type ContactRelationLabel, type CustomPersonalityTrait } from '../types'
import {
  AGE_RANGE_OPTIONS,
  GENDER_OPTIONS,
  PERSONALITY_TAG_OPTIONS,
  RELATIONSHIP_OPTIONS,
  buildPersonaGenerationPrompt,
  parsePersonaGeneration,
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

export function ContactAddPage() {
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const existingContacts = useLiveQuery(() => db.contacts.toArray(), []) ?? []

  const [tags, setTags] = useState<string[]>([])
  const [customTag, setCustomTag] = useState('')
  const [ageRange, setAgeRange] = useState('')
  const [gender, setGender] = useState('')
  const personalityEnabled = useModuleEnabled('personalityTraits')
  const relEnabled = useModuleEnabled('relationship')
  const nuwaEnabled = useModuleEnabled('nuwaMode')
  const [relationship, setRelationship] = useState('')
  const [personalityTrait, setPersonalityTrait] = useState('')
  const [hobbies, setHobbies] = useState<string[]>([])
  const [extra, setExtra] = useState('')
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

  async function handleGenerate(overrides?: { tags: string[]; ageRange: string; gender: string; relationship: string; personalityTrait: string; hobbies: string[]; occupation: string; relationRows: RelationRow[] }) {
    if (!settings.apiKey) {
      setError('还没有配置API Key 请先去"我-设置"里填写')
      return
    }
    if (nuwaEnabled) {
      const traitError = customTraitsValidationError(customTraits)
      if (traitError) { setError(traitError); return }
      if (relationRows.some((row) => !row.targetContactId || !row.label.trim())) { setError('联系人关系不能留空'); return }
    }
    setGenerating(true)
    setError('')
    setProgressStep('persona')
    try {
      const values = overrides ?? { tags: nuwaEnabled ? customTendencies.split(/[、,，]+/).map((x) => x.trim()).filter(Boolean) : tags, ageRange: nuwaEnabled ? customAge : ageRange, gender: nuwaEnabled ? customGender : gender, relationship: nuwaEnabled ? customRelationship : relationship, personalityTrait, hobbies: nuwaEnabled ? customHobbies.split(/[、,，]+/).map((x) => x.trim()).filter(Boolean) : hobbies, occupation: nuwaEnabled ? customOccupation.trim() : (occupation === '自定义' ? customOccupation.trim() : occupation), relationRows }
      const avatarCategory = pickAvatarCategory(values.tags)
      const worldbookText = await retrieveWorldbookContext([values.tags.join(' '), values.ageRange, values.gender, values.relationship, values.personalityTrait, values.hobbies.join(' '), values.occupation, extra].join('\n'), { maxEntries: 8, maxChars: 6500 })
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
                extra: [extra, worldbookText ? `【创建时必须遵守的世界书】\n${worldbookText}` : ''].filter(Boolean).join('\n\n'),
                occupation: values.occupation,
              },
              avatarCategory,
            ),
          },
          { role: 'user', content: '请生成' },
        ],
        jsonMode: true,
        purpose: 'persona',
      })
      const parsed = parsePersonaGeneration(raw)
      if (!parsed) throw new Error('生成结果解析失败 请重试一次')

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
        avatar: finalAvatar,
        avatarColor: randomAvatarColor(),
        avatarPhotographer,
        avatarPhotographerUrl,
        systemPrompt: parsed.persona,
        personaConstraints: extra.trim() || undefined,
        creatorProfile: { personalityTendencies: values.tags, age: values.ageRange, gender: values.gender, relationship: values.relationship, occupation: values.occupation, hobbies: values.hobbies, notes: extra.trim() },
        customPersonalityTraits: nuwaEnabled ? customTraits : undefined,
        personaProfile: parsed.personaProfile,
        speechSamples: parsed.speechSamples,
        createdAt: now,
        memoryFacts: '',
        memoryStyle: '',
        memoryUpdatedAt: 0,
        memoryMessageCursor: 0,
        ...(relEnabled
          ? { warmth: initialWarmthForBase(values.relationship || '朋友', values.personalityTrait) }
          : {}),
        relationshipBase: values.relationship || '朋友',
        relationshipDynamic: '',
        personalityTrait: nuwaEnabled ? '无' : (values.personalityTrait || '无'),
        schedule: parsed.schedule,
        scheduleOverrides: [],
        mbti: parsed.mbti || undefined,
        ...(careerEnabled && chosenOccupation ? employmentPatch(chosenOccupation, parsed.monthlySalary ?? 6000) : {}),
      })
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
      navigate('/contacts')
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
        {!nuwaEnabled && <button type="button" onClick={completelyRandom} disabled={generating} className="mb-4 w-full rounded-xl bg-gradient-to-r from-purple-600 to-pink-500 py-3 text-sm font-medium text-white disabled:opacity-50">🎲 完全随机创建</button>}
        {nuwaEnabled && <p className="mb-4 text-xs text-purple-600">女娲模式已开启：以下角色属性全部自由填写，并作为不可改写的人设约束。</p>}
        <p className="mb-4 text-xs text-gray-400">
          描述一下你想认识的这个人 名字会由对方自己来定 确认添加后就正式加上了 之后不能再改TA的性格设定
        </p>

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

        {!nuwaEnabled && <><label className="mb-2 block text-xs font-medium text-gray-400">性格倾向（可多选，也可以自己填）</label>
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

        {nuwaEnabled && <div className="mb-4 space-y-3"><div><label className="mb-1 block text-xs font-medium text-gray-400">性格倾向</label><input value={customTendencies} onChange={(e) => setCustomTendencies(e.target.value)} placeholder="例如：慢热、敏感、有主见（顿号分隔）" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"/></div><div className="grid grid-cols-2 gap-2"><div><label className="mb-1 block text-xs text-gray-400">年龄</label><input value={customAge} onChange={(e) => setCustomAge(e.target.value)} placeholder="例如：24岁" className="w-full rounded-lg border px-3 py-2 text-sm"/></div><div><label className="mb-1 block text-xs text-gray-400">性别</label><input value={customGender} onChange={(e) => setCustomGender(e.target.value)} placeholder="自由填写" className="w-full rounded-lg border px-3 py-2 text-sm"/></div></div><div><label className="mb-1 block text-xs text-gray-400">关系定位</label><input value={customRelationship} onChange={(e) => setCustomRelationship(e.target.value)} placeholder="与用户是什么关系" className="w-full rounded-lg border px-3 py-2 text-sm"/></div>{careerEnabled && <div><label className="mb-1 block text-xs text-gray-400">职业</label><input value={customOccupation} onChange={(e) => setCustomOccupation(e.target.value)} placeholder="自由填写职业" className="w-full rounded-lg border px-3 py-2 text-sm"/></div>}<div><label className="mb-1 block text-xs text-gray-400">兴趣爱好</label><input value={customHobbies} onChange={(e) => setCustomHobbies(e.target.value)} placeholder="多个兴趣用顿号分隔" className="w-full rounded-lg border px-3 py-2 text-sm"/></div></div>}

        {nuwaEnabled && <section className="mb-4"><div className="mb-2 flex items-center justify-between"><label className="text-xs font-medium text-gray-500">自定义性格特质</label><button type="button" onClick={addCustomTrait} className="text-xs text-purple-600">+ 添加特质</button></div><div className="space-y-3">{customTraits.map((trait, traitIndex) => <div key={trait.id} className="rounded-xl border border-gray-200 p-3"><div className="mb-2 flex items-center justify-end gap-2 text-xs"><button onClick={() => moveCustomTrait(traitIndex, -1)} disabled={traitIndex === 0}>↑</button><button onClick={() => moveCustomTrait(traitIndex, 1)} disabled={traitIndex === customTraits.length - 1}>↓</button><button onClick={() => setCustomTraits((x) => x.filter((t) => t.id !== trait.id))} className="text-red-500">删除特质</button></div><div className="flex gap-2"><input value={trait.name} onChange={(e) => updateCustomTrait(trait.id, { name: e.target.value })} placeholder="特质名称" className="w-1/3 rounded-lg border px-2 py-1.5 text-sm"/><input value={trait.meaning} onChange={(e) => updateCustomTrait(trait.id, { meaning: e.target.value })} placeholder="特质含义" className="flex-1 rounded-lg border px-2 py-1.5 text-sm"/></div>{trait.rules.map((rule) => <div key={rule.id} className="mt-2 rounded-lg bg-gray-50 p-2"><div className="grid grid-cols-4 gap-1"><input type="number" value={rule.minWarmth} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, minWarmth: Number(e.target.value) } : r) })} title="最低好感" className="rounded border px-1 py-1 text-xs"/><input type="number" value={rule.maxWarmth} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, maxWarmth: Number(e.target.value) } : r) })} title="最高好感" className="rounded border px-1 py-1 text-xs"/><input type="number" min="0" max="10" step="0.1" value={rule.positiveMultiplier} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, positiveMultiplier: Number(e.target.value) } : r) })} title="上升倍率" className="rounded border px-1 py-1 text-xs"/><input type="number" min="0" max="10" step="0.1" value={rule.negativeMultiplier} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, negativeMultiplier: Number(e.target.value) } : r) })} title="下降倍率" className="rounded border px-1 py-1 text-xs"/></div><div className="mt-1 flex gap-1"><input value={rule.prompt} onChange={(e) => updateCustomTrait(trait.id, { rules: trait.rules.map((r) => r.id === rule.id ? { ...r, prompt: e.target.value } : r) })} placeholder="命中区间时给予的提示词" className="flex-1 rounded border px-2 py-1 text-xs"/><button onClick={() => updateCustomTrait(trait.id, { rules: trait.rules.filter((r) => r.id !== rule.id) })} className="text-xs text-red-500">删规则</button></div></div>)}<button type="button" onClick={() => updateCustomTrait(trait.id, { rules: [...trait.rules, { id: uuid(), minWarmth: -100, maxWarmth: 100, positiveMultiplier: 1, negativeMultiplier: 1, prompt: '' }] })} className="mt-2 text-xs text-purple-600">+ 添加区间规则</button><span className="ml-2 text-[10px] text-gray-400">优先级 {traitIndex + 1}</span></div>)}</div></section>}

        {nuwaEnabled && customTraits.some(hasOverlappingCustomTraitRules) && <p className="-mt-3 mb-4 text-xs text-amber-600">存在重叠区间；命中时倍率会相乘、提示词会合并。</p>}

        {existingContacts.length > 0 && (
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
                  {nuwaEnabled ? <input value={row.label} onChange={(e) => updateRelationRow(row.key, { label: e.target.value })} placeholder="自定义关系" className="flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-xs"/> : <select
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

        <label className="mb-2 block text-xs font-medium text-gray-400">补充说明（可选）</label>
        <textarea
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="比如职业、爱好、说话口头禅、你们认识的契机…"
          rows={4}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />

        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
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
          onClick={() => void handleGenerate()}
          disabled={generating || (careerEnabled && (nuwaEnabled ? !customOccupation.trim() : (!occupation || (occupation === '自定义' && !customOccupation.trim()))))}
          className="w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-40"
        >
          {generating ? '正在添加…' : '确认添加'}
        </button>
      </div>

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
