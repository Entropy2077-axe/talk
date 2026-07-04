const PALETTE = ['#fde2e2', '#fdebd3', '#fdf6d3', '#e3f5e1', '#d9f0f2', '#dde6fb', '#e8dcf9', '#fbdce8']

export function randomAvatarColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)]
}
