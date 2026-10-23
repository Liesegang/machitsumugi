import { describe, expect, it } from 'vitest'
import { developLand } from './land-development'
import { distanceToSegment, pointInPolygon, polygonArea, polygonsOverlap } from './geometry'
import type { CityConfig, Point, Road } from './types'

const config: CityConfig = { name: '渓泉町', seed: 'onsen-frontage', type: 'onsen', terrain: 'river', density: 80, forest: 20, railway: false, stations: 1, arterial: false, facilities: ['onsen'], era: 'present', settlement: 'regional-city' }
const center = { x: 1000, y: 1000 }
const roads: Road[] = [800, 1000, 1200].map(y => ({ id: `valley-${y}`, points: Array.from({ length: 21 }, (_, i) => ({ x: i * 100, y })), width: 6, kind: 'local', role: 'lane', builtYear: 1650 }))
const water = [{ x: 550, y: 1050 }, { x: 1450, y: 1050 }, { x: 1450, y: 1100 }, { x: 550, y: 1100 }]
const canPlace = (polygon: Point[]) => polygon.every(p => p.x >= 0 && p.x <= 2000 && p.y >= 500 && p.y <= 1500) && !polygonsOverlap(polygon, water)
const run = (change: Partial<CityConfig> = {}, grade = 0, suppliedRoads = roads) => developLand({ config: { ...config, ...change }, roads: suppliedRoads, center, thermalCenter: center, stations: [], canPlace, slope: () => grade })

describe('onsen lodging district', () => {
  it('mixes several small inns and larger acquired hotel plots near the thermal nucleus', () => {
    const result = run(), inns = result.buildings.filter(b => b.use === 'lodging'), small = inns.filter(b => b.lodgingType === 'ryokan'), hotels = inns.filter(b => b.lodgingType === 'hotel')
    expect(small.length).toBeGreaterThanOrEqual(5)
    expect(hotels.length).toBeGreaterThan(0)
    expect(Math.max(...hotels.map(b => polygonArea(b.polygon)))).toBeGreaterThan(Math.min(...small.map(b => polygonArea(b.polygon))) * 3)
    expect(hotels.some(b => b.height >= 4)).toBe(true)
    expect(new Set(inns.map(b => b.name)).size).toBe(inns.length)
    for (const building of inns) {
      const parcel = result.parcels.find(p => p.id === building.parcelId)!
      expect(parcel.use).toBe('commercial')
      expect(parcel.retiredYear).toBeUndefined()
      expect(building.kind).toBe('commercial')
      expect(building.guestRooms).toBeGreaterThan(0)
      expect(building.occupiedHouseholds).toBe(0)
      expect(building.polygon.every(p => pointInPolygon(p, parcel.polygon))).toBe(true)
      expect(canPlace(parcel.polygon)).toBe(true)
      const road = roads.find(r => r.id === parcel.roadId)!
      expect(Math.min(...road.points.slice(1).map((p, i) => distanceToSegment(parcel.entrance, road.points[i]!, p)))).toBeLessThan(7)
    }
    const active = result.parcels.filter(p => !p.retiredYear)
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) expect(polygonsOverlap(active[i]!.polygon, active[j]!.polygon)).toBe(false)
    for (const retired of result.parcels.filter(p => p.retiredYear)) expect(result.events.some(e => e.kind === 'acquisition' && e.entityId === retired.id && e.year === retired.retiredYear)).toBe(true)
    const householdCapacity = result.buildings.reduce((sum, b) => sum + (b.use === 'lodging' || b.kind === 'industrial' ? 0 : b.kind === 'residential' && b.height >= 3 ? b.height * 2 : 1), 0)
    expect(result.snapshots.at(-1)!.capacity).toBe(householdCapacity)
  })

  it('preserves a small-inn phase before post-war hotel land assembly', () => {
    const historic = run({ era: 'historic' }), railway = run({ era: 'railway' })
    expect(historic.buildings.filter(b => b.use === 'lodging').length).toBeGreaterThan(2)
    expect(railway.buildings.filter(b => b.use === 'lodging').length).toBeGreaterThan(historic.buildings.filter(b => b.use === 'lodging').length)
    expect(railway.buildings.some(b => b.lodgingType === 'hotel')).toBe(false)
    expect(historic.parcels.some(p => p.retiredYear)).toBe(false)
  })

  it('requires gentle ground and a real frontage instead of filling inaccessible slopes', () => {
    const steep = run({}, .18)
    expect(steep.buildings.length).toBeGreaterThan(0)
    expect(steep.buildings.some(b => b.use === 'lodging')).toBe(false)
    expect(run({}, 0, []).buildings).toEqual([])
    expect(run({ density: 0 }).buildings.some(b => b.use === 'lodging')).toBe(false)
  })

  it('keeps ordinary settlements out of the tourism market and remains deterministic', () => {
    const ordinary = developLand({ config: { ...config, type: 'post' }, roads, center, stations: [], canPlace, slope: () => 0 })
    expect(ordinary.buildings.some(b => b.use === 'lodging')).toBe(false)
    expect(run()).toEqual(run())
  })
})
