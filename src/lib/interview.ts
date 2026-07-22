import { chatCompletion } from './deepseek'
import type { AppSettings, JobListing } from '../types'
import { getPromptTemplate, promptModuleEnabled } from './promptModules'

export async function askInterview(settings: AppSettings, prompt: string, jsonMode = false) {
  if (!promptModuleEnabled(settings, 'career') || !prompt.trim()) throw new Error('职业提示词模块已屏蔽')
  return chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: '请继续' }], jsonMode, purpose: 'other' })
}

export function interviewOpeningPrompt(job: JobListing, settings: AppSettings) {
  const editable = getPromptTemplate(settings, 'career', 'interviewOpening', { company: job.company, interviewer: job.interviewer, jobTitle: job.title, requirements: job.requirements.join('；') }) ?? ''
  return `${editable}\n\n固定输出协议：只输出面试问题。`
}

export function interviewNextPrompt(job: JobListing, round: number, transcript: string, settings: AppSettings) {
  const editable = getPromptTemplate(settings, 'career', 'interviewNext', { jobTitle: job.title, requirements: job.requirements.join('；'), round, transcript }) ?? ''
  return `${editable}\n\n固定输出协议：只输出一个面试问题。`
}

export function interviewEvaluationPrompt(job: JobListing, transcript: string, settings: AppSettings) {
  const editable = getPromptTemplate(settings, 'career', 'interviewEvaluation', { jobTitle: job.title, transcript }) ?? ''
  return `${editable}\n\n固定输出协议：只输出JSON {"knowledge":0,"problemSolving":0,"communication":0,"fit":0,"feedback":"简评"}。`
}
