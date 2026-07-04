interface AvatarProps {
  avatar: string
  color?: string
  size?: number
  rounded?: 'full' | 'lg'
}

export function Avatar({ avatar, color = '#eef0f3', size = 48, rounded = 'lg' }: AvatarProps) {
  const isImage = avatar.startsWith('data:') || avatar.startsWith('http')
  const radiusClass = rounded === 'full' ? 'rounded-full' : 'rounded-xl'
  return (
    <div
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
