import { parseJsonLoose } from './aiProtocol'
import type { Contact, LocationNode } from '../types'

export interface DirectOutputReview {
  valid: boolean
  reason: string
}

export function buildDirectOutputInstruction(locations: LocationNode[]): string {
  const leaves = locations.filter((location) => !locations.some((candidate) => candidate.parentId === location.id))
  const locationText = leaves.length > 0
    ? leaves.map((location) => `${location.id}=${location.name}`).join('；')
    : '无（specialTask.decision 必须为 none）'
  return `【实验：一次调用直出】
忽略上文关于纯文本草稿、行协议和“不要输出JSON”的要求。本轮只输出一个合法 JSON 对象，不要 Markdown，不要代码围栏，不要 JSON 之外的文字。
你要在一次输出里完成自然回复、内部自审和特殊任务判断。固定结构：
{"messages":[{"type":"text","content":"自然聊天内容"}],"mood":"简短心情","thought":"不超过100字的真实想法","knowledgeQueries":[],"review":{"valid":true,"reason":"已检查人设、时间因果、已知事实、地点和承诺边界"},"specialTask":{"decision":"none","reason":"没有形成需要实际执行的线下安排"}}

messages 可使用现有协议类型：text、sticker、link、image、transfer、redPacket、loanRequest、loanDecision、giftPurchase。保持聊天气泡简短自然。image 只包含生图 query 等画面字段，不填写 caption；只要发送 image，同一轮就必须另外包含至少一条自然的 text 消息。
review 必须先自查再填写。若草稿违反人物硬设定、时间因果、已知事实或凭空声称去过/看过未知事物，先在同一次生成中修正，最终通常应输出 valid=true；确实无法安全回答才输出 valid=false 和原因。
specialTask 只有在角色本轮已经明确、无条件答应一项将实际执行的线下安排，并且日期、HH:mm 开始时间、5分钟到24小时的时长、活动和合法具体地点全部明确时，才输出：
{"decision":"create_special_task","locationId":"必须逐字选自下列ID","date":"YYYY-MM-DD","startTime":"HH:mm","durationMinutes":30,"activity":"活动","summary":"摘要","phoneAccess":"available","reason":"角色已明确答应的证据"}
角色明确答应“现在立刻去某地做某事”也属于可执行安排：使用设备当前日期和当前 HH:mm 作为开始时间，并根据活动合理估计 durationMinutes；不要因为用户没有复述钟点而把“现在”当成时间不明确。
邀请、询问、讨论、考虑、拒绝、附带未满足条件、模糊的以后再说、回忆往事，都必须输出 decision=none。不要为了创建任务而改变角色原本会说的话。
合法具体地点：${locationText}
knowledgeQueries 在此实验模式下必须保持空数组，因为本轮不会再发起第二次模型请求。`
}

export function parseDirectOutputReview(raw: string): DirectOutputReview | null {
  const root = parseJsonLoose<Record<string, unknown>>(raw)
  const review = root?.review
  if (!review || typeof review !== 'object') return null
  const value = review as Record<string, unknown>
  if (typeof value.valid !== 'boolean') return null
  return {
    valid: value.valid,
    reason: typeof value.reason === 'string' ? value.reason.trim().slice(0, 240) : '',
  }
}

export function buildDirectGroupOutputInstruction(speakers: Contact[]): string {
  const speakerLines = speakers.map((speaker, index) => `${index + 1}=${speaker.name}`).join('；')
  return `【实验：一次调用直出】
忽略上文的纯文本行格式要求。本轮只输出一个合法 JSON 对象，不要 Markdown、代码围栏或额外说明。
固定结构：{"messages":[{"speakerIndex":1,"speakerName":"姓名","type":"text","content":"消息","thought":"真实想法","mood":"心情"}],"turnSummary":"一句话总结","knowledgeQueries":[],"planCandidates":[],"review":{"valid":true,"reason":"已检查人物、事实与时间因果"}}
每条消息的 speakerIndex 必须来自本轮发言人：${speakerLines}。thought 和 mood 必填。消息可用 text、sticker、image 类型。image 不填写 caption；某位成员发送 image 时，同一轮必须另有该成员的一条 text 消息。
若至少两位成员在本轮明确同意同一个共同计划，可直接填写 planCandidates：[{"title":"标题","summary":"计划","participantIndexes":[1,2],"location":"地点或待定"}]；否则保持空数组。
先在同一次生成中完成事实、人设、时间因果与发言人自审并修正，再填写 review。knowledgeQueries 必须保持空数组，因为本轮不会再发起第二次模型请求。`
}
