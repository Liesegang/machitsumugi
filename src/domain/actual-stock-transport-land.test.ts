import { describe, expect, it } from 'vitest'
import { applyActualTransportLand } from './actual-stock-transport-land'
import { clippingDiagnostics, pointInRegion, rectangle, regionArea } from './geometry'
import { createCityTimeline, sliceCityAtYear } from './timeline'
import type { Area, CityMap, Parcel } from './types'

function fixture(areas: Area[]): CityMap {
  const map: CityMap = { width: 1000, height: 1000, year: 2025, config: { name: '市', seed: 'land-acquisition', type: 'castle', terrain: 'plain', density: 50, forest: 30, railway: false, stations: 0, arterial: false, facilities: [] },
    description: '', roads: [], buildings: [], parcels: [], areas, railways: [], stations: [], facilities: [], districts: [], events: [], snapshots: [{ year: 2025, households: 0, capacity: 0, vacant: 0, unmet: 0, roads: 0, buildings: 0 }] }
  map.timeline = createCityTimeline(map)
  return map
}
const farm = (): Area => ({ id: 'farm', kind: 'field', landUse: 'paddy', name: '水田', polygon: rectangle(0, 0, 100, 100), holes: [rectangle(20, 20, 20, 20)] })
const areaAt = (map: CityMap, year: number) => sliceCityAtYear(map, year).areas.reduce((sum, a) => sum + regionArea(a), 0)

describe('dated actual-stock transport land acquisition', () => {
  it('clips only acquired farmland strips at construction time, retaining original holes and both surviving pieces', () => {
    const map = fixture([farm()]), input = { year: 1955, strips: [{ polygon: rectangle(60, -10, 10, 120) }], roadIds: ['new-road'] }
    const before = JSON.stringify(map), beforeInput = JSON.stringify(input), result = applyActualTransportLand(map, input)
    expect(sliceCityAtYear(result, 1954).areas).toEqual(map.areas)
    expect(result.timeline!.areas[0]!.value).toBe(map.areas[0])
    expect(result.timeline!.areas[0]!.to).toBe(1955)
    expect(result.areas).toHaveLength(2)
    expect(areaAt(result, 1954)).toBe(9600)
    expect(areaAt(result, 1955)).toBe(8600)
    expect(result.areas.some(a => pointInRegion({ x: 30, y: 30 }, a))).toBe(false)
    expect(result.areas.some(a => pointInRegion({ x: 65, y: 50 }, a))).toBe(false)
    expect(result.areas.some(a => pointInRegion({ x: 10, y: 50 }, a))).toBe(true)
    expect(result.areas.some(a => pointInRegion({ x: 90, y: 50 }, a))).toBe(true)
    expect(JSON.stringify(map)).toBe(before)
    expect(JSON.stringify(input)).toBe(beforeInput)
    expect(applyActualTransportLand(result, input)).toBe(result)
  })

  it('preserves water, public parks, wetlands and all castle earthworks even if a supplied strip overlaps them', () => {
    const areas: Area[] = [
      { id: 'river', kind: 'water', polygon: rectangle(0, 0, 100, 100) }, { id: 'park', kind: 'park', polygon: rectangle(0, 0, 100, 100) },
      { id: 'wetland', kind: 'field', landUse: 'wetland', polygon: rectangle(0, 0, 100, 100) },
      { id: 'castle-wall-honmaru', kind: 'field', landUse: 'vacant', polygon: rectangle(0, 0, 100, 100) },
      { id: 'moat-dry-reserve', kind: 'field', landUse: 'vacant', polygon: rectangle(0, 0, 100, 100) },
    ]
    const map = fixture(areas)
    expect(applyActualTransportLand(map, { year: 2025, strips: [{ polygon: rectangle(10, 10, 20, 20) }], roadIds: ['road'] })).toBe(map)
  })

  it('changes each later cover version without leaking its geometry into earlier dates', () => {
    const map = fixture([{ id: 'field', kind: 'field', landUse: 'dry-field', polygon: rectangle(0, 0, 80, 100) }])
    const old: Area = { ...map.areas[0]!, polygon: rectangle(0, 0, 100, 100) }
    map.timeline!.areas = [{ from: 1650, to: 1970, value: old }, { from: 1970, value: map.areas[0]! }]
    const result = applyActualTransportLand(map, { year: 1950, strips: [{ polygon: rectangle(45, -10, 10, 120) }], roadIds: ['widened-road'] })
    expect(areaAt(result, 1949)).toBe(10000)
    expect(areaAt(result, 1950)).toBe(9000)
    expect(areaAt(result, 1969)).toBe(9000)
    expect(areaAt(result, 1970)).toBe(7000)
    expect(result.timeline!.areas[0]!.value).toBe(old)
    expect(result.timeline!.areas[0]!.to).toBe(1950)
  })

  it('records dated existing-title easements without changing ownership, housing or demand and respects unacquired strip holes', () => {
    const map = fixture([]), parcel: Parcel = { id: 'touched', polygon: rectangle(0, 0, 20, 20), entrance: { x: 0, y: 10 }, roadId: 'old-road', createdYear: 1800, use: 'residential' }
    const island: Parcel = { ...parcel, id: 'unacquired-hole', polygon: rectangle(40, 40, 10, 10) }
    map.parcels = [parcel, island]
    map.buildings = [{ id: 'house', parcelId: parcel.id, kind: 'residential', height: 2, builtYear: 1800, polygon: rectangle(2, 2, 4, 4), occupiedHouseholds: 1 }]
    map.timeline = createCityTimeline(map)
    const input = { year: 2025, strips: [{ polygon: rectangle(10, 10, 90, 90), holes: [rectangle(30, 30, 40, 40)] }], roadIds: ['new-road'] }, before = JSON.stringify(map)
    const result = applyActualTransportLand(map, input)
    expect(result.events).toHaveLength(1)
    expect(result.events![0]).toMatchObject({ year: 2025, kind: 'acquisition', entityId: parcel.id })
    expect(result.events![0]!.id.length).toBeLessThanOrEqual(128)
    expect(sliceCityAtYear(result, 2024).events).toEqual([])
    for (const key of ['buildings', 'parcels', 'snapshots', 'roads'] as const) expect(result[key]).toBe(map[key])
    for (const key of ['buildings', 'parcels', 'snapshots', 'roads', 'buildingStates'] as const) expect(result.timeline![key]).toBe(map.timeline![key])
    expect(JSON.stringify(map)).toBe(before)
    expect(applyActualTransportLand(result, input)).toBe(result)
  })

  it('uses spatial rejection before exact clipping in a region with many unrelated covers', () => {
    const remote = Array.from({ length: 600 }, (_, i): Area => ({ id: `far-${i}`, kind: 'forest', polygon: rectangle(1000 + i * 120, 1000, 100, 100) }))
    const map = fixture([...remote, farm()]), before = clippingDiagnostics.operations
    const result = applyActualTransportLand(map, { year: 2025, strips: [{ polygon: rectangle(60, -10, 10, 120) }], roadIds: ['road'] })
    expect(clippingDiagnostics.operations - before).toBeLessThanOrEqual(4)
    expect(result.areas.slice(0, 600)).toEqual(remote)
    expect(result.areas[0]).toBe(remote[0])
  })
})
