import { Outlet } from 'react-router-dom'
import { BottomNav } from './BottomNav'

export function TabLayout() {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Outlet />
      </div>
      <BottomNav />
    </>
  )
}
