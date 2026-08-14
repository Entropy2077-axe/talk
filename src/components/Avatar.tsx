interface AvatarProps {
  avatar?: string
  /** Backward-compatible alias used by compact list rows. */
  src?: string
  name?: string
  color?: string
  size?: number | 'md'
  rounded?: 'full' | 'lg' | 'md'
}

export function Avatar({ avatar: avatarProp, src, color = '#eef0f3', size: sizeProp = 48, rounded = 'lg' }: AvatarProps) {
  const avatar = avatarProp ?? src ?? ''
  const size = sizeProp === 'md' ? 44 : sizeProp
  const isImage = avatar.startsWith('data:') || avatar.startsWith('http')
  const radiusClass = rounded === 'full' ? 'rounded-full' : rounded === 'md' ? 'rounded-md' : 'rounded-xl'
  return (
    <div
      data-ui-scope="special"
      className={`flex shrink-0 items-center justify-center overflow-hidden ${radiusClass}`}
      style={{ width: size, height: size, background: isImage ? undefined : color }}
    >
      {isImage ? (
        <img src={avatar} alt="" className="h-full w-full object-cover" />
      ) : (
        <span style={{ fontSize: size * 0.52, lineHeight: 1 }}>{avatar}</span>
      )}
    </div>
  )
}
