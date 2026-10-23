import { describe, expect, it } from 'vitest'
import { developLand } from './land-development'
import { surveyDevelopmentSite } from './development-terrain'
import type { CityConfig, Point, Road } from './types'

const config: CityConfig = { name: '山間検証', seed: 'mountain-pads', type: 'onsen', terrain: 'river', relief: 'hills', density: 65, forest: 0, railway: false, stations: 0, arterial: false, facilities: [], settlement: 'rural-town', era: 'present' }
const roads: Road[] = [-120, 0, 120].map(y => ({ id: `road-${y}`, kind: 'local', width: 5, role: 'lane', builtYear: 1700, points: [{ x: -400, y }, { x: 0, y }, { x: 400, y }] }))
roads.push({ id: 'connector', kind: 'local', width: 5, role: 'lane', builtYear: 1700, points: [{ x: 0, y: -120 }, { x: 0, y: 0 }, { x: 0, y: 120 }] })
const run = (elevation: (p: Point) => number, slope: (p: Point) => number = () => 0) => developLand({ config, roads, center: { x: 0, y: 0 }, stations: [], canPlace: () => true, elevation, slope })

describe('mountain development with identical demand and road access', () => {
  it('produces the same settlement on an equally flat high basin', () => {
    const low = run(() => 30), high = run(() => 1230)
    expect(high).toEqual(low)
    expect(high.buildings.length).toBeGreaterThan(40)
    expect(high.buildings.some(building => building.use === 'lodging')).toBe(true)
  })
  it('rejects footprints crossing scarps without reducing the requested population', () => {
    const flat = run(() => 0)
    // Dense scarps deliberately fool a centre-only slope test. The building pad
    // must be surveyed; ordinary construction cannot bridge a 16m step.
    const elevation = (p: Point) => Math.floor((p.x + 1000) / 60) % 2 ? 16 : 0
    const scarps = run(elevation)
    expect(scarps.buildings.length).toBeLessThan(flat.buildings.length)
    expect(scarps.snapshots.map(({ year, households }) => ({ year, households }))).toEqual(flat.snapshots.map(({ year, households }) => ({ year, households })))
    for (const building of scarps.buildings) {
      const point = building.polygon.reduce((p, q) => ({ x: p.x + q.x / building.polygon.length, y: p.y + q.y / building.polygon.length }), { x: 0, y: 0 })
      expect(surveyDevelopmentSite({ elevation, slope: () => 0 }, point, building.polygon).viable).toBe(true)
    }
  })
})
