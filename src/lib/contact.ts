import type { Contact } from '../types'

/**
 * `name` is retained as the legacy, required storage field.  A contact's
 * nickname is now the single source of truth for their visible name.
 */
export function displayName(contact: Pick<Contact, 'name' | 'nickname' | 'remark'>): string {
  const nickname = contact.nickname?.trim() || contact.name
  const remark = contact.remark?.trim()
  return remark ? `${nickname}（${remark}）` : nickname
}
