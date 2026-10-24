import { describe, expect, it } from 'vitest'
import { developLand } from './land-development'
import type { CityConfig, Road } from './types'
import { corridorPolygon, pointInPolygon, polygonArea, polygonsOverlap } from './geometry'

const config: CityConfig = { name: '住区試験市', seed: 'deep-estate-supply', type: 'newtown', terrain: 'plain', density: 75, forest: 0, railway: true, stations: 1, arterial: false, facilities: [], settlement: 'regional-city', populationTrend: 'stable', era: 'present' }
const xs = [200, 440, 680, 920, 1160, 1400], ys = [100, 340, 580, 820]
const roads: Road[] = [
  ...ys.map((y, i) => ({ id: `district-horizontal-${i}`, points: xs.map(x => ({ x, y })), builtYear: i ? 1955 : 1650, width: 6, kind: 'local' as const, role: 'lane' as const })),
  ...xs.map((x, i) => ({ id: `district-vertical-${i}`, points: ys.map(y => ({ x, y })), builtYear: 1955, width: 6, kind: 'local' as const, role: 'lane' as const })),
]
const rights = roads.flatMap(road => road.points.slice(1).map((b, i) => ({ year: road.builtYear!, polygon: corridorPolygon(road.points[i]!, b, road.width / 2 + 2) })))
const run = (targetYear: number, scenario = config) => developLand({ config: { ...scenario, targetYear }, roads, center: { x: 680, y: 100 }, stations: [{ id: 'station', name: '住区駅', point: { x: 680, y: 340 } }], elevation: () => 5, slope: () => 0,
  canPlace: (polygon, year) => !rights.some(right => right.year <= year && polygonsOverlap(polygon, right.polygon)),
})

describe('dated modern residential estate supply', () => {
  it('actually acquires block-interior land with medium-rise housing and private access while preserving old titles and roads', () => {
    const original = structuredClone(roads), historic = run(1950), current = run(2025)
    const estates = current.parcels.filter(parcel => parcel.id.startsWith('housing-') && parcel.access && polygonArea(parcel.polygon) > 1800)
    expect(estates.length).toBeGreaterThan(0)
    for (const parcel of estates) {
      expect(parcel.createdYear).toBeGreaterThanOrEqual(1955)
      const building = current.buildings.find(building => building.parcelId === parcel.id)!
      expect(building).toBeTruthy()
      expect(building.height).toBeGreaterThanOrEqual(3)
      expect(building.height).toBeLessThanOrEqual(6)
      expect(building.polygon.every(point => pointInPolygon(point, parcel.polygon))).toBe(true)
      expect(polygonArea(building.polygon)).toBeGreaterThan(250)
      expect(current.events.some(event => event.id === `title-acquisition-${parcel.id}` && event.year === parcel.createdYear)).toBe(true)
      for (const other of current.parcels) if (other.id !== parcel.id && !other.retiredYear) expect(polygonsOverlap(parcel.polygon, other.polygon)).toBe(false)
      for (const right of rights) expect(polygonsOverlap(parcel.polygon, right.polygon)).toBe(false)
      for (let i = 2; i < parcel.access!.length; i++) expect(polygonsOverlap(corridorPolygon(parcel.access![i - 1]!, parcel.access![i]!, 1.5), building.polygon)).toBe(false)
    }
    for (const old of historic.parcels) {
      const present = current.parcels.find(parcel => parcel.id === old.id)!
      expect(present?.polygon).toEqual(old.polygon)
      expect(present.createdYear).toBe(old.createdYear)
    }
    const before1955 = (versions: typeof current.history.buildings) => versions.filter(version => version.from <= 1950).map(({ from, value }) => ({ from, value }))
    expect(before1955(current.history.buildings)).toEqual(before1955(historic.history.buildings))
    expect(roads).toEqual(original)
  })
  it('limits ordinary regional deep projects to the station quarter and does not turn rural towns into estates', () => {
    const regional = run(2025, { ...config, type: 'post' })
    const deep = regional.parcels.filter(parcel => parcel.id.startsWith('housing-') && parcel.access && polygonArea(parcel.polygon) > 1800)
    expect(deep.length).toBeGreaterThan(0)
    for (const parcel of deep) expect(Math.hypot(parcel.entrance.x - 680, parcel.entrance.y - 340)).toBeLessThan(455)
    const rural = run(2025, { ...config, type: 'post', settlement: 'rural-town' })
    expect(rural.parcels.some(parcel => parcel.id.startsWith('housing-') && parcel.access)).toBe(false)
  })
})
