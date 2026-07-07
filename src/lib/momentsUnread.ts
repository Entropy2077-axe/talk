import type { Moment, SocialEvent } from '../types'

export function momentsUnreadCount(opts: {
  lastReadAt?: number
  moments: Moment[]
  socialEvents: SocialEvent[]
}): number {
  const lastReadAt = opts.lastReadAt ?? 0
  const newMoments = opts.moments.filter((moment) => moment.contactId !== 'user' && moment.createdAt > lastReadAt)
  const newInteractions = opts.socialEvents.filter(
    (event) =>
      event.createdAt > lastReadAt &&
      event.actorId !== 'user' &&
      event.targetId === 'user' &&
      (event.type === 'moment_liked' || event.type === 'moment_commented'),
  )
  return newMoments.length + newInteractions.length
}
