import { describe, expect, it } from 'vitest'
import { planLayoutFirstStationZones, planLayoutFirstZones } from './layout-first-zones'
import type { CityConfig } from './types'

const config: CityConfig = { name: '試験市', seed: 'spatial-brief', type: 'post', terrain: 'river', density: 100, forest: 60, railway: true, stations: 3, arterial: true, facilities: [], settlement: 'metropolis' }
const terrain = { cityOrigin: { x: 1900, y: 1500 }, elevation: () => 18, slope: () => .005, waterAt: (p: { x: number }) => p.x > 1940 && p.x < 2060 }

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
})
