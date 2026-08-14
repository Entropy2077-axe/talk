import type { LocationMapBinding, LocationNode, TerrainType, WorldMapRecord } from '../types'

export const MAP_SIZE = 48 as const
export const MAP_GENERATOR_VERSION = 4 as const
export const MIN_LOCATION_DISTANCE = 2 as const
const GENERATED_LOCATION_DISTANCE = 3

export const TERRAIN_LABELS: Record<TerrainType, string> = {
  river: '水域', grassland: '草地', beach: '沙滩', hill: '丘陵', mountain: '山地', urban: '城区', rural: '乡村',
}

export const TERRAIN_COLORS: Record<TerrainType, string> = {
  river: '#8fc6d2', grassland: '#c4d6b5', beach: '#ead7a6', hill: '#a9c092', mountain: '#7f9683', urban: '#d9d8cf', rural: '#bdcfa2',
}

function seedHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return hash >>> 0
}

function random01(seed: number, x: number, y: number) {
  let hash = seed ^ Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 1274126177, 2246822519)
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177)
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295
}

function smooth(value: number) { return value * value * (3 - 2 * value) }
function valueNoise(seed: number, x: number, y: number) {
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = smooth(x - x0), ty = smooth(y - y0)
  const a = random01(seed, x0, y0), b = random01(seed, x0 + 1, y0)
  const c = random01(seed, x0, y0 + 1), d = random01(seed, x0 + 1, y0 + 1)
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
}

function fbm(seed: number, x: number, y: number) {
  let value = 0, amplitude = 0.5, frequency = 1, total = 0
  for (let index = 0; index < 4; index += 1) {
    value += valueNoise(seed + index * 1013, x * frequency, y * frequency) * amplitude
    total += amplitude; amplitude *= 0.5; frequency *= 2
  }
  return value / total
}

const tileIndex = (x: number, y: number, width: number = MAP_SIZE) => y * width + x

/** Legacy deterministic generator kept for imported v1 maps and its regression test. */
export function generateTerrain(seedText: string): TerrainType[] {
  return generateStructuredTerrain(seedText)
}

/**
 * One stable pixel-city style. Rules own the large regions; noise only softens their borders.
 * The urban ellipse deliberately covers most buildable land so spaced city POIs still fit.
 */
export function generateStructuredTerrain(seedText: string, width = MAP_SIZE, height = MAP_SIZE): TerrainType[] {
  const seed = seedHash(seedText)
  const tiles: TerrainType[] = Array.from({ length: width * height }, () => 'grassland')
  const city = {
    x: width * (0.42 + random01(seed, 901, 17) * 0.11),
    y: height * (0.44 + random01(seed, 902, 19) * 0.12),
  }
  const cityRadiusX = width * (0.39 + random01(seed, 903, 23) * 0.07)
  const cityRadiusY = height * (0.36 + random01(seed, 904, 29) * 0.08)
  const ridgeCenter = {
    x: width * (0.09 + random01(seed, 905, 31) * 0.13),
    y: height * (0.07 + random01(seed, 906, 37) * 0.14),
  }

  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const n = fbm(seed, x / 11, y / 11)
    const cityDistance = Math.hypot((x - city.x) / cityRadiusX, (y - city.y) / cityRadiusY)
    const ridge = 1 - Math.hypot((x - ridgeCenter.x) / (width * 0.24), (y - ridgeCenter.y) / (height * 0.30))
    const elevation = ridge * 0.78 + n * 0.42
    const index = tileIndex(x, y, width)
    if (elevation > 0.72) tiles[index] = 'mountain'
    else if (elevation > 0.50) tiles[index] = 'hill'
    else if (cityDistance + (n - 0.5) * 0.18 < 1) tiles[index] = 'urban'
    else if (cityDistance < 1.34 || n > 0.56) tiles[index] = 'rural'
  }

  // A readable river stays east of the dense city and opens into a small south-east bay.
  const riverBase = width * (0.70 + random01(seed, 907, 41) * 0.12)
  const riverAmplitude = 1.5 + random01(seed, 908, 43) * 3.5
  const riverPeriod = 4.2 + random01(seed, 909, 47) * 3.2
  for (let y = 0; y < height; y += 1) {
    const riverX = Math.round(riverBase + Math.sin((y + (seed % 17)) / riverPeriod) * riverAmplitude)
    const halfWidth = y > height * 0.72 ? 2 : 1
    for (let dx = -halfWidth; dx <= halfWidth; dx += 1) {
      const x = riverX + dx
      if (x >= 0 && x < width) tiles[tileIndex(x, y, width)] = 'river'
    }
  }
  for (let y = Math.floor(height * 0.78); y < height; y += 1) for (let x = Math.floor(width * 0.79); x < width; x += 1) {
    const coast = x - width * 0.79 + (y - height * 0.78) * 0.5
    if (coast > width * 0.075) tiles[tileIndex(x, y, width)] = 'river'
    else if (coast > width * 0.01) tiles[tileIndex(x, y, width)] = 'beach'
  }

  return tiles
}

export function createWorldMap(seed: string): WorldMapRecord {
  const now = Date.now()
  return {
    id: 'active', width: MAP_SIZE, height: MAP_SIZE, seed, generatorVersion: MAP_GENERATOR_VERSION, mode: 'fixed',
    tiles: generateStructuredTerrain(seed),
    createdAt: now, updatedAt: now,
  }
}

const IDEALS: Record<string, { x: number; y: number }> = {
  residence: { x: .32, y: .55 }, apartment: { x: .40, y: .52 }, dormitory: { x: .29, y: .36 }, villa: { x: .18, y: .68 },
  school: { x: .30, y: .34 }, university: { x: .22, y: .29 }, office: { x: .50, y: .46 }, mall: { x: .57, y: .43 },
  hospital: { x: .34, y: .61 }, park: { x: .63, y: .61 }, beach: { x: .82, y: .80 }, scenic: { x: .12, y: .13 }, hill: { x: .20, y: .22 },
  farm: { x: .16, y: .82 }, factory: { x: .61, y: .73 }, station: { x: .58, y: .31 }, harbor: { x: .75, y: .60 }, village: { x: .22, y: .78 },
  library: { x: .43, y: .37 }, police: { x: .47, y: .56 }, 'city-hall': { x: .50, y: .50 }, cinema: { x: .59, y: .49 }, market: { x: .38, y: .67 }, custom: { x: .48, y: .50 },
}

export function defaultTerrainsForIcon(iconId: string): TerrainType[] {
  if (iconId === 'scenic') return ['mountain']
  if (iconId === 'hill') return ['hill']
  if (iconId === 'beach') return ['beach']
  if (iconId === 'harbor') return ['beach', 'grassland', 'rural']
  if (['farm', 'village', 'villa', 'camp'].includes(iconId)) return ['rural', 'grassland', 'hill']
  if (['park', 'forest'].includes(iconId)) return ['grassland', 'rural', 'hill']
  return ['urban', 'rural']
}

export function isLocationPlacementAvailable(point: { x: number; y: number }, locations: LocationNode[], map: WorldMapRecord, excludeId?: string, allowedTerrains?: TerrainType[]) {
  if (point.x < 0 || point.y < 0 || point.x >= map.width || point.y >= map.height) return false
  const terrain = map.tiles[tileIndex(point.x, point.y, map.width)]
  if (allowedTerrains && !allowedTerrains.includes(terrain)) return false
  return locations.filter((item) => item.id !== excludeId && item.mapBinding).every((item) => (
    Math.max(Math.abs(item.mapBinding!.x - point.x), Math.abs(item.mapBinding!.y - point.y)) >= MIN_LOCATION_DISTANCE
  ))
}

export function placeBuildings(map: WorldMapRecord, specs: Array<{ id: string; allowedTerrains: TerrainType[]; buildingCategory: string }>) {
  const used: LocationMapBinding[] = []
  const result = new Map<string, LocationMapBinding>()
  for (const spec of specs) {
    const baseIdeal = IDEALS[spec.buildingCategory] ?? IDEALS.custom
    const placementSeed = seedHash(`${map.seed}:${spec.id}:ideal`)
    const ideal = {
      x: Math.max(.08, Math.min(.90, baseIdeal.x + (random01(placementSeed, 11, 13) - .5) * .18)),
      y: Math.max(.08, Math.min(.90, baseIdeal.y + (random01(placementSeed, 17, 19) - .5) * .18)),
    }
    const candidates = map.tiles.map((terrain, index) => ({ terrain, x: index % map.width, y: Math.floor(index / map.width) }))
      .filter((tile) => spec.allowedTerrains.includes(tile.terrain) && used.every((item) => Math.max(Math.abs(item.x - tile.x), Math.abs(item.y - tile.y)) >= GENERATED_LOCATION_DISTANCE))
      .sort((a, b) => {
        const score = (tile: typeof a) => Math.hypot(tile.x / map.width - ideal.x, tile.y / map.height - ideal.y) + random01(seedHash(`${map.seed}:${spec.id}`), tile.x, tile.y) * 0.28
        return score(a) - score(b)
      })
    const candidate = candidates[0]
    if (!candidate) continue
    const binding = { x: candidate.x, y: candidate.y, allowedTerrains: spec.allowedTerrains, buildingCategory: spec.buildingCategory, iconId: spec.buildingCategory }
    used.push(binding); result.set(spec.id, binding)
  }
  return result
}

export function createUpgradedWorldMap(previous: WorldMapRecord, seed = previous.seed) {
  const next = createWorldMap(seed)
  next.createdAt = previous.createdAt
  return next
}
