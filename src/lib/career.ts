import type { AppSettings, JobListing, ScheduleBlock } from '../types'
import { localDateKey } from './finance'
import { createDefaultPromptModules, getPromptTemplate } from './promptModules'

export const OCCUPATION_OPTIONS = ['程序员','教师','医生','律师','设计师','记者','摄影师','厨师','销售','研究员','店员','自由职业者']
export function employmentPatch(occupation: string, monthlySalary: number) {
  const today = localDateKey()
  return { occupation: occupation.trim(), monthlySalary: Math.max(1000, Math.round(monthlySalary)), jobStartedDate: today, lastSalaryDate: today }
}
export function buildJobsPrompt(query?: string, settings?: Pick<AppSettings, 'promptModules'>) {
  const editable = getPromptTemplate(settings ?? { promptModules: createDefaultPromptModules() }, 'career', 'jobs', { query: query || '随机行业' })
  if (!editable) return ''
  return `${editable}\n\n固定输出协议：只输出JSON {"jobs":[{"company":"公司","title":"职位","description":"简介","responsibilities":["职责"],"requirements":["要求"],"monthlySalary":8000,"difficulty":"入门|普通|竞争激烈","interviewer":"面试官身份"}]}`
}
export function parseJobs(raw: string): Omit<JobListing, 'id'|'status'|'createdAt'>[] {
  try {
    const text = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw
    const jobs = JSON.parse(text).jobs
    if (!Array.isArray(jobs)) return []
    return jobs.filter((j) => j && typeof j.company === 'string' && typeof j.title === 'string' && Number.isFinite(j.monthlySalary))
      .slice(0, 6).map((j) => ({ company: j.company.trim(), title: j.title.trim(), description: String(j.description ?? ''), responsibilities: Array.isArray(j.responsibilities) ? j.responsibilities.map(String) : [], requirements: Array.isArray(j.requirements) ? j.requirements.map(String) : [], monthlySalary: Math.max(1000, Math.min(200000, Math.round(j.monthlySalary))), difficulty: ['入门','普通','竞争激烈'].includes(j.difficulty) ? j.difficulty : '普通', interviewer: String(j.interviewer || '招聘经理') }))
  } catch { return [] }
}
export function buildOccupationPrompt(occupation: string, persona: string, settings?: Pick<AppSettings, 'promptModules'>) {
  const editable = getPromptTemplate(settings ?? { promptModules: createDefaultPromptModules() }, 'career', 'occupation', { occupation, persona })
  if (!editable) return ''
  return `${editable}\n\n固定输出协议：只输出JSON {"monthlySalary":8000,"schedule":[{"id":"任意","dayOfWeek":1,"startHour":9,"endHour":18,"phoneAccess":"unavailable","location":"公司","activity":"工作"}]}。月薪1000到200000整数；日程7到14条。`
}
export function parseOccupation(raw: string): { monthlySalary: number; schedule?: ScheduleBlock[] } | null {
  try { const text = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw; const p = JSON.parse(text); if (!Number.isFinite(p.monthlySalary)) return null; return { monthlySalary: Math.max(1000, Math.min(200000, Math.round(p.monthlySalary))), schedule: Array.isArray(p.schedule) ? p.schedule : undefined } } catch { return null }
}
