import { describe, expect, it } from 'vitest'
import { buildLayoutFirstCover, layoutCoverArea } from './layout-first-cover'
import type { LayoutFirstCoverInput } from './layout-first-cover'
import type { Area, CityConfig, Parcel, Point, Road } from './types'
import { corridorPolygon, distanceToSegment, intersectRegions, pointInRegion, rectangle, regionArea } from './geometry'

const config: CityConfig = { name: '被覆試験町', seed: 'layout-cover', type: 'post', terrain: 'plain', density: 70, forest: 60, railway: false, stations: 0, arterial: false, facilities: [], targetYear: 2025 }
const water: Area = { id: 'river', kind: 'water', polygon: rectangle(450, 0, 45, 650), name: '試験川', waterLevel: 3 }
const forest: Area = { id: 'forest', kind: 'forest', polygon: rectangle(20, 20, 400, 580), name: '北山の森' }
const parcel: Parcel = { id: 'home', polygon: rectangle(140, 130, 50, 45), entrance: { x: 165, y: 130 }, roadId: 'street', createdYear: 1955, developedYear: 1955, use: 'residential' }
const run = (overrides: Partial<LayoutFirstCoverInput> = {}) => buildLayoutFirstCover({ config, width: 800, height: 650, terrain: { areas: [forest, water], elevation: () => 10, slope: () => 0, wetness: () => .1, waterAt: p => pointInRegion(p, water) }, zones: [], parcels: [parcel], roads: [{ id: 'street', kind: 'local', width: 6, points: [{ x: 50, y: 120 }, { x: 400, y: 120 }] }], reserves: [{ polygon: rectangle(240, 250, 90, 90) }], ...overrides })

describe('layout-first natural and developed cover', () => {
  it('actually clears acquired titles, civic campuses and full-width roads from an existing forest', () => {
    const result = run(), survivingForest = result.filter(area => area.kind === 'forest' || area.landUse === 'woodland')
    expect(survivingForest.length).toBeGreaterThan(0)
    for (const area of survivingForest) {
      expect(intersectRegions({ polygon: parcel.polygon }, area).reduce((sum, region) => sum + regionArea(region), 0)).toBe(0)
      expect(intersectRegions({ polygon: rectangle(240, 250, 90, 90) }, area).reduce((sum, region) => sum + regionArea(region), 0)).toBe(0)
      expect(intersectRegions({ polygon: corridorPolygon({ x: 50, y: 120 }, { x: 400, y: 120 }, 3) }, area).reduce((sum, region) => sum + regionArea(region), 0)).toBe(0)
    }
    expect(result.find(area => area.id === water.id)).toBe(water)
    expect(result.some(area => area.landUse === 'meadow')).toBe(true)
    expect(layoutCoverArea(result, 'meadow')).toBeGreaterThan(200000)
    expect(result.filter(area => area.kind === 'forest').reduce((sum, area) => sum + regionArea(area), 0)).toBeLessThan(regionArea(forest) - 10000)
  })
  it('retains exact water holes and makes the remainder meaningful grassland, without meadow under adopted land', () => {
    const lake: Area = { id: 'lake', kind: 'water', polygon: rectangle(100, 100, 300, 300), holes: [rectangle(230, 230, 40, 40)], waterLevel: 10, name: '島の湖' }
    const result = run({ terrain: { areas: [lake], elevation: () => 20, slope: () => 0, wetness: () => .1, waterAt: p => pointInRegion(p, lake) }, roads: [], parcels: [], reserves: [] })
    expect(result.at(-1)).toBe(lake)
    expect(result.some(area => area.landUse === 'meadow' && pointInRegion({ x: 250, y: 250 }, area))).toBe(true)
    expect(result.some(area => area.landUse === 'meadow' && pointInRegion({ x: 150, y: 150 }, area))).toBe(false)
    expect(layoutCoverArea(result, 'meadow') + regionArea(lake)).toBeCloseTo(800 * 650, 3)
  })
  it('surveys only accessible rural fields with road-reach orientations, with no arbitrary identical map-wide lattice', () => {
    const roads: Road[] = [{ id: 'east-reach', kind: 'local', role: 'farm', width: 4, points: [{ x: 100, y: 190 }, { x: 780, y: 190 }] }, { id: 'north-reach', kind: 'local', role: 'farm', width: 4, points: [{ x: 400, y: 280 }, { x: 400, y: 630 }] }]
    const result = run({ terrain: { areas: [], elevation: () => 20, slope: () => 0, wetness: () => .1, waterAt: () => false }, parcels: [], reserves: [], roads })
    const farms = result.filter(area => area.kind === 'field')
    expect(farms.length).toBeGreaterThan(8)
    const angles = farms.map(area => { const [a, b] = area.polygon; return Math.round(Math.atan2(b!.y - a!.y, b!.x - a!.x) * 180 / Math.PI) })
    expect(new Set(angles).size).toBeGreaterThan(1)
    for (const farm of farms) {
      expect(farm.landUse).toBe('dry-field') // No invented irrigation supply.
      const front = { x: (farm.polygon[0]!.x + farm.polygon[1]!.x) / 2, y: (farm.polygon[0]!.y + farm.polygon[1]!.y) / 2 }
      expect(Math.min(...roads.map(road => distanceToSegment(front, road.points[0]!, road.points[1]!)))).toBeLessThanOrEqual(5)
    }
    const inaccessible = run({ terrain: { areas: [], elevation: () => 20, slope: () => .3, wetness: () => .1, waterAt: () => false }, parcels: [], reserves: [], roads })
    expect(inaccessible.some(area => area.kind === 'field')).toBe(false)
  })
  it('does not perform a fine whole-map terrain sweep when a12x9km crop only needs existing natural regions clipped', () => {
    let calls = 0
    const test = (point: Point) => { calls++; return point.x * .001 }
    const result = run({ width: 12000, height: 9000, terrain: { areas: [], elevation: test, slope: () => { calls++; return 0 }, wetness: () => { calls++; return 0 }, waterAt: () => { calls++; return false } }, parcels: [], reserves: [], roads: [] })
    expect(result).toHaveLength(1)
    expect(result[0]!.landUse).toBe('meadow')
    expect(calls).toBe(0)
    expect(regionArea(result[0]!)).toBe(108000000)
  })
  it('does not copy a former forest hole into a separate cleared fragment', () => {
    const hollow: Area = { id: 'hollow-forest', kind: 'forest', polygon: rectangle(0, 0, 800, 650), holes: [rectangle(100, 100, 60, 60)] }
    const result = run({ terrain: { areas: [hollow], elevation: () => 20, slope: () => 0, wetness: () => .1, waterAt: () => false }, parcels: [], reserves: [], roads: [{ id: 'dividing-road', width: 10, kind: 'local', points: [{ x: 400, y: 0 }, { x: 400, y: 650 }] }] })
    for (const area of result.filter(a => a.kind === 'forest')) for (const hole of area.holes ?? []) expect(pointInRegion(hole[0]!, { polygon: area.polygon })).toBe(true)
  })
})
