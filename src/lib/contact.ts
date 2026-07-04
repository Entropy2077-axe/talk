import type { Contact } from '../types'

export function displayName(contact: Pick<Contact, 'name' | 'remark'>): string {
  return contact.remark?.trim() || contact.name
}
