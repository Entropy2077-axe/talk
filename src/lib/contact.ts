import type { Contact } from '../types'

export function displayName(contact: Pick<Contact, 'name' | 'remark'>): string {
  const remark = contact.remark?.trim()
  return remark ? `${contact.name}（${remark}）` : contact.name
}
