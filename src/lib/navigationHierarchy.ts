/** Explicit parent routes for the world/library hierarchy. Returning undefined
 * delegates every unrelated screen to the normal browser history behavior. */
export function managedBackParent(pathname: string): string | undefined {
  const detail = pathname.match(/^\/save-load\/world\/([^/]+)\/snapshot\/[^/]+$/)
  if (detail) return `/save-load/world/${detail[1]}`
  if (/^\/save-load\/world\/[^/]+$/.test(pathname)) return '/save-load'
  if (pathname === '/save-load') return '/me'
  const libraryWorld = pathname.match(/^\/library\/world\/([^/]+)$/)
  if (libraryWorld) return `/library?view=worldview&worldId=${encodeURIComponent(libraryWorld[1])}`
  return undefined
}

export function replaceHashRoute(route: string) {
  const base = window.location.href.split('#')[0]
  window.location.replace(`${base}#${route}`)
}
