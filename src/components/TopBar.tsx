import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'

interface TopBarProps {
  title: string
  showBack?: boolean
  showSearch?: boolean
  onSearchClick?: () => void
  right?: ReactNode
}

export function TopBar({ title, showBack, showSearch, onSearchClick, right }: TopBarProps) {
  const navigate = useNavigate()
  return (
    <header className="relative flex h-12 shrink-0 items-center border-b border-gray-100 bg-white px-2">
      <div className="flex w-14 items-center">
        {showBack && (
          <button
            onClick={() => navigate(-1)}
            aria-label="返回"
            className="flex h-9 w-9 items-center justify-center text-gray-700"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path
                d="M15 5l-7 7 7 7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
      <h1
        className="absolute text-[16px] font-medium text-gray-900"
        style={{ left: 'calc(50% - 6px)', transform: 'translateX(-50%)' }}
      >
        {title}
      </h1>
      <div className="ml-auto flex min-w-14 items-center justify-end gap-1">
        {showSearch && (
          <button
            onClick={onSearchClick}
            aria-label="搜索"
            className="flex h-9 w-9 items-center justify-center text-gray-700"
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
              <path
                d="M20 20l-4-4"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
        {right}
      </div>
    </header>
  )
}
