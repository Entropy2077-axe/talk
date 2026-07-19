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

function envFile() {
  try {
    return Object.fromEntries(readFileSync(new URL('.env', root), 'utf8').split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([^#=]+)=(.*)$/)
      return match ? [[match[1].trim(), match[2].trim()]] : []
    }))
  } catch {
    return {}
  }
}

const fileEnv = envFile()
const apiKey = process.env.VITE_DEEPSEEK_API_KEY || fileEnv.VITE_DEEPSEEK_API_KEY || ''
const baseUrl = (process.env.VITE_DEEPSEEK_BASE_URL || fileEnv.VITE_DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const proModel = args.get('pro') || 'deepseek-v4-pro'
const flashModel = args.get('flash') || 'deepseek-v4-flash'
const scenario = args.get('scenario') || 'all'
const rounds = Number(args.get('rounds') || 20)
const runs = Number(args.get('runs') || 1)

if (!apiKey) {
  console.error('Missing VITE_DEEPSEEK_API_KEY (read from .env or process environment).')
  process.exit(1)
}

const compactReviewPrompt = (latest, draft, facts, recent) => `你是一个小型逻辑审查器。只判断可验证的客观逻辑，不续写、不润色、不按文风挑错。
检查：是否回答最新话语；是否混淆身份、说话人、指代、时间、地点、因果；是否违反人设硬事实；是否把未来安排当成已经发生；是否忽略用户明确纠正。
简短、冷淡、拒绝、不同意都不是错误。只有明确逻辑问题才valid=false。
只输出JSON：{"valid":true,"reason":""}
最新话语：${latest || '后台事件'}
主模型草稿：${draft}
硬事实：${facts || '无'}
近期上下文：${recent || '无'}`

const momentsReviewPrompt = (draft, facts, recent) => `You are a fast logic reviewer for a social feed. Check only objective issues: missing required entries, obvious repetition of recent or same-batch content, copy-paste comments, or contradiction of persona/relationship facts. Ordinary, short, or disagreeing content is valid. Set valid=false only for a clear issue. Output JSON only: {"valid":true,"reason":""}\nPersona facts: ${facts || '(none)'}\nRecent feed: ${recent || '(empty)'}\nCandidate JSON: ${draft}`

const scenarioPrompts = {
  persona: {
    model: proModel,
    jsonMode: true,
    maxTokens: 2200,
    system: `你是角色创建器。根据用户条件生成一个可长期扮演的人物，必须输出JSON：{"name":"不超过8字的自然名字","persona":"约250字的人设"}。人设要有具体身份、习惯、边界、说话方式、矛盾点和可持续聊天的生活细节，不能写成模板说明。条件：27岁，女，关系=朋友，标签=毒舌、慢热，爱好=摄影、夜跑。`,
    user: '请生成一个真实、可持续对话的人物。',
  },
  private: {
    model: proModel,
    system: `你是林夏，一个慢热、毒舌但心软的朋友。你和用户已经熟悉。先回应用户最新一句，不要总结，不要客服腔。输出2到3行，每行格式为<thought>第一人称短想法</thought>消息正文；最后单独输出<mood>一个情绪词</mood>。只输出聊天草稿，不要JSON。`,
    user: '我今天被同事气到了，想吐槽但又觉得说出来很幼稚。',
  },
  group: {
    model: proModel,
    system: `这是一个三人微信群。发言人只能是林夏、周野。模拟真实群聊，不要轮流答题；先回应用户，再允许自然互相接话。每行严格格式：<人名>（第一人称想法）[一个emoji]“消息内容”。输出3到5行，不要JSON、标题或解释。林夏毒舌慢热；周野直接爱开玩笑。`,
    user: '我周末想出去走走，但还没想好去哪。',
  },
  moments: {
    model: proModel,
    jsonMode: true,
    maxTokens: 700,
    system: `生成朋友圈内容。只输出JSON：{"moments":[{"content":"自然的短动态","comments":["最多两条角色评论"],"imageKeyword":""}]}。角色：林夏，毒舌慢热但心软，喜欢摄影。动态不要像广告、不要总结，不要重复同一个梗。`,
    user: '生成一条今天的朋友圈动态。',
  },
}

async function request({ model, messages, jsonMode = false, maxTokens = 900, temperature = 0.9 }) {
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
  return { content, elapsedMs, usage: json?.usage || {} }
}

function parseVerdict(raw) {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return { valid: false, reason: 'reviewer_invalid_json' }
  try {
    const parsed = JSON.parse(match[0])
    return { valid: parsed.valid === true, reason: typeof parsed.reason === 'string' ? parsed.reason : '' }
  } catch {
    return { valid: false, reason: 'reviewer_invalid_json' }
  }
}

async function oneTurn(kind) {
  const template = scenarioPrompts[kind]
  const main = await request({ model: template.model, messages: [{ role: 'system', content: template.system }, { role: 'user', content: template.user }], jsonMode: template.jsonMode, maxTokens: template.maxTokens })
  if (kind === 'persona') return { elapsedMs: main.elapsedMs, calls: 1, errors: 0, outputChars: main.content.length }
  const reviewStarted = performance.now()
  const review = await request({
    model: flashModel,
    messages: [{ role: 'system', content: kind === 'moments'
      ? momentsReviewPrompt(main.content, template.system, '')
      : compactReviewPrompt(template.user, main.content, template.system, '') }],
    jsonMode: true,
    maxTokens: 180,
    temperature: 0,
  })
  const verdict = parseVerdict(review.content)
  return { elapsedMs: main.elapsedMs + Math.round(performance.now() - reviewStarted), calls: 2, errors: verdict.valid ? 0 : 1, outputChars: main.content.length }
}

async function twentyTurns() {
  let history = ''
  const samples = []
  let finalErrors = 0
  for (let turn = 1; turn <= rounds; turn += 1) {
    const user = ['我今天有点烦。', '你觉得我是不是想太多了？', '刚才那件事又有新进展。', '先不说这个，你最近在忙什么？'][turn % 4]
    const system = `你是林夏，27岁，毒舌但心软，和用户是熟悉的朋友。必须尊重已发生的事实，不得把计划说成已经发生。输出2行聊天草稿，每行用<thought>想法</thought>正文，末尾<mood>情绪</mood>。只输出草稿。\n历史：${history.slice(-2400)}`
    const started = performance.now()
    let main = await request({ model: proModel, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens: 500, temperature: 0.85 })
    let review = await request({ model: flashModel, messages: [{ role: 'system', content: compactReviewPrompt(user, main.content, system.slice(0, 1400), history.slice(-800)) }], jsonMode: true, maxTokens: 180, temperature: 0 })
    let verdict = parseVerdict(review.content)
    let repaired = false
    if (!verdict.valid) {
      repaired = true
      main = await request({ model: proModel, messages: [{ role: 'system', content: system }, { role: 'user', content: user }, { role: 'assistant', content: main.content }, { role: 'user', content: `修正明确逻辑问题：${verdict.reason}。只输出修正后的聊天草稿，不要解释。` }], maxTokens: 500, temperature: 0.75 })
      review = await request({ model: flashModel, messages: [{ role: 'system', content: compactReviewPrompt(user, main.content, system.slice(0, 1400), history.slice(-800)) }], jsonMode: true, maxTokens: 180, temperature: 0 })
      verdict = parseVerdict(review.content)
    }
    if (!verdict.valid) finalErrors += 1
    history += `\n用户：${user}\n林夏：${main.content}`
    samples.push({ turn, elapsedMs: Math.round(performance.now() - started), repaired, valid: verdict.valid })
    console.log(JSON.stringify({ type: 'logic20_progress', ...samples.at(-1) }))
  }
  return { rounds, finalErrors, samples }
}

const selected = scenario === 'all' ? ['persona', 'private', 'group', 'moments'] : scenario.split(',').filter((item) => scenarioPrompts[item])
const report = { models: { pro: proModel, flash: flashModel }, targetMs: { round: 4000, persona: 10000 }, scenarios: {} }
for (const kind of selected) {
  const results = []
  for (let i = 0; i < runs; i += 1) {
    const result = await oneTurn(kind)
    results.push(result)
    console.log(JSON.stringify({ type: 'scenario', scenario: kind, run: i + 1, ...result }))
  }
  report.scenarios[kind] = results
}
if (scenario === 'all' || scenario === 'logic20') report.logic20 = await twentyTurns()
console.log(JSON.stringify({ type: 'summary', report }))
