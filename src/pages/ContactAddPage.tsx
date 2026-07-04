import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { AvatarPicker } from '../components/AvatarPicker'
import { useSettingsStore } from '../store/useSettingsStore'
import { chatCompletion } from '../lib/deepseek'
import { randomAvatarColor } from '../lib/colors'
import { AVATAR_EMOJIS } from '../lib/avatarEmojis'
import { pickRandomTrait } from '../lib/randomTraits'
import { initialRelationshipFor } from '../lib/relationship'
import { resolveOrCreateLocation } from '../lib/locations'
import { resolveExpectedLocation } from '../lib/schedule'
import type { ScheduleBlock } from '../types'
import {
  AGE_RANGE_OPTIONS,
  GENDER_OPTIONS,
  PERSONALITY_TAG_OPTIONS,
  RELATIONSHIP_OPTIONS,
  buildPersonaGenerationPrompt,
  parsePersonaGeneration,
} from '../lib/prompt'

export function ContactAddPage() {
  const navigate = useNavigate()
  const settings = useSettingsStore()

  const [tags, setTags] = useState<string[]>([])
  const [customTag, setCustomTag] = useState('')
  const [ageRange, setAgeRange] = useState('')
  const [gender, setGender] = useState('')
  const [relationship, setRelationship] = useState('')
  const [extra, setExtra] = useState('')
  const [avatar, setAvatar] = useState(AVATAR_EMOJIS[Math.floor(Math.random() * AVATAR_EMOJIS.length)])
  const [pickingAvatar, setPickingAvatar] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')

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
    try {
      const raw = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        messages: [
          {
            role: 'system',
            content: buildPersonaGenerationPrompt({
              personalityTags: tags,
              ageRange,
              gender,
              relationship,
              extra,
            }),
          },
          { role: 'user', content: '请生成' },
        ],
      })
      const parsed = parsePersonaGeneration(raw)
      if (!parsed) throw new Error('生成结果解析失败 请重试一次')

      // Resolve each generated block's location name to an id sequentially
      // (not in parallel) so repeated names (e.g. "家里" appearing twice)
      // resolve to the same location instead of racing to create duplicates.
      const nameToId = new Map<string, string>()
      const dailySchedule: ScheduleBlock[] = []
      for (const block of parsed.dailySchedule) {
        let locationId = nameToId.get(block.locationName)
        if (!locationId) {
          locationId = await resolveOrCreateLocation(block.locationName)
          nameToId.set(block.locationName, locationId)
        }
        dailySchedule.push({
          id: uuid(),
          dayType: block.dayType,
          startTime: block.startTime,
          endTime: block.endTime,
          locationId,
          label: block.label,
        })
      }
      const expected = resolveExpectedLocation(dailySchedule, [], new Date())
      const currentLocationId = expected?.locationId ?? dailySchedule[0]?.locationId ?? ''

      const id = uuid()
      const now = Date.now()
      await db.contacts.add({
        id,
        name: parsed.name,
        avatar,
        avatarColor: randomAvatarColor(),
        systemPrompt: parsed.persona,
        createdAt: now,
        memoryFacts: '',
        memoryStyle: '',
        memoryUpdatedAt: 0,
        memoryMessageCursor: 0,
        relationship: initialRelationshipFor(relationship),
        dailySchedule,
        currentLocationId,
      })
      await db.conversations.add({
        id: uuid(),
        contactId: id,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      })
      navigate('/contacts')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="添加联系人" showBack />

      <div className="mt-3 flex-1 overflow-y-auto bg-white px-4 py-4">
        <p className="mb-4 text-xs text-gray-400">
          描述一下你想认识的这个人 名字会由对方自己来定 确认添加后就正式加上了 之后不能再改TA的性格设定
        </p>

        <label className="mb-1 block text-xs text-gray-400">头像</label>
        <button
          onClick={() => setPickingAvatar(true)}
          className="mb-4 flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2"
        >
          <Avatar avatar={avatar} size={44} />
          <span className="text-sm text-gray-500">点击选择</span>
        </button>

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
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="w-full rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-40"
        >
          {generating ? '正在添加…' : '确认添加'}
        </button>
      </div>

      {pickingAvatar && <AvatarPicker onSelect={setAvatar} onClose={() => setPickingAvatar(false)} />}
    </div>
  )
}
