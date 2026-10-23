import { describe, expect, it } from 'vitest'
import { developLand } from './land-development'
import type { CityConfig, Road } from './types'
import { pointInPolygon, polygonsOverlap } from './geometry'

const config: CityConfig = { name: '試験町', seed: 'parcel-test', type: 'castle', terrain: 'plain', density: 65, forest: 0, railway: true, stations: 1, arterial: false, facilities: [], era: 'present' }
const roads: Road[] = [
  { id: 'a', points: [{ x: 300, y: 500 }, { x: 1000, y: 500 }], kind: 'local', width: 6, builtYear: 1650, role: 'collector' },
  { id: 'b', points: [{ x: 1000, y: 500 }, { x: 1000, y: 1200 }], kind: 'local', width: 6, builtYear: 1900, role: 'access' },
]
const run = (c = config, r = roads) => developLand({ config: c, roads: r, center: { x: 600, y: 500 }, stations: [{ id: 'station', point: { x: 1000, y: 1200 }, name: '試験駅' }], canPlace: () => true, slope: () => 0 })

describe('frontage land development', () => {
  it('preserves exact parcels and buildings when future railway settings change', () => {
    const a = run({ ...config, era: 'historic', railway: false }, [roads[0]!])
    const b = run({ ...config, era: 'historic', railway: true, stations: 5 }, roads)
    expect(b.buildings).toEqual(a.buildings)
    expect(b.parcels.filter(p => p.createdYear <= 1800)).toEqual(a.parcels)
  })
  it('keeps each footprint inside its own road-fronting parcel', () => {
    const result = run()
    expect(result.buildings.length).toBeGreaterThan(0)
    for (const building of result.buildings) {
      const parcel = result.parcels.find(p => p.id === building.parcelId)!
      expect(parcel.roadId).toBeTruthy()
      expect(building.polygon.every(p => pointInPolygon(p, parcel.polygon))).toBe(true)
      expect(building.builtYear).toBeGreaterThanOrEqual(parcel.createdYear)
    }
    for (let i = 0; i < result.parcels.length; i++) for (let j = i + 1; j < result.parcels.length; j++) expect(polygonsOverlap(result.parcels[i]!.polygon, result.parcels[j]!.polygon)).toBe(false)
  })
  it('records unserved demand instead of creating houses without road access', () => {
    const result = run(config, [])
    expect(result.buildings).toEqual([])
    expect(result.snapshots.at(-1)!.unmet).toBeGreaterThan(0)
  })

  it('subdivides deep modern plots only with a separate private road connection', () => {
    const modern: Road[] = [{ ...roads[0]!, id: 'modern-subdivision', builtYear: 1955, points: [{ x: 300, y: 500 }, { x: 1600, y: 500 }] }]
    const result = run({ ...config, density: 100 }, modern)
    const rear = result.parcels.filter(p => p.access)
    expect(rear.length).toBeGreaterThan(0)
    for (const p of rear) {
      expect(p.createdYear).toBeGreaterThanOrEqual(1955)
      expect(p.roadId).toBe('modern-subdivision')
      expect(p.access![0].y).toBeCloseTo(500)
      const stem = { x: (p.polygon[0].x + p.polygon[1].x) / 2, y: (p.polygon[0].y + p.polygon[2].y) / 2 }
      expect(pointInPolygon(stem, p.polygon)).toBe(true)
      for (const building of result.buildings.filter(b => b.parcelId === p.id)) expect(building.polygon.every(q => pointInPolygon(q, p.polygon))).toBe(true)
    }
    for (let i = 0; i < result.parcels.length; i++) for (let j = i + 1; j < result.parcels.length; j++) expect(polygonsOverlap(result.parcels[i].polygon, result.parcels[j].polygon)).toBe(false)
  })
  it('keeps construction events and saved times consistent', () => {
    const result = run()
    expect(run()).toEqual(result)
    expect(result.snapshots.at(-1)!.year).toBe(2025)
    for (const b of result.buildings) expect(result.events.some(e => e.entityId === b.id && e.year === b.builtYear)).toBe(true)
    for (const snapshot of result.snapshots) expect(snapshot.vacant - snapshot.unmet).toBe(snapshot.capacity - snapshot.households)
  })
  it('gives each rebuild a unique event ID when the same parcel is developed again', () => {
    const result = developLand({ config, roads, center: { x: 600, y: 500 }, stations: [], canPlace: (_polygon, year) => year !== 1955, slope: () => 0 })
    expect(new Set(result.events.map(event => event.id)).size).toBe(result.events.length)
    const constructed = result.events.filter(event => event.kind === 'construction')
    expect(constructed.some(event => constructed.some(other => other !== event && other.entityId === event.entityId && other.year !== event.year))).toBe(true)
    expect(result.events.some(event => event.kind === 'acquisition' && event.year === 1955)).toBe(true)
  })
})
