import { useState } from 'react'
import { TopBar } from '../components/TopBar'
import { SearchOverlay } from '../components/SearchOverlay'

export function DiscoverPage() {
  const [searching, setSearching] = useState(false)
  return (
    <div className="relative flex min-h-full flex-col">
      <TopBar title="发现" showSearch onSearchClick={() => setSearching(true)} />
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-gray-400">小程序（网购/地图/TODO）敬请期待</p>
      </div>
      {searching && <SearchOverlay onClose={() => setSearching(false)} />}
    </div>
  )
}
