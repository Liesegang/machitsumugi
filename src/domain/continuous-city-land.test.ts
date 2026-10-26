import { describe, expect, it } from 'vitest'
import { developContinuousCityLand } from './continuous-city-land'
import type { ContinuousCityLandInput } from './continuous-city-types'
import type { CityConfig, Road } from './types'
import { boundsOf, corridorPolygon, distanceToSegment, intersectRegions, pointInPolygon, polygonArea, polygonOverlapsRegion, polygonsOverlap, rectangle, regionArea, subtractRegions } from './geometry'
import { buildingServiceYears } from './building-lifecycle'

const config: CityConfig = { name: '接道試験市', seed: 'whole-block-cadastre', type: 'post', terrain: 'plain', density: 90, forest: 0, railway: false, stations: 1, arterial: true, facilities: [], targetYear: 2025, settlement: 'metropolis' }
const loop = (width = 120, height = 60): Road[] => [
  { id: 'north', points: [{ x: 20, y: 20 }, { x: 20 + width, y: 20 }], kind: 'local', width: 6, builtYear: 1770 },
  { id: 'east', points: [{ x: 20 + width, y: 20 }, { x: 20 + width, y: 20 + height }], kind: 'local', width: 6, builtYear: 1770 },
  { id: 'south', points: [{ x: 20 + width, y: 20 + height }, { x: 20, y: 20 + height }], kind: 'local', width: 6, builtYear: 1770 },
  { id: 'west', points: [{ x: 20, y: 20 + height }, { x: 20, y: 20 }], kind: 'local', width: 6, builtYear: 1770 },
]
const run = (overrides: Partial<ContinuousCityLandInput> = {}) => {
  const input: ContinuousCityLandInput = { config, width: 500, height: 400, roads: loop(), blocks: [{ id: 'block', polygon: rectangle(20, 20, 120, 60) }], stations: [], reserves: [], terrain: { areas: [], elevation: () => 10, slope: () => 0, waterAt: () => false }, demand: { center: { x: 80, y: 50 }, regions: [{ polygon: rectangle(0, 0, 500, 400) }], at: () => .6, costAt: () => 1, openingAt: () => 1770, metrics: { cellSize: 25, reachableLandArea: 200000, targetUrbanArea: 200000, selectedUrbanArea: 200000 } }, ...overrides }
  return { input, result: developContinuousCityLand(input) }
}
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const overlapArea = (a: { polygon: { x: number; y: number }[] }, b: { polygon: { x: number; y: number }[] }) => intersectRegions(a, b).reduce((sum, region) => sum + regionArea(region), 0)

describe('continuous city whole-block cadastre', () => {
  it('partitions the whole ordinary block into varied urban titles with real frontage and contained rectangles', () => {
    const { input, result } = run()
    expect(result.parcels.length).toBeGreaterThan(20)
    expect(result.metrics.partitionAreaError).toBeLessThan(.05)
    expect(result.metrics.openSpaceArea / result.metrics.buildableArea).toBeLessThan(.08)
    expect(median(result.parcels.map(parcel => polygonArea(parcel.polygon)))).toBeGreaterThan(130)
    expect(median(result.parcels.map(parcel => polygonArea(parcel.polygon)))).toBeLessThan(260)
    expect(new Set(result.parcels.map(parcel => Math.round(polygonArea(parcel.polygon)))).size).toBeGreaterThan(10)
    expect(result.metrics.parcelArea + result.metrics.accessArea + result.metrics.openSpaceArea + result.metrics.unassignedArea).toBeCloseTo(result.metrics.buildableArea, 1)
    for (const parcel of result.parcels) {
      const road = input.roads.find(road => road.id === parcel.roadId)!
      expect(Math.min(...road.points.slice(1).map((b, i) => distanceToSegment(parcel.access![0]!, road.points[i]!, b)))).toBeLessThan(.001)
      for (const other of result.parcels) if (other !== parcel) expect(overlapArea(parcel, other)).toBeLessThan(.001)
      for (const other of result.parcels) if (other !== parcel) expect(overlapArea({ polygon: corridorPolygon(parcel.access![0]!, parcel.access![1]!, 1.1) }, other)).toBeLessThan(.001)
    }
    for (const building of result.buildings) {
      const parcel = result.parcels.find(parcel => parcel.id === building.parcelId)!
      expect(building.polygon).toHaveLength(4)
      expect(building.polygon.every(point => pointInPolygon(point, parcel.polygon))).toBe(true)
      expect(polygonArea(building.polygon) / polygonArea(parcel.polygon)).toBeGreaterThan(.28)
    }
  })

  it('uses a compact partition under stronger demand without globally enlarging houses', () => {
    const normal = run(), dense = run({ demand: { ...normal.input.demand, at: () => .9 } })
    expect(dense.result.parcels.length).toBeGreaterThan(normal.result.parcels.length)
    const areas = dense.result.parcels.map(parcel => polygonArea(parcel.polygon))
    expect(median(areas)).toBeGreaterThan(80)
    expect(median(areas)).toBeLessThan(170)
    expect(dense.result.buildings.every(building => polygonArea(building.polygon) <= 144.01)).toBe(true)
    expect(dense.result.metrics.partitionAreaError).toBeLessThan(.05)
  })

  it('subdivides a deep face using physically surveyed shared streets instead of invisible rear access', () => {
    const { input, result } = run({ roads: loop(240, 180), blocks: [{ id: 'deep', polygon: rectangle(20, 20, 240, 180) }] })
    expect(result.accessRoads.length).toBeGreaterThan(0)
    expect(result.accessRoads.length).toBeLessThanOrEqual(4)
    expect(result.metrics.accessArea).toBeGreaterThan(300)
    expect(result.metrics.partitionAreaError).toBeLessThan(.2)
    expect(result.metrics.openSpaceArea / result.metrics.buildableArea).toBeLessThan(.12)
    expect(result.parcels.some(parcel => result.accessRoads.some(road => road.id === parcel.roadId))).toBe(true)
    for (const lane of result.accessRoads) {
      expect(lane.width).toBe(4)
      const center = lane.points[1]!
      for (const other of result.accessRoads) if (other !== lane) for (let i = 1; i < other.points.length; i++) expect(distanceToSegment(center, other.points[i - 1]!, other.points[i]!)).toBeGreaterThanOrEqual(35)
      for (const point of [lane.points[0]!, lane.points.at(-1)!]) expect(Math.min(...[...input.roads, ...result.accessRoads.filter(road => road !== lane)].flatMap(road => road.points.slice(1).map((b, i) => distanceToSegment(point, road.points[i]!, b))))).toBeLessThan(.001)
      for (const parcel of result.parcels) for (let i = 1; i < lane.points.length; i++) expect(polygonsOverlap(parcel.polygon, corridorPolygon(lane.points[i - 1]!, lane.points[i]!, lane.width / 2))).toBe(false)
    }
    expect(median(result.parcels.map(parcel => polygonArea(parcel.polygon)))).toBeLessThan(260)
  })

  it('does not change cadastre or manufacture skinny lanes when one road has many collinear samples', () => {
    const simple = run()
    const roads = simple.input.roads.map(road => ({ ...road, points: Array.from({ length: 61 }, (_, i) => ({ x: road.points[0]!.x + (road.points[1]!.x - road.points[0]!.x) * i / 60, y: road.points[0]!.y + (road.points[1]!.y - road.points[0]!.y) * i / 60 })) }))
    const sampled = run({ roads })
    expect(sampled.result.parcels.map(parcel => ({ id: parcel.id, polygon: parcel.polygon }))).toEqual(simple.result.parcels.map(parcel => ({ id: parcel.id, polygon: parcel.polygon })))
    expect(sampled.result.buildings.map(building => building.polygon)).toEqual(simple.result.buildings.map(building => building.polygon))
    expect(sampled.result.accessRoads).toEqual([])
  })

  it('retains exact water and reserved holes while conserving all remaining buildable ground', () => {
    const water = { polygon: rectangle(68, 38, 18, 24) }, reserve = { polygon: rectangle(32, 30, 16, 13) }
    const { input, result } = run({ reserves: [reserve], terrain: { areas: [{ ...water, id: 'stream', kind: 'water' }], waterAt: point => pointInPolygon(point, water.polygon), slope: () => 0, elevation: () => 10 } })
    const roadRegions = input.roads.flatMap(road => road.points.slice(1).map((b, i) => ({ polygon: corridorPolygon(road.points[i]!, b, road.width / 2 + .25) })))
    const expected = subtractRegions(input.blocks[0]!, [...roadRegions, water, reserve]).reduce((sum, region) => sum + regionArea(region), 0)
    expect(result.metrics.buildableArea).toBeCloseTo(expected, 2)
    expect(result.metrics.partitionAreaError).toBeLessThan(.1)
    for (const parcel of result.parcels) {
      expect(overlapArea(parcel, water)).toBeLessThan(.001)
      expect(overlapArea(parcel, reserve)).toBeLessThan(.001)
    }
    for (const building of result.buildings) {
      expect(polygonOverlapsRegion(building.polygon, water)).toBe(false)
      expect(polygonOverlapsRegion(building.polygon, reserve)).toBe(false)
    }
  })

  it('reports an inaccessible interior explicitly and never invents a parcel road reference', () => {
    const { result } = run({ blocks: [{ id: 'isolated', polygon: rectangle(300, 200, 100, 80) }] })
    expect(result.parcels).toEqual([])
    expect(result.buildings).toEqual([])
    expect(result.openSpaces).toHaveLength(1)
    expect(result.openSpaces[0]!.name).toBeUndefined()
    expect(result.metrics.openReasons['実接道を確保できない街区内地']!.area).toBe(8000)
    expect(result.metrics.openSpaceArea).toBe(8000)
    expect(result.metrics.partitionAreaError).toBe(0)
  })

  it('serializes urban open areas as geometry only and leaves demand-free ground to natural cover', () => {
    const original = run(), outside = { id: 'outside-demand', polygon: rectangle(300, 200, 100, 80), holes: [rectangle(325, 225, 10, 10)] }
    const { result } = run({ blocks: [...original.input.blocks, outside], terrain: { ...original.input.terrain, slope: () => .3 }, demand: { ...original.input.demand, at: point => point.x > 250 ? 0 : .6 } })
    expect(result.openSpaces.length).toBeGreaterThan(0)
    expect(result.unassignedGround).toHaveLength(1)
    expect(regionArea(result.unassignedGround[0]!)).toBe(7900)
    expect(result.unassignedGround[0]!.holes![0]!.map(point => `${point.x}:${point.y}`).sort()).toEqual(outside.holes[0]!.map(point => `${point.x}:${point.y}`).sort())
    expect(result.metrics.unassignedArea).toBe(7900)
    expect(result.metrics.openReasons['都市需要外の連続地']).toBeUndefined()
    expect(result.metrics.partitionAreaError).toBeLessThan(.05)
    expect(result.metrics.parcelArea + result.metrics.accessArea + result.metrics.openSpaceArea + result.metrics.unassignedArea).toBeCloseTo(result.metrics.buildableArea, 1)
    const text = JSON.stringify({ areas: result.openSpaces, unassigned: result.unassignedGround })
    expect(text).not.toMatch(/frontages|segment|bounds|builtYear|points/)
    for (const area of JSON.parse(text).areas) expect(Object.keys(area).every(key => ['polygon', 'holes', 'id', 'kind', 'landUse'].includes(key))).toBe(true)
    for (const region of JSON.parse(text).unassigned) expect(Object.keys(region).every(key => ['polygon', 'holes'].includes(key))).toBe(true)
    expect(result.openSpaces.every(area => boundsOf(area.polygon).maxX < 250)).toBe(true)
    expect(text.length).toBeLessThan(20000)
  })

  it('dates frontage and repeated physical frames coherently without mutating earlier geometry', () => {
    const roads = loop().map(road => road.id === 'north' ? { ...road, kind: 'arterial' as const, role: 'collector' as const, width: 9 } : road)
    const first = run({ roads }), repeat = run({ roads }), past = run({ roads, config: { ...config, targetYear: 1850 } })
    expect(first.result).toEqual(repeat.result)
    expect(past.result.parcels).toEqual(first.result.parcels.filter(parcel => parcel.createdYear <= 1850))
    expect(past.result.history.buildings.map(version => version.value)).toEqual(first.result.history.buildings.filter(version => version.from <= 1850).map(version => version.value))
    expect(first.result.buildings.some(building => building.kind === 'commercial')).toBe(true)
    expect(first.result.history.buildings.some(version => version.from === 1770 && version.value.kind === 'commercial' && version.to! < 1900)).toBe(true)
    expect(new Set(first.result.history.buildings.map(version => version.value.id)).size).toBe(first.result.history.buildings.length)
    for (const building of first.result.buildings) expect(2025 - building.builtYear!).toBeLessThan(buildingServiceYears(config.seed, building))
    expect(first.result.history.buildingStates).toEqual([])
    expect(first.result.parcels.every(parcel => /^cf-p-\d+$/.test(parcel.id))).toBe(true)
    for (const version of first.result.history.buildings) {
      expect(version.value.id).toMatch(/^cf-b-\d+-\d+-\d+$/)
      expect(version.value.occupancy).toBe('occupied')
      expect(version.value.occupiedHouseholds).toBeGreaterThanOrEqual(0)
      for (const point of version.value.polygon) { expect(point.x * 10000).toBeCloseTo(Math.round(point.x * 10000), 5); expect(point.y * 10000).toBeCloseTo(Math.round(point.y * 10000), 5) }
    }
    expect(first.result.history.buildings.filter(version => version.from < 1955).every(version => version.value.height <= 2)).toBe(true)
    const later = run({ roads: roads.map(road => ({ ...road, builtYear: 1975 })), demand: { ...first.input.demand, openingAt: () => 1900 } })
    expect(later.result.parcels.every(parcel => parcel.createdYear >= 1975)).toBe(true)
    for (const parcel of later.result.parcels) expect(boundsOf(parcel.polygon).minX).toBeGreaterThan(20)
    const phased = run({ demand: { ...first.input.demand, openingAt: point => point.x > 80 ? 1975 : 1770 } })
    for (const building of phased.result.buildings) if (building.polygon.some(point => point.x > 80)) expect(phased.result.parcels.find(parcel => parcel.id === building.parcelId)!.createdYear).toBeGreaterThanOrEqual(1975)
  })
})
