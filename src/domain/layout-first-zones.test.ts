import { describe, expect, it } from 'vitest'
import { planLayoutFirstZones } from './layout-first-zones'
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
    expect(result.zones.map(zone => zone.kind)).toContain('station')
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
})
