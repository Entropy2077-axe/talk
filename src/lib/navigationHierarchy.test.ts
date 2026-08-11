import { describe, expect, it } from 'vitest'
import { managedBackParent } from './navigationHierarchy'

describe('world navigation hierarchy', () => {
  it('keeps picker, backup list and detail in one finite parent chain', () => {
    expect(managedBackParent('/save-load/world/world-a/snapshot/save-a')).toBe('/save-load/world/world-a')
    expect(managedBackParent('/save-load/world/world-a')).toBe('/save-load')
    expect(managedBackParent('/save-load')).toBe('/me')
  })

  it('returns worldview editing to the library and leaves unrelated routes alone', () => {
    expect(managedBackParent('/library/world/world-a')).toBe('/library?view=worldview&worldId=world-a')
    expect(managedBackParent('/chat/conversation-a')).toBeUndefined()
  })
})
