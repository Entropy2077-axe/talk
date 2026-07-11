import { chatCompletion } from './deepseek'
import type { AppSettings, JobListing } from '../types'

export async function askInterview(settings: AppSettings, prompt: string, jsonMode = false) {
  return chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: '请继续' }], jsonMode, purpose: 'other' })
}

export function interviewOpeningPrompt(job: JobListing) {
  return `你是${job.company}的${job.interviewer}，正在面试${job.title}。要求：${job.requirements.join('；')}。这是4轮专业面试，请开场并只问第1个具体专业知识或实际场景问题，不要问泛泛自我介绍。只输出问题。`
}
