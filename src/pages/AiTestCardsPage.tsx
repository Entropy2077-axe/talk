/** @ui standard */
import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { useSettingsStore } from '../store/useSettingsStore'
import { cleanupResidualAiTestData } from '../lib/aiTestCards'
import {
  AI_TEST_KINDS,
  createAiTestSuite,
  markInterruptedAiTests,
  startAiTestSuite,
  stopAiTestSuite,
  updateAiTestReview,
} from '../lib/aiTestManager'
import type { AiTestCardRecord, AiTestKind, AiTestSuiteRecord, AppSettings, Contact } from '../types'

function AiTestReviewEditor({ suiteId, card, compact = false }: { suiteId: string; card: AiTestCardRecord; compact?: boolean }) {
  const [comment, setComment] = useState(card.comment ?? '')
  const [rating, setRating] = useState(card.rating)

  function save(nextRating = rating, nextComment = comment) {
    void updateAiTestReview(suiteId, card.id, { rating: nextRating, comment: nextComment })
  }

  function rate(nextRating: AiTestCardRecord['rating']) {
    setRating(nextRating)
    save(nextRating)
  }

  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      <div className="flex gap-2">
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => rate('up')} className={`rounded-lg px-4 py-2 text-sm ${rating === 'up' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'}`}>{compact ? '系统理解正确' : '👍'}</button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => rate('down')} className={`rounded-lg px-4 py-2 text-sm ${rating === 'down' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'}`}>{compact ? '系统理解错误' : '👎'}</button>
      </div>
      {!compact && <textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        onBlur={() => save()}
        rows={2}
        placeholder="人工评论"
        className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
      />}
    </div>
  )
}

const PRIVATE_SCENARIOS = ['日常关系与语气', '涉及金钱的连续对话', '日程冲突与改约', '长对话人设一致性', '记忆与世界书召回']
const STATUS_LABEL: Record<AiTestSuiteRecord['status'], string> = {
  draft: '待运行', running: '后台运行中', completed: '已完成', interrupted: '已中断', cancelled: '已停止', failed: '运行失败',
}

function formatTestTime(value: number | undefined) {
  return value ? new Date(value).toLocaleString() : '未知时间'
}

function actionDecision(card: AiTestCardRecord) {
  const committee = card.diagnostics?.actionCommittee
  if (!committee || typeof committee !== 'object') return undefined
  const value = committee as { approved?: unknown; reason?: unknown }
  return {
    approved: value.approved === true,
    reason: typeof value.reason === 'string' ? value.reason : '没有保存判断原因',
  }
}

function exportSuite(suite: AiTestSuiteRecord) {
  const json = (value: unknown) => JSON.stringify(value ?? null, null, 2)
  const fenced = (value: unknown, language = '') => ['````' + language, typeof value === 'string' ? value : json(value), '````'].join('\n')
  const lines = [
    `# ${suite.title}`,
    '',
    `- 类型：${AI_TEST_KINDS.find((item) => item.id === suite.kind)?.label}`,
    `- 方式：${suite.executionMode === 'sequential' ? '连续顺序测试' : '独立功能测试'}`,
    `- 状态：${STATUS_LABEL[suite.status]}`,
    `- 测试主题：${suite.scenarioLabel}`,
    `- 目标：${suite.targetLabel}`,
    `- 创建时间：${new Date(suite.createdAt).toLocaleString()}`,
    '',
    '## 被测联系人 / 群聊完整快照',
    '',
    fenced(suite.targetSnapshot, 'json'),
    '',
    '## 测试时设置与提示词模块快照（凭据已移除）',
    '',
    fenced(suite.settingsSnapshot, 'json'),
    '',
    '## 测试环境地点目录',
    '',
    fenced(suite.environmentSnapshot?.locations ?? [], 'json'),
    '',
  ]
  for (const card of suite.cards) {
    const locationResult = card.diagnostics?.locationSchedule
    const decision = actionDecision(card)
    const currentChange = locationResult?.currentLocationChange
    lines.push(
      `# 用例 ${card.order + 1}`,
      '',
      `测试意图：${card.description}`,
      `用户输入：${card.userMessage}`,
      '',
      'AI 回复：',
      '',
      card.reply || `（${card.error || '尚未运行'}）`,
      '',
      `人工判断：${card.rating === 'up' ? '系统理解正确' : card.rating === 'down' ? '系统理解错误' : '未判断'}`,
      ...(suite.kind === 'locationSchedule' ? [] : [`评论：${card.comment || '无'}`]),
      `世界书：${card.context?.worldbookEntries.join('、') || '无'}`,
      `记忆摘要：${card.context?.memorySummary || '无'}`,
      '',
      ...(locationResult ? [
        '## 系统处理摘要', '',
        `系统决定：${decision ? decision.approved ? '创建特殊日程' : '不创建特殊日程' : '未保存'}`,
        `判断原因：${decision?.reason ?? '未保存'}`,
        `当前位置：${currentChange?.beforeName ?? currentChange?.beforeId ?? '未知'} → ${currentChange?.afterName ?? currentChange?.afterId ?? '未知'}`,
        ...(locationResult.addedScheduleOverrides.length
          ? locationResult.addedScheduleOverrides.flatMap((task) => [
            `新增任务：${task.summary}`,
            `时间：${formatTestTime(task.startsAt)} → ${formatTestTime(task.endsAt)}`,
            `活动：${task.activity}`,
            `地点：${task.location}（${task.locationId ?? '无地点ID'}）`,
            `覆盖的默认任务ID：${task.cancelledDefaultTaskIds?.join('、') || '无'}`,
          ])
          : ['新增任务：无']),
        ...(locationResult.scheduledTaskLocationChecks ?? []).flatMap((check) => [
          `任务开始时地点模拟：${check.resolvedLocationName ?? check.resolvedLocationId ?? '未知'}；预期：${check.expectedLocationName ?? check.expectedLocationId ?? '未知'}；${check.matches ? '一致' : '不一致'}`,
        ]),
        '',
      ] : []),
      '## 实际主提示词', '', fenced(card.diagnostics?.mainPrompt || '（未保存）'), '',
      '## JSON 转换提示词', '', fenced(card.diagnostics?.conversionPrompt || '（未保存）'), '',
      '## 完整提示词分段', '', fenced(card.diagnostics?.promptSections ?? [], 'json'), '',
      '## 模型原始输出', '', fenced(card.rawResponse || '（无）', 'json'), '',
      '## 完整解析与内部判断', '', fenced(card.diagnostics?.parsedResponse ?? null, 'json'), '',
      ...(locationResult ? ['## 地点与日程写入诊断', '', fenced(locationResult, 'json'), ''] : []),
    )
  }
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `ai-test-${suite.id}.md`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function AiTestCardsPage() {
  const contacts = useLiveQuery(() => db.contacts.filter((item) => !item.id.startsWith('ai-test-')).sortBy('createdAt'), []) ?? []
  const groups = useLiveQuery(() => db.groups.filter((item) => !item.id.startsWith('ai-test-')).sortBy('createdAt'), []) ?? []
  const suites = useLiveQuery(() => db.aiTestSuites.orderBy('createdAt').reverse().toArray(), []) ?? []
  const settings = useSettingsStore()
  const [kind, setKind] = useState<AiTestKind>('conversation')
  const [contactId, setContactId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [scenario, setScenario] = useState(PRIVATE_SCENARIOS[0])
  const [count, setCount] = useState(20)
  const [creating, setCreating] = useState(false)
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const definition = AI_TEST_KINDS.find((item) => item.id === kind)!
  const selectedContact = contacts.find((item) => item.id === contactId) ?? contacts[0]
  const selectedGroup = groups.find((item) => item.id === groupId) ?? groups[0]
  const selectedSuite = suites.find((item) => item.id === selectedSuiteId) ?? suites[0]

  useEffect(() => { void markInterruptedAiTests() }, [])

  async function handleCreate() {
    if (!settings.apiKey) return setNotice('请先在设置里填写 AI API Key。')
    setCreating(true)
    setNotice('AI 正在生成测试用例…')
    try {
      let members: Contact[] | undefined
      if (kind === 'group' && selectedGroup) members = (await db.contacts.bulkGet(selectedGroup.memberContactIds)).filter((item): item is Contact => !!item && !item.id.startsWith('ai-test-'))
      const suite = await createAiTestSuite({
        kind,
        count,
        scenarioLabel: kind === 'conversation' ? scenario : definition.label,
        contact: kind === 'group' ? undefined : selectedContact,
        group: kind === 'group' ? selectedGroup : undefined,
        groupMembers: members,
        settings: settings as AppSettings,
      })
      setSelectedSuiteId(suite.id)
      setNotice(`已生成 ${suite.cards.length} 条用例。可先编辑，再交给后台运行。`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  async function editCase(suite: AiTestSuiteRecord, cardId: string, userMessage: string) {
    await db.aiTestSuites.update(suite.id, {
      cards: suite.cards.map((card) => card.id === cardId ? { ...card, userMessage } : card),
      updatedAt: Date.now(),
    })
  }

  async function handleCleanup() {
    if (suites.some((suite) => suite.status === 'running')) {
      setNotice('请先停止正在运行的后台测试，再清理测试副本。')
      return
    }
    const result = await cleanupResidualAiTestData()
    setNotice(result.total ? `已清理 ${result.total} 条测试副本数据；已保存的测试报告未删除。` : '没有发现测试副本数据。')
  }

  const completedCount = selectedSuite?.cards.filter((card) => card.status === 'completed').length ?? 0
  const sequential = definition.mode === 'sequential'
  const maxCount = sequential ? 50 : 20
  const selectionValid = kind === 'group' ? Boolean(selectedGroup) : Boolean(selectedContact)
  const allRated = selectedSuite?.cards.every((card) => card.status === 'completed' && card.rating) ?? false

  return (
    <div className="ui-page relative">
      <TopBar title="AI 自动测试" showBack />
      <div className="ui-page-scroll">
        <header className="ui-page-intro"><p className="ui-page-kicker">管理员工具</p><h1 className="ui-page-title">AI 自动测试</h1><p className="ui-page-summary">先创建一套明确的测试任务，再查看运行进度、结果和测试副本。</p></header>
        <section className="ui-section-card px-4 py-4">
          <h2 className="text-sm font-medium text-gray-900">创建测试</h2>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">AI 生成用例并保存完整诊断上下文，最终语义是否正确由管理员判断。</p>

          <label className="mt-4 block text-xs text-gray-500">测试类型</label>
          <select value={kind} onChange={(event) => { const next = event.target.value as AiTestKind; setKind(next); setCount(next === 'conversation' || next === 'group' ? 20 : 5) }} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900">
            {AI_TEST_KINDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>

          {sequential ? (
            <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-3">
              <p className="text-sm font-medium text-gray-900">连续对话轨道</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-500">所有消息按顺序进入同一个副本会话，上一轮回复会成为下一轮上下文。适合观察长线逻辑，不拆成独立用例。</p>
              {kind === 'conversation' && <select value={scenario} onChange={(event) => setScenario(event.target.value)} className="mt-3 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm">{PRIVATE_SCENARIOS.map((item) => <option key={item}>{item}</option>)}</select>}
            </div>
          ) : (
            <div className="mt-3 rounded-xl border border-gray-200 bg-white p-3">
              <p className="text-sm font-medium text-gray-900">独立功能用例</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-500">每条用例使用一个独立联系人副本，不继承其他用例历史，重点展示结构化 JSON 与实际数据变化。</p>
            </div>
          )}

          {kind === 'group' ? (
            <><label className="mt-3 block text-xs text-gray-500">目标群聊</label><select value={selectedGroup?.id ?? ''} onChange={(event) => setGroupId(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm">{groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></>
          ) : (
            <><label className="mt-3 block text-xs text-gray-500">目标联系人</label><select value={selectedContact?.id ?? ''} onChange={(event) => setContactId(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm">{contacts.map((item) => <option key={item.id} value={item.id}>{item.remark || item.name}</option>)}</select></>
          )}

          <label className="mt-3 block text-xs text-gray-500">用例数量（5–{maxCount}）</label>
          <input type="number" min={5} max={maxCount} value={count} onChange={(event) => setCount(Math.max(5, Math.min(maxCount, Number(event.target.value) || 5)))} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm" />
          <button type="button" onClick={() => void handleCreate()} disabled={creating || !selectionValid} className="mt-4 w-full rounded-lg bg-gray-900 py-3 text-sm text-white disabled:opacity-40">{creating ? '正在生成…' : 'AI 生成用例'}</button>
        </section>

        {notice && <p className="mt-3 rounded-lg bg-white px-3 py-2 text-xs leading-relaxed text-gray-500">{notice}</p>}

        <section className="ui-section-card ui-section-spaced px-4 py-4">
          <div className="flex items-center justify-between"><h2 className="text-sm font-medium text-gray-900">测试记录</h2><button type="button" onClick={() => void handleCleanup()} className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">清理所有测试副本</button></div>
          {suites.length > 0 ? <select value={selectedSuite?.id ?? ''} onChange={(event) => setSelectedSuiteId(event.target.value)} className="mt-3 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm">{suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.title} · {STATUS_LABEL[suite.status]}</option>)}</select> : <p className="mt-3 text-xs text-gray-400">还没有保存的测试记录。</p>}
        </section>

        {selectedSuite && <section className="mt-3">
          <div className="rounded-xl bg-white p-4">
            <div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-medium text-gray-900">{selectedSuite.title}</h2><p className="mt-1 text-xs text-gray-500">{selectedSuite.executionMode === 'sequential' ? '连续顺序测试' : '独立功能测试'} · {completedCount}/{selectedSuite.cards.length}</p></div><span className="rounded bg-gray-100 px-2 py-1 text-[10px] text-gray-600">{STATUS_LABEL[selectedSuite.status]}</span></div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {selectedSuite.status === 'running' ? <button type="button" onClick={() => void stopAiTestSuite(selectedSuite)} className="rounded-lg bg-red-50 py-2.5 text-sm text-red-600">停止后台测试</button> : <button type="button" onClick={() => startAiTestSuite(selectedSuite.id)} disabled={selectedSuite.status === 'completed'} className="rounded-lg bg-gray-900 py-2.5 text-sm text-white disabled:opacity-40">{selectedSuite.status === 'draft' ? '开始后台测试' : '继续后台测试'}</button>}
              <button type="button" onClick={() => exportSuite(selectedSuite)} className="rounded-lg bg-gray-100 py-2.5 text-sm text-gray-700">导出 Markdown</button>
            </div>
            {selectedSuite.error && <p className="mt-2 text-xs text-red-600">{selectedSuite.error}</p>}
          </div>

          <div className={`mt-3 ${selectedSuite.executionMode === 'sequential' ? 'border-l-2 border-gray-200 pl-3' : 'grid gap-3'}`}>
            {selectedSuite.cards.map((card, index) => <article key={card.id} className="mb-3 rounded-xl bg-white p-4">
              <div className="flex items-center justify-between"><p className="text-xs font-medium text-gray-400">{selectedSuite.executionMode === 'sequential' ? `第 ${index + 1} 轮` : `独立用例 ${index + 1}`}</p><span className="text-[10px] text-gray-400">{card.status === 'completed' ? '已完成' : card.status === 'running' ? '运行中' : card.status === 'failed' ? '失败' : '待运行'}</span></div>
              <p className="mt-1 text-sm font-medium text-gray-900">{card.description}</p>
              <textarea value={card.userMessage} disabled={selectedSuite.status !== 'draft'} onChange={(event) => void editCase(selectedSuite, card.id, event.target.value)} rows={2} className="mt-3 w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50" />
              {card.reply && <div className="mt-3 rounded-lg bg-gray-50 p-3"><p className="text-[11px] text-gray-400">真实回复</p><p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-gray-900">{card.reply}</p></div>}
              {card.diagnostics?.locationSchedule && <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs leading-relaxed text-gray-600">
                <p className="font-medium text-gray-900">系统处理摘要</p>
                <p className="mt-1">系统决定：{actionDecision(card) ? actionDecision(card)!.approved ? '创建特殊日程' : '不创建特殊日程' : '未保存'}</p>
                <p>判断原因：{actionDecision(card)?.reason ?? '未保存'}</p>
                <p className="mt-1">当前位置：{card.diagnostics.locationSchedule.currentLocationChange?.beforeName ?? card.diagnostics.locationSchedule.currentLocationChange?.beforeId ?? '未知'} → {card.diagnostics.locationSchedule.currentLocationChange?.afterName ?? card.diagnostics.locationSchedule.currentLocationChange?.afterId ?? '未知'}</p>
                {card.diagnostics.locationSchedule.addedScheduleOverrides.length === 0 && <p className="mt-1 text-gray-900">没有新增特殊日程</p>}
                {card.diagnostics.locationSchedule.addedScheduleOverrides.map((item) => <div key={item.id} className="mt-2 rounded-lg bg-white p-2 text-gray-900">
                  <p className="font-medium">{item.summary}</p>
                  <p>{formatTestTime(item.startsAt)} → {formatTestTime(item.endsAt)}</p>
                  <p>{item.activity} · {item.location}（{item.locationId ?? '无地点 ID'}）</p>
                  <p className="text-gray-500">覆盖默认任务：{item.cancelledDefaultTaskIds?.join('、') || '无'}</p>
                </div>)}
                {(card.diagnostics.locationSchedule.scheduledTaskLocationChecks ?? []).map((check) => <p key={check.taskId} className={`mt-2 ${check.matches ? 'text-green-700' : 'text-red-700'}`}>任务开始时地点模拟：{check.resolvedLocationName ?? check.resolvedLocationId ?? '未知'}；预期 {check.expectedLocationName ?? check.expectedLocationId ?? '未知'}；{check.matches ? '一致' : '不一致'}</p>)}
              </div>}
              {card.rawResponse && <details className="mt-2 rounded-lg border border-gray-100 p-3"><summary className="text-xs text-gray-500">查看原始 JSON / 上下文</summary><pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-[11px] text-gray-600">{card.rawResponse}</pre><p className="mt-2 text-xs text-gray-500">世界书：{card.context?.worldbookEntries.join('、') || '无'}<br />记忆：{card.context?.memorySummary || '无'}</p></details>}
              {card.error && <p className="mt-2 text-xs text-red-600">{card.error}</p>}
              {card.status === 'completed' && <AiTestReviewEditor suiteId={selectedSuite.id} card={card} compact={selectedSuite.kind === 'locationSchedule'} />}
            </article>)}
          </div>
          {selectedSuite.status === 'completed' && !allRated && <p className="text-center text-xs text-gray-400">请根据用户消息、角色真实回复和系统操作，判断系统是否理解正确。</p>}
        </section>}
      </div>
    </div>
  )
}
