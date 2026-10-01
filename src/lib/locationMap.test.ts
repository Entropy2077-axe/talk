import { describe, expect, it } from 'vitest'
import { createWorldMap, generateStructuredTerrain, generateTerrain, isLocationPlacementAvailable, placeBuildings } from './locationMap'

describe('location map', () => {
  it('generates the same terrain for the same seed', () => {
    expect(generateTerrain('talk-map')).toEqual(generateTerrain('talk-map'))
    expect(generateTerrain('talk-map')).toHaveLength(48 * 48)
  })

  it('places buildings only on allowed terrain and keeps them separated', () => {
    const map = createWorldMap('talk-map')
    const specs = [
      { id: 'city-a', allowedTerrains: ['urban' as const], buildingCategory: 'mall' },
      { id: 'city-b', allowedTerrains: ['urban' as const], buildingCategory: 'hospital' },
      { id: 'park', allowedTerrains: ['grassland' as const], buildingCategory: 'park' },
    ]
    const result = placeBuildings(map, specs)
    const rows = [...result.values()]
    expect(rows).toHaveLength(specs.length)
    for (const row of rows) expect(row.allowedTerrains).toContain(map.tiles[row.y * map.width + row.x])
    for (let a = 0; a < rows.length; a += 1) for (let b = a + 1; b < rows.length; b += 1) {
      expect(Math.max(Math.abs(rows[a].x - rows[b].x), Math.abs(rows[a].y - rows[b].y))).toBeGreaterThanOrEqual(3)
    }
  })

  it('builds a larger structured pixel city with distinct hills and mountains', () => {
    const map = createWorldMap('structured-city')
    expect(map.generatorVersion).toBe(4)
    expect(map.width).toBe(48)
    expect(map.height).toBe(48)
    expect(map.roads).toBeUndefined()
    expect(map.tiles.filter((tile) => tile === 'river').length).toBeGreaterThan(100)
    expect(map.tiles.filter((tile) => tile === 'urban').length).toBeGreaterThan(900)
    expect(map.tiles.filter((tile) => tile === 'hill').length).toBeGreaterThan(50)
    expect(map.tiles.filter((tile) => tile === 'mountain').length).toBeGreaterThan(30)
    expect(generateStructuredTerrain('structured-city')).toEqual(generateStructuredTerrain('structured-city'))
  })

  it('uses the seed to produce visibly different terrain and placements', () => {
    const first = createWorldMap('regenerate-a')
    const second = createWorldMap('regenerate-b')
    const changedTiles = first.tiles.filter((tile, index) => tile !== second.tiles[index]).length
    expect(changedTiles).toBeGreaterThan(200)
    const specs = [
      { id: 'home', allowedTerrains: ['urban' as const], buildingCategory: 'residence' },
      { id: 'mall', allowedTerrains: ['urban' as const], buildingCategory: 'mall' },
      { id: 'hospital', allowedTerrains: ['urban' as const], buildingCategory: 'hospital' },
    ]
    expect([...placeBuildings(first, specs).values()].map(({ x, y }) => [x, y])).not.toEqual([...placeBuildings(second, specs).values()].map(({ x, y }) => [x, y]))
  })

  it('blocks the complete three-by-three area around another marker', () => {
    const map = createWorldMap('spacing')
    const locations = [{ id: 'one', name: '地点', kind: 'custom', description: '', sortOrder: 1, createdAt: 1, updatedAt: 1, mapBinding: { x: 10, y: 10, allowedTerrains: ['urban' as const], buildingCategory: 'custom' } }]
    expect(isLocationPlacementAvailable({ x: 11, y: 11 }, locations, map)).toBe(false)
    expect(isLocationPlacementAvailable({ x: 12, y: 10 }, locations, map)).toBe(true)
  })
})
