import { describeCurrentSchedule } from './schedule'
import { normalizeMood } from './mood'
import type { Contact } from '../types'

function activeMood(contact: Contact, now: number): string {
  if (!contact.mood?.text) return ''
  if (now > contact.mood.expiresAt) return ''
  return normalizeMood(contact.mood.text)
}

function compactSchedule(contact: Contact, now: Date): string {
  const text = describeCurrentSchedule(contact, now)
  return text.replace(/^现在/, '').trim()
}

export async function buildPrivateStatusLine(contact: Contact, now = new Date()): Promise<string> {
  const parts: string[] = []
  const mood = activeMood(contact, now.getTime())
  if (mood) parts.push(mood)
  const schedule = compactSchedule(contact, now)
  parts.push(schedule || '空闲')
  return parts.join(' · ')
}

export async function buildGroupStatusLine(members: Contact[], now = new Date()): Promise<string> {
  const moods = members
    .map((m) => {
      const mood = activeMood(m, now.getTime())
      return mood ? `${m.name}${mood}` : ''
    })
    .filter(Boolean)
    .slice(0, 2)
  const busy = members
    .map((m) => {
      const schedule = compactSchedule(m, now)
      return schedule ? `${m.name}${schedule}` : ''
    })
    .filter(Boolean)
    .slice(0, 1)
  return [...moods, ...busy].filter(Boolean).slice(0, 3).join(' · ')
}
