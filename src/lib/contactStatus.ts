import { describeCurrentSchedule } from './schedule'
import { recentSocialEvents } from './socialEvents'
import { displayName } from './contact'
import type { Contact } from '../types'

function activeMood(contact: Contact, now: number): string {
  if (!contact.mood?.text) return ''
  if (now > contact.mood.expiresAt) return ''
  return contact.mood.text
}

function compactSchedule(contact: Contact, now: Date): string {
  const text = describeCurrentSchedule(contact, now)
  return text.replace(/^现在/, '').trim()
}

function compactEvent(summary: string, contactNames: string[]): string {
  let text = summary
  for (const name of contactNames) text = text.replaceAll(name, '')
  text = text.replace(/^用户/, '你').replace(/\s+/g, ' ').trim()
  return text.length > 32 ? `${text.slice(0, 32)}...` : text
}

export async function buildPrivateStatusLine(contact: Contact, now = new Date()): Promise<string> {
  const parts: string[] = []
  const mood = activeMood(contact, now.getTime())
  if (mood) parts.push(mood)
  const schedule = compactSchedule(contact, now)
  if (schedule) parts.push(schedule)
  const event = (await recentSocialEvents([contact.id], 1))[0]
  if (event) parts.push(compactEvent(event.summary, [displayName(contact), contact.name]))
  return parts.slice(0, 3).join(' · ')
}

export async function buildGroupStatusLine(members: Contact[], now = new Date()): Promise<string> {
  const memberNames = members.flatMap((m) => [displayName(m), m.name])
  const moods = members
    .map((m) => {
      const mood = activeMood(m, now.getTime())
      return mood ? `${displayName(m)}${mood}` : ''
    })
    .filter(Boolean)
    .slice(0, 2)
  const busy = members
    .map((m) => {
      const schedule = compactSchedule(m, now)
      return schedule ? `${displayName(m)}${schedule}` : ''
    })
    .filter(Boolean)
    .slice(0, 1)
  const event = (await recentSocialEvents(members.map((m) => m.id), 1))[0]
  return [...moods, ...busy, event ? compactEvent(event.summary, memberNames) : ''].filter(Boolean).slice(0, 3).join(' · ')
}
