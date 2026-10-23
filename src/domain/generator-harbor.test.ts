import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, generateCity } from './generator'
import { distanceToSegment, pointInRegion, polygonOverlapsRegion, polygonsOverlap, rectangle } from './geometry'
import * as terrainModule from './terrain'
import type { TerrainModel } from './terrain'
import { erodeTerrain } from './hydrology'
import type { CityConfig, CityMap } from './types'

const config: CityConfig = { ...DEFAULT_CONFIG, type: 'port', terrain: 'coast', density: 0, era: 'railway', facilities: ['port'] }

// This integration fixture surveys a flat, accessible shore deliberately. A
// stochastic eroded coast need not have a buildable reclamation site at all.
// Only the terrain provider is replaced: roads, railway, acquisition and dated
// warehouses all run through the real city generator below.
function surveyedCoast(landHeight = 5): TerrainModel {
  const areas = [{ id: 'sea', kind: 'water' as const, polygon: rectangle(2200, 0, 1800, 3000) }]
  const waterAt = (p: { x: number; y: number }) => areas.some(area => pointInRegion(p, area))
  const elevation = (p: { x: number; y: number }) => waterAt(p) ? -2 : landHeight
  const raw = Float32Array.from({ length: 16 }, (_, i) => elevation({ x: i % 4 * 2000, y: Math.floor(i / 4) * 2000 }))
  const hydrology: TerrainModel['hydrology'] = { ...erodeTerrain(raw, 4, 4, 2000, { passes: 0 }),
    extent: 6000, columns: 4, rows: 4, resolution: 2000, seed: 1, ocean: Uint8Array.from(raw, value => Number(value < 0)),
    cropOrigin: { x: 0, y: 0 }, frame: { worldAnchor: { x: 0, y: 0 }, localAnchor: { x: 0, y: 0 }, angle: 0, mirrored: false },
    localResolution: 2000, localColumns: 4, localRows: 4, localDEM: raw, channelEvolution: [], oxbows: [], depressionLakes: [] }
  return { areas, elevation, waterAt, slope: () => 0, cityOrigin: { x: 1800, y: 1500 },
    landform: p => waterAt(p) ? 'water' : 'terrace', wetness: () => .2, terrainCost: p => waterAt(p) ? 100 : 1,
    cultivable: p => !waterAt(p), bankDistance: () => Infinity, channelAt: () => null, rivers: [], bridgeSites: [], bridgeCandidates: [], hydrology }
}

let present: CityMap, natural: CityMap
describe('dated harbor earthworks and their actual urban integration', { timeout: 600000 }, () => {
  const terrainSpy = vi.spyOn(terrainModule, 'createTerrainModel')
  beforeAll(() => {
    terrainSpy.mockImplementation(() => surveyedCoast())
    present = generateCity(config)
    natural = generateCity({ ...config, facilities: [] })
  }, 600000)
  afterAll(() => terrainSpy.mockRestore())
  it('adds a connected quay and two warehouses while keeping the earlier railway on its natural corridor', () => {
    const yard = present.areas.find(a => a.id === 'harbor-yard')
    expect(yard).toBeDefined()
    expect(present.facilities.filter(f => f.kind === 'port')).toHaveLength(1)
    expect(present.railways).toEqual(natural.railways)
    const roads = present.roads.filter(r => r.id.startsWith('harbor-'))
    expect(roads).toHaveLength(3)
    expect(roads.every(r => r.builtYear === 1920)).toBe(true)
    const approach = roads.find(r => r.id === 'harbor-approach')!
    const first = approach.points[0]!
    expect(present.roads.some(r => !r.id.startsWith('harbor-') && (r.builtYear ?? 1650) <= 1920 && r.points.some(p => Math.hypot(p.x - first.x, p.y - first.y) < 1e-7))).toBe(true)
    const warehouses = present.buildings.filter(b => b.id.startsWith('harbor-warehouse'))
    expect(warehouses).toHaveLength(2)
    for (const building of warehouses) {
      expect(building.builtYear).toBe(1920)
      expect(building.kind).toBe('industrial')
      expect(building.polygon.every(p => pointInRegion(p, yard!))).toBe(true)
      expect(present.areas.some(a => a.kind === 'water' && polygonOverlapsRegion(building.polygon, a))).toBe(false)
    }
    expect(polygonsOverlap(warehouses[0]!.polygon, warehouses[1]!.polygon)).toBe(false)
    expect(present.buildings.filter(b => !b.id.startsWith('harbor-warehouse')).every(b => !polygonsOverlap(b.polygon, yard!.polygon))).toBe(true)
    const water = present.areas.filter(a => a.kind === 'water')
    for (const road of roads) for (const p of road.points) expect(water.some(a => pointInRegion(p, a))).toBe(false)
  })
  it('rejects pre-reclamation buildings on the former sea and preserves the unrequested coastline', () => {
    const terrain = surveyedCoast()
    const formerWater = terrain.areas.filter(a => a.kind === 'water')
    for (const building of present.buildings.filter(b => (b.builtYear ?? 1700) < 1920)) expect(formerWater.some(a => polygonOverlapsRegion(building.polygon, a))).toBe(false)
    expect(natural.areas.some(a => a.id === 'harbor-yard')).toBe(false)
    expect(natural.roads.some(r => r.id.startsWith('harbor-'))).toBe(false)
    const sea = natural.areas.filter(a => a.id === 'sea' || a.id.startsWith('sea-'))
    expect(sea).toEqual(terrain.areas.filter(a => a.id === 'sea' || a.id.startsWith('sea-')))
  })
  it('does not place modern reclamation or warehouses in the founding era', () => {
    const historic = generateCity({ ...config, era: 'historic' })
    expect(historic.areas.some(a => a.id === 'harbor-yard')).toBe(false)
    expect(historic.roads.some(r => r.id.startsWith('harbor-'))).toBe(false)
    expect(historic.buildings.some(b => b.id.startsWith('harbor-warehouse'))).toBe(false)
    expect(historic.events!.every(e => e.year <= 1800)).toBe(true)
  })
  it('keeps unsuitable high shores natural and reports an omitted port if no landing can be accessed', () => {
    terrainSpy.mockImplementation(() => surveyedCoast(24))
    const coast = surveyedCoast(24)
    const map = generateCity({ ...config, railway: false })
    expect(map.areas.some(area => area.id === 'harbor-yard')).toBe(false)
    expect(map.roads.some(road => road.id.startsWith('harbor-'))).toBe(false)
    expect(map.buildings.some(building => building.id.startsWith('harbor-warehouse'))).toBe(false)
    expect(map.events!.some(event => event.id === 'event-harbor-reclamation')).toBe(false)
    expect(map.areas.filter(area => area.id === 'sea')).toEqual(coast.areas)
    const landing = map.facilities.find(facility => facility.kind === 'port')
    if (landing) expect(coast.waterAt(landing.point)).toBe(false)
    else expect(map.unplacedFacilities?.find(facility => facility.kind === 'port')?.reason.length).toBeGreaterThan(10)
    terrainSpy.mockImplementation(() => surveyedCoast())
  })
})

describe('a port requested on the actual simulated coast', { timeout: 600000 }, () => {
  it('uses only a feasible quay or a dry shoreline landing and explains an unavailable site', () => {
    const coast = terrainModule.createTerrainModel({ width: 4000, height: 3000, seed: config.seed, terrain: 'coast', type: 'port', forest: config.forest })
    const map = generateCity({ ...config, railway: false })
    const yard = map.areas.find(area => area.id === 'harbor-yard'), port = map.facilities.find(facility => facility.kind === 'port')
    if (!yard) {
      expect(map.areas.filter(area => area.kind === 'water')).toEqual(coast.areas.filter(area => area.kind === 'water'))
      expect(map.roads.some(road => road.id.startsWith('harbor-'))).toBe(false)
      expect(map.buildings.some(building => building.id.startsWith('harbor-warehouse'))).toBe(false)
      expect(map.events!.some(event => event.id === 'event-harbor-reclamation')).toBe(false)
    } else {
      expect(port).toBeDefined()
      expect(map.events!.find(event => event.id === 'event-harbor-reclamation')?.year).toBe(1920)
      expect(map.roads.filter(road => road.id.startsWith('harbor-'))).toHaveLength(3)
      for (const building of map.buildings.filter(building => building.id.startsWith('harbor-warehouse'))) {
        expect(building.polygon.every(point => pointInRegion(point, yard))).toBe(true)
        expect(map.areas.some(area => area.kind === 'water' && polygonOverlapsRegion(building.polygon, area))).toBe(false)
      }
    }
    if (port) {
      expect(map.areas.some(area => area.kind === 'water' && pointInRegion(port.point, area))).toBe(false)
      const bankDistance = Math.min(...map.areas.filter(area => area.kind === 'water').flatMap(area => [area.polygon, ...(area.holes ?? [])].flatMap(ring => ring.map((a, i) => distanceToSegment(port.point, a, ring[(i + 1) % ring.length]!)))))
      expect(bankDistance).toBeGreaterThan(30)
      expect(bankDistance).toBeLessThan(190)
    } else expect(map.unplacedFacilities?.find(facility => facility.kind === 'port')?.reason.length).toBeGreaterThan(10)
  })
})
