import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const value = process.argv[i]
  if (!value.startsWith('--')) continue
  const [key, inline] = value.slice(2).split('=', 2)
  args.set(key, inline ?? process.argv[i + 1] ?? 'true')
  if (inline === undefined) i += 1
}

function readEnv() {
  try {
    return Object.fromEntries(readFileSync(new URL('.env', root), 'utf8').split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([^#=]+)=(.*)$/)
      return match ? [[match[1].trim(), match[2].trim()]] : []
    }))
  } catch {
    return {}
  }
}

const fileEnv = readEnv()
const apiKey = process.env.VITE_DEEPSEEK_API_KEY || fileEnv.VITE_DEEPSEEK_API_KEY || ''
const baseUrl = (process.env.VITE_DEEPSEEK_BASE_URL || fileEnv.VITE_DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const proModel = args.get('pro') || 'deepseek-v4-pro'
const flashModel = args.get('flash') || 'deepseek-v4-flash'
const runs = Math.max(1, Number(args.get('runs') || 1))

if (!apiKey) {
  console.error('Missing VITE_DEEPSEEK_API_KEY (read from .env or process environment).')
  process.exit(1)
}

async function request({ model, messages, jsonMode = false, maxTokens = 600, temperature = 0.8 }) {
  const started = performance.now()
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      thinking: { type: 'disabled' },
      temperature,
      max_tokens: maxTokens,
    }),
  })
  const elapsedMs = Math.round(performance.now() - started)
  const raw = await response.text()
  let json
  try { json = JSON.parse(raw) } catch { json = null }
  const content = json?.choices?.[0]?.message?.content
  if (!response.ok || typeof content !== 'string') {
    throw new Error(`HTTP ${response.status} ${String(json?.error?.message || raw).slice(0, 180)}`)
  }
  return { content, elapsedMs }
}

function parseVerdict(raw) {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return { instructionFollowed: false, roleFollowed: false, evidence: [], issue: 'judge_invalid_json' }
  try {
    const parsed = JSON.parse(match[0])
    return {
      instructionFollowed: parsed.instructionFollowed === true,
      roleFollowed: parsed.roleFollowed === true,
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter((x) => typeof x === 'string').slice(0, 3) : [],
      issue: typeof parsed.issue === 'string' ? parsed.issue.slice(0, 240) : '',
    }
  } catch {
    return { instructionFollowed: false, roleFollowed: false, evidence: [], issue: 'judge_invalid_json' }
  }
}

const scenarios = {
  lover_private: {
    label: '私聊恋人关系+共同过往',
    system: `你是小满，用户的恋人。你们在大学社团认识，她曾陪用户熬夜准备考试。你嘴硬但很在乎用户，喜欢用轻微挑衅掩饰关心。首轮第一句必须让人感觉你们熟悉且亲密，不能像客服或普通朋友。自然使用一个共同过往信号，但不要整段复述。只输出2到3条聊天消息，每行是<thought>第一人称想法</thought>正文，最后一行<mood>情绪</mood>。`,
    user: '早安，我今天有点困。',
    criteria: '必须体现恋人亲密距离，并自然体现大学社团/熬夜备考中的一个熟悉度信号；不能写成普通朋友问候。',
  },
  trait_private: {
    label: '私聊雌小鬼性格特质',
    system: `你是小满，用户的恋人，核心性格特质是“雌小鬼”：说话带一点优越感的逗弄、反问和嘴硬，随后会露出在乎或可爱的反差；不是普通温柔朋友。第一句就要能辨认这种特质，但不能恶意羞辱用户。只输出2到3条聊天消息，每行是<thought>第一人称想法</thought>正文，最后一行<mood>情绪</mood>。`,
    user: '我终于把那个难题做出来了。',
    criteria: '必须出现可观察的雌小鬼式逗弄/反问/嘴硬和在乎的反差，不能只有普通夸奖或客服式鼓励。',
  },
  lover_group: {
    label: '群聊首句关系与特质',
    system: `这是一个三人微信群，用户也是成员。发言人1小满是用户的恋人，嘴硬的雌小鬼，和用户在大学社团认识；发言人2阿野是普通朋友。第一条来自小满的有效消息必须体现恋人亲密距离，并出现轻微雌小鬼式逗弄或熟悉感；阿野不能替小满代述共同过往。只输出3到5行，每行严格为<人名>（想法）[😀/😊/🥰/😌/😶/🤔/😳/🥺/😟/😠/😤/😞/😭/😈]“消息内容”。`,
    user: '周末想出去走走，你们有什么建议？',
    criteria: '检查小满的第一条消息是否同时表现恋人距离和可辨认的雌小鬼特质；阿野不能冒充小满的共同过往。',
  },
}

function judgePrompt(scenario, draft) {
  return `你是严格的角色遵从度评审器。只根据候选回复和验收标准判断，不要因为文采好就放宽标准。
指令遵从度instructionFollowed：是否满足输出格式、首句/首轮要求、共同过往事实边界等明确指令。
角色遵从度roleFollowed：关系定位和核心性格是否在实际可见措辞/反应中体现，而不是只写在thought里。没有明显证据就判false。
验收标准：${scenario.criteria}
候选回复：
${draft}
只输出JSON：{"instructionFollowed":true,"roleFollowed":true,"evidence":["可见证据"],"issue":"若失败说明原因，否则空字符串"}`
}

async function runScenario(name, scenario) {
  const main = await request({
    model: proModel,
    messages: [{ role: 'system', content: scenario.system }, { role: 'user', content: scenario.user }],
    maxTokens: name === 'lover_group' ? 700 : 500,
    temperature: 0.8,
  })
  const judge = await request({
    model: flashModel,
    messages: [{ role: 'system', content: judgePrompt(scenario, main.content) }],
    jsonMode: true,
    maxTokens: 220,
    temperature: 0,
  })
  const verdict = parseVerdict(judge.content)
  return {
    elapsedMs: main.elapsedMs + judge.elapsedMs,
    mainMs: main.elapsedMs,
    judgeMs: judge.elapsedMs,
    pass: verdict.instructionFollowed && verdict.roleFollowed,
    instructionFollowed: verdict.instructionFollowed,
    roleFollowed: verdict.roleFollowed,
    evidence: verdict.evidence,
    issue: verdict.issue,
  }
}

const report = { models: { pro: proModel, flash: flashModel }, runs, scenarios: {} }
for (const [name, scenario] of Object.entries(scenarios)) {
  const results = []
  for (let run = 1; run <= runs; run += 1) {
    try {
      const result = await runScenario(name, scenario)
      results.push(result)
      console.log(JSON.stringify({ type: 'adherence_progress', scenario: name, run, ...result }))
    } catch (error) {
      const result = { pass: false, instructionFollowed: false, roleFollowed: false, error: String(error).slice(0, 240) }
      results.push(result)
      console.log(JSON.stringify({ type: 'adherence_progress', scenario: name, run, ...result }))
    }
  }
  report.scenarios[name] = {
    label: scenario.label,
    passRate: results.filter((result) => result.pass).length / results.length,
    results,
  }
}

console.log(JSON.stringify({ type: 'adherence_summary', report }))
