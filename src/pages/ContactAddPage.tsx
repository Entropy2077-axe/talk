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
import { rememberInitialContactRelation } from '../lib/memory'
import { displayName } from '../lib/contact'
import { pickAvatarCategory } from '../lib/avatarCategory'
import { randomAnimeAvatar, searchPexelsPhoto } from '../lib/photoSearch'
import { CONTACT_RELATION_LABELS, HOBBY_TAG_OPTIONS, PERSONALITY_TRAIT_OPTIONS, type ContactRelationLabel } from '../types'
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
  const [relationship, setRelationship] = useState('')
  const [personalityTrait, setPersonalityTrait] = useState('')
  const [hobbies, setHobbies] = useState<string[]>([])
  const [extra, setExtra] = useState('')
  const [avatar, setAvatar] = useState(AVATAR_EMOJIS[Math.floor(Math.random() * AVATAR_EMOJIS.length)])
  const [avatarManuallySet, setAvatarManuallySet] = useState(false)
  const [pickingAvatar, setPickingAvatar] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [progressStep, setProgressStep] = useState<'persona' | 'avatar' | 'saving' | null>(null)
  const [error, setError] = useState('')
  const [relationRows, setRelationRows] = useState<RelationRow[]>([])

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

  async function handleGenerate() {
    if (!settings.apiKey) {
      setError('还没有配置API Key 请先去"我-设置"里填写')
      return
    }
    setGenerating(true)
    setError('')
    setProgressStep('persona')
    try {
      const avatarCategory = pickAvatarCategory(tags)
      const raw = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        messages: [
          {
            role: 'system',
            content: buildPersonaGenerationPrompt(
              {
                personalityTags: tags,
                ageRange,
                gender,
                relationship,
                personalityTrait,
                hobbies,
                extra,
              },
              avatarCategory,
            ),
          },
          { role: 'user', content: '请生成' },
        ],
        jsonMode: true,
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
      await db.contacts.add({
        id,
        name: parsed.name,
        avatar: finalAvatar,
        avatarColor: randomAvatarColor(),
        avatarPhotographer,
        avatarPhotographerUrl,
        systemPrompt: parsed.persona,
        speechSamples: parsed.speechSamples,
        createdAt: now,
        memoryFacts: '',
        memoryStyle: '',
        memoryUpdatedAt: 0,
        memoryMessageCursor: 0,
        ...(relEnabled
          ? { warmth: initialWarmthForBase(relationship || '朋友', personalityTrait) }
          : {}),
        relationshipBase: relationship || '朋友',
        relationshipDynamic: '',
        personalityTrait: personalityTrait || '无',
        schedule: parsed.schedule,
        scheduleOverrides: [],
        mbti: parsed.mbti || undefined,
      })
      await db.conversations.add({
        id: uuid(),
        contactId: id,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      })
      for (const row of relationRows) {
        await db.contactRelations.add({
          id: uuid(),
          fromContactId: id,
          toContactId: row.targetContactId,
          label: row.label,
          createdAt: now,
        })
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

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="添加联系人" showBack />

      <div className="mt-3 flex-1 overflow-y-auto bg-white px-4 py-4">
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

        <label className="mb-2 block text-xs font-medium text-gray-400">性格倾向（可多选，也可以自己填）</label>
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
        </div>

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
                  <select
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
                  </select>
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
          onClick={handleGenerate}
          disabled={generating}
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
