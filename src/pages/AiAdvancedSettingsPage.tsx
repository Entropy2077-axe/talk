import { useState } from 'react'

import { TopBar } from '../components/TopBar'

import { useSettingsStore } from '../store/useSettingsStore'
import { db } from '../db/db'

import { useLiveQuery } from 'dexie-react-hooks'

import { chooseJevActions } from '../lib/jevActions'

export function AiAdvancedSettingsPage() {

  const { actionDecisionProvider, actionDecisionApiKey, automaticAiDailyCap, setSettings } = useSettingsStore()
  const [jevKeyDraft, setJevKeyDraft] = useState(actionDecisionApiKey ?? '')
  const [jevTestStatus, setJevTestStatus] = useState('')
  const [jevTesting, setJevTesting] = useState(false)
  const usage = useLiveQuery(async () => {
    const now = Date.now(); const today = new Date(now).toDateString()
    const records = await db.aiUsageRecords.toArray()
    return { today: records.filter((r) => new Date(r.createdAt).toDateString() === today), recent: records.filter((r) => now - r.createdAt <= 30 * 24 * 60 * 60 * 1000) }
  }, [])
  async function handleJevTest() {
    setJevTesting(true)
    setJevTestStatus('')
    try {
      const actions = await chooseJevActions({
        apiKey: jevKeyDraft,
        messages: [{ role: 'user', content: '我们下周再讨论换衣服吧。现在没有换装。' }],
        allowed: ['outfit_change'],
      })
      setJevTestStatus(actions.length === 0 ? '连接成功，示例判断正确' : '连接成功，但示例判断异常')
    } catch (error) {
      setJevTestStatus(error instanceof Error ? error.message : 'Jev 连接失败')
    } finally {
      setJevTesting(false)
    }
  }

  return <div className="ui-page"><TopBar title="AI 高级选项" showBack /><div className="ui-page-scroll pb-5"><section className="ui-section-card ui-section-spaced">
    <div className="border-t border-[var(--ui-border-soft)] pt-4">
      <label className="mb-2 block text-sm font-medium text-[var(--ui-text)]">私聊工具判断</label>
      <select
        aria-label="私聊工具判断方式"
        value={actionDecisionProvider ?? 'llm'}
        onChange={(event) => setSettings({ actionDecisionProvider: event.target.value as 'llm' | 'jev' })}
        className="w-full rounded-lg border border-[var(--ui-border)] px-3 py-2 text-sm"
      >
        <option value="llm">现有多功能模型</option>
        <option value="jev">OpenRouter Jev 1.13</option>
      </select>
      <p className="mt-2 text-xs text-[var(--ui-text-3)]">Jev 判断是否执行及执行哪些行动；需要图片描述、金额等参数时仍由多功能模型填写。</p>
      {actionDecisionProvider === 'jev' && <>
        <label className="mt-3 block text-xs text-[var(--ui-text-3)]">OpenRouter API Key
          <input
            aria-label="Jev OpenRouter API Key"
            type="password"
            value={jevKeyDraft}
            onChange={(event) => { setJevKeyDraft(event.target.value); setJevTestStatus('') }}
            onBlur={() => setSettings({ actionDecisionApiKey: jevKeyDraft.trim() })}
            placeholder="sk-or-v1-..."
            autoComplete="off"
            className="mt-1 w-full rounded-lg border border-[var(--ui-border)] px-3 py-2 text-sm"
          />
        </label>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => setSettings({ actionDecisionApiKey: jevKeyDraft.trim() })} className="rounded-lg bg-[var(--ui-action)] px-3 py-2 text-xs text-[var(--ui-on-action)]">保存 Key</button>
          <button type="button" onClick={handleJevTest} disabled={jevTesting || !jevKeyDraft.trim()} className="rounded-lg bg-[var(--ui-surface-2)] px-3 py-2 text-xs text-[var(--ui-text-2)] disabled:opacity-50">{jevTesting ? '测试中…' : '测试 Jev'}</button>
        </div>
        {jevTestStatus && <p className="mt-2 text-xs text-[var(--ui-text-3)]">{jevTestStatus}</p>}
      </>}
    </div>
  </section><section className="ui-section-card ui-section-spaced"><h2 className="mb-2 text-xs font-medium text-[var(--ui-text-3)]">AI 调用预算</h2><p className="mb-2 text-xs text-[var(--ui-text-3)]">后台自动任务达到上限后会跳过；手动聊天和手动生成不会受限。</p>{usage && <><div className="mb-2 grid grid-cols-2 gap-2 text-xs text-[var(--ui-text-2)]"><p>今日调用 <b>{usage.today.filter((r) => r.success).length}</b></p><p>近30天 <b>{usage.recent.filter((r) => r.success).length}</b></p><p>今日估算 tokens <b>{usage.today.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0)}</b></p><p>自动调用 <b>{usage.today.filter((r) => r.automatic && r.success).length}</b></p></div><div className="mb-3 flex flex-wrap gap-1">{(['chat', 'proactive', 'memory', 'moments', 'worldbook', 'offlineState', 'persona', 'quality', 'other'] as const).map((purpose) => <span key={purpose} className="rounded bg-[var(--ui-surface-2)] px-1.5 py-1 text-[10px] text-[var(--ui-text-3)]">{purpose} {usage.today.filter((r) => r.purpose === purpose && r.success).length}</span>)}</div></>}<label className="mb-1 block text-xs text-[var(--ui-text-3)]">自动任务每日调用上限（0 为不限）</label><input type="number" min="0" value={automaticAiDailyCap} onChange={(e) => setSettings({ automaticAiDailyCap: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} className="w-full rounded-lg border border-[var(--ui-border)] px-3 py-2 text-sm" /></section></div></div>
}
