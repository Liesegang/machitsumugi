import { describe, expect, it } from 'vitest'
import { planLayoutFirstStationZones, planLayoutFirstZones, type LayoutZoneInput } from './layout-first-zones'
import type { CityConfig } from './types'
import { distance, pointInRegion, rectangle } from './geometry'

const config: CityConfig = { name: '試験市', seed: 'spatial-brief', type: 'post', terrain: 'river', density: 100, forest: 60, railway: true, stations: 3, arterial: true, facilities: [], settlement: 'metropolis' }
const terrain = { cityOrigin: { x: 1900, y: 1500 }, elevation: () => 18, slope: () => .005, waterAt: (p: { x: number }) => p.x > 1940 && p.x < 2060 }
const riverTerrain = (id = 'river-branch-1', waterWidth = 40, channelWidth = waterWidth, riverId = id): LayoutZoneInput['terrain'] => ({
  ...terrain,
  waterAt: p => p.x > 1940 && p.x < 1940 + waterWidth,
  areas: [{ id, kind: 'water', polygon: rectangle(1940, 0, waterWidth, 3000) }],
  channelAt: p => ({ point: { x: 1940 + waterWidth / 2, y: p.y }, tangent: { x: 0, y: 1 }, bankDistance: Math.abs(p.x - 1940 - waterWidth / 2) - waterWidth / 2, width: channelWidth, riverId, surfaceElevation: 18 }),
})
const withoutChannelMetadata = (natural: LayoutZoneInput['terrain']): LayoutZoneInput['terrain'] => ({ cityOrigin: natural.cityOrigin, elevation: natural.elevation, slope: natural.slope, waterAt: natural.waterAt })

describe('layout-first spatial district brief', () => {
  it('covers both banks with coherent variable districts and meaningful phases', () => {
    const result = planLayoutFirstZones({ config, width: 4000, height: 3000, terrain })
    expect(result.zones.length).toBeGreaterThanOrEqual(10)
    expect(result.zones.length).toBeLessThanOrEqual(14)
    expect(result.zones.some(zone => zone.center.x < 1940)).toBe(true)
    expect(result.zones.some(zone => zone.center.x > 2060)).toBe(true)
    expect(result.zones.every(zone => !terrain.waterAt(zone.center))).toBe(true)
    expect(result.zones.some(zone => zone.kind === 'station' || zone.kind === 'apartment')).toBe(false)
    expect(new Set(result.zones.map(zone => zone.builtYear)).size).toBeGreaterThan(3)
    expect(result.zones.every(zone => zone.radius <= 650 && zone.polygon.length === 16)).toBe(true)
    expect(Math.max(...result.zones.map(zone => zone.angle!)) - Math.min(...result.zones.map(zone => zone.angle!))).toBeLessThan(.3)
    expect(planLayoutFirstZones({ config, width: 4000, height: 3000, terrain })).toEqual(result)
  })

  it('keeps villages small and chooses genuine gentle land in mountain terrain', () => {
    const mountainous = { ...terrain, slope: (p: { x: number }) => p.x > 2300 ? .32 : .025 }
    const result = planLayoutFirstZones({ config: { ...config, settlement: 'village' }, width: 4000, height: 3000, terrain: mountainous })
    expect(result.zones.length).toBeLessThanOrEqual(2)
    expect(result.zones.every(zone => zone.center.x < 2300 && zone.maximumFloors <= 2)).toBe(true)
    expect(result.zones.every(zone => zone.radius < 450)).toBe(true)
  })

  it('scales the complete regional brief while bounding the surveys', () => {
    const result = planLayoutFirstZones({ config, width: 12000, height: 9000, terrain: { ...terrain, cityOrigin: { x: 5600, y: 4500 }, waterAt: () => false } })
    expect(result.zones.length).toBeGreaterThanOrEqual(25)
    expect(result.zones.length).toBeLessThanOrEqual(45)
    expect(result.zones.every(zone => zone.radius <= 1050)).toBe(true)
    expect(Math.max(...result.zones.map(zone => zone.center.x)) - Math.min(...result.zones.map(zone => zone.center.x))).toBeGreaterThan(7000)
  })

  it('selects the centre from the complete buildable region instead of preserving the geological origin corner', () => {
    const cornerOrigin = { ...terrain, cityOrigin: { x: 220, y: 240 }, waterAt: () => false }
    const result = planLayoutFirstZones({ config, width: 12000, height: 9000, terrain: cornerOrigin })
    expect(result.center.x).toBeGreaterThan(4000)
    expect(result.center.x).toBeLessThan(8000)
    expect(result.center.y).toBeGreaterThan(3000)
    expect(result.center.y).toBeLessThan(6000)
    expect(result.zones[0]!.center).toEqual(result.center)
    expect(result.zones.filter(zone => zone.kind === 'residential').length).toBeGreaterThan(result.zones.length * .7)
  })

  it('pulls district outlines back from the actual water and steep shoulders', () => {
    const bounded = { ...terrain, cityOrigin: { x: 200, y: 200 }, waterAt: (p: { x: number; y: number }) => p.x > 2500 || p.y > 2400, slope: (p: { x: number }) => p.x < 500 ? .3 : .01 }
    const result = planLayoutFirstZones({ config, width: 4000, height: 3000, terrain: bounded })
    expect(result.zones.length).toBeGreaterThan(3)
    expect(result.zones.every(zone => !bounded.waterAt(zone.center) && bounded.slope(zone.center) <= .17)).toBe(true)
    expect(result.zones.flatMap(zone => zone.polygon).every(point => !bounded.waterAt(point) && bounded.slope(point) <= .17)).toBe(true)
  })

  it('surveys an opening-era station context only after a real station and public gate exist', () => {
    const stationTerrain = { ...terrain, waterAt: (p: { x: number }) => p.x > 2450 }
    const parent = { id: 'actual-neighbourhood', center: { x: 2000, y: 1500 }, radius: 600, kind: 'residential' as const, builtYear: 1955, density: .8, maximumFloors: 6, polygon: [{ x: 1400, y: 900 }, { x: 2600, y: 900 }, { x: 2600, y: 2100 }, { x: 1400, y: 2100 }] }
    const station = { id: 'station-0', name: '中央駅', point: { x: 2253, y: 1500 }, entrance: { x: 2275, y: 1500 }, railwayId: 'main', builtYear: 1900 }
    const input = { config, width: 4000, height: 3000, terrain: stationTerrain, zones: [parent], stations: [station], gates: [{ id: 'station-access-0', point: { x: 2300, y: 1500 } }] }
    expect(planLayoutFirstStationZones({ ...input, stations: [] })).toEqual([])
    expect(planLayoutFirstStationZones({ ...input, gates: [] })).toEqual([])
    const context = planLayoutFirstStationZones(input)[0]!
    expect(context.center).toEqual(input.gates[0]!.point)
    expect(context.builtYear).toBe(1900)
    expect(context.polygon).toHaveLength(24)
    expect(context.polygon.every(point => !stationTerrain.waterAt(point))).toBe(true)
    expect(Math.max(...context.polygon.map(point => point.x))).toBeLessThan(2450)
    expect(Math.min(...context.polygon.map(point => point.x))).toBeLessThan(2000)
    expect(parent.builtYear).toBe(1955)
  })

  it('continues urban demand over an identified narrow tributary while leaving its physical water unchanged', () => {
    const natural = riverTerrain(), originalAreas = structuredClone(natural.areas)
    const input = { config, width: 4000, height: 3000, terrain: natural }
    const result = planLayoutFirstZones(input), conservative = planLayoutFirstZones({ ...input, terrain: withoutChannelMetadata(natural) })
    const extended = result.zones.flatMap((zone, i) => zone.polygon.flatMap((point, n) => zone.center.x < 1940 && point.x > 2030 && distance(zone.center, point) > distance(conservative.zones[i]!.center, conservative.zones[i]!.polygon[n]!) + 150 ? [{ zone, point }] : []))
    expect(extended.length).toBeGreaterThan(0)
    const crossing = extended[0]!, fraction = (1960 - crossing.zone.center.x) / (crossing.point.x - crossing.zone.center.x)
    const wetPoint = { x: 1960, y: crossing.zone.center.y + (crossing.point.y - crossing.zone.center.y) * fraction }
    expect(pointInRegion(wetPoint, crossing.zone)).toBe(true)
    expect(natural.waterAt(wetPoint)).toBe(true)
    expect(natural.areas).toEqual(originalAreas)
    expect(result.zones.flatMap(zone => zone.polygon).every(point => !natural.waterAt(point))).toBe(true)
    expect(planLayoutFirstZones(input)).toEqual(result)
  })

  it('retains first-water stops for the main river, lake, sea, unknown metadata and broad tributaries', () => {
    for (const natural of [riverTerrain('river', 40), riverTerrain('lake-1', 40, 20, 'river-branch-1'), riverTerrain('sea', 40, 20, 'river-branch-1'), riverTerrain('river-branch-1', 200), riverTerrain('river-branch-1', 200, 20)]) {
      const input = { config, width: 4000, height: 3000, terrain: natural }
      const result = planLayoutFirstZones(input)
      expect(result).toEqual(planLayoutFirstZones({ ...input, terrain: withoutChannelMetadata(natural) }))
      expect(result.zones.filter(zone => zone.center.x < 1940).every(zone => zone.polygon.every(point => point.x < 1940))).toBe(true)
    }
    const unidentified = { ...riverTerrain(), areas: undefined }
    expect(planLayoutFirstZones({ config, width: 4000, height: 3000, terrain: unidentified })).toEqual(planLayoutFirstZones({ config, width: 4000, height: 3000, terrain: withoutChannelMetadata(unidentified) }))
  })

  it('does not jump from a tributary onto a thin coastal strip, standing water or a steep far bank', () => {
    const stream = riverTerrain()
    const coast = { ...stream, areas: [...stream.areas!, { id: 'sea', kind: 'water' as const, polygon: rectangle(2010, 0, 1990, 3000) }], waterAt: (p: { x: number }) => p.x > 1940 && p.x < 1980 || p.x >= 2010, continuationTerrain: { seaAt: (p: { x: number }) => p.x >= 2010 } }
    const standing = { ...stream, standingWaterAt: (p: { x: number }) => p.x > 1940 && p.x < 1980 ? { id: 'wetland', kind: 'wetland' as const, level: 18 } : null }
    const steep = { ...stream, slope: (p: { x: number }) => p.x >= 1980 ? .3 : .005 }
    for (const natural of [coast, standing, steep]) {
      const input = { config, width: 4000, height: 3000, terrain: natural }
      expect(planLayoutFirstZones(input)).toEqual(planLayoutFirstZones({ ...input, terrain: withoutChannelMetadata(natural) }))
    }
  })

  it('allows an acquired station brief to span only the same bounded natural tributary', () => {
    const natural = riverTerrain(), parent = { id: 'parent', center: { x: 1850, y: 1500 }, radius: 600, kind: 'residential' as const, builtYear: 1955, density: 1, maximumFloors: 6, polygon: rectangle(1400, 900, 1200, 1200) }
    const station = { id: 'station-0', name: '中央駅', point: parent.center, railwayId: 'main', builtYear: 1900 }
    const input = { config, width: 4000, height: 3000, terrain: natural, zones: [parent], stations: [station], gates: [{ id: 'station-access-0', point: parent.center }] }
    const context = planLayoutFirstStationZones(input)[0]!, conservative = planLayoutFirstStationZones({ ...input, terrain: withoutChannelMetadata(natural) })[0]!
    expect(context.builtYear).toBe(1900)
    expect(Math.max(...context.polygon.map(point => point.x))).toBeGreaterThan(2100)
    expect(Math.max(...conservative.polygon.map(point => point.x))).toBeLessThan(1940)
    expect(natural.waterAt({ x: 1960, y: 1500 })).toBe(true)
  })
})
