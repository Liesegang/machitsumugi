import { describe, expect, it } from 'vitest'
import type { Building, Station } from './types'
import { polygonsOverlap, rectangle } from './geometry'
import { surveyStationArchitecture } from './station-architecture'

const station: Station = { id: 'stop', point: { x: 100, y: 100 }, name: '駅' }
const base = { stations: [station], railways: [{ id: 'rail', name: '線', points: [{ x: 0, y: 100 }, { x: 200, y: 100 }], builtYear: 1900 }], roads: [], buildings: [], width: 200, height: 200, waterAt: () => false, slope: () => 0, elevation: () => 10 }

describe('station architecture land survey', () => {
  it('uses the opposite side when an existing house obstructs the preferred station lot', () => {
    const occupied = rectangle(65, 106, 70, 30), building: Building = { id: 'house', kind: 'residential', height: 2, polygon: occupied }
    const surveyed = surveyStationArchitecture({ ...base, buildings: [building] })[0]!
    expect(surveyed.buildingPolygon).toHaveLength(4)
    expect(polygonsOverlap(surveyed.buildingPolygon!, occupied)).toBe(false)
    expect(surveyed.entrance!.y).toBeLessThan(100)
  })
  it('does not put a decorative station house onto water, a road, or steep terrain', () => {
    for (const input of [{ ...base, waterAt: () => true }, { ...base, slope: () => .4 }, { ...base, roads: [{ id: 'street', width: 120, points: [{ x: 0, y: 100 }, { x: 200, y: 100 }], kind: 'arterial' as const }] }]) expect(surveyStationArchitecture(input)[0]!.buildingPolygon).toBeUndefined()
  })
  it('respects all overlapping historical building versions, but accepts a cleared pre-railway site', () => {
    const blocker: Building = { id: 'house', kind: 'residential', height: 2, polygon: rectangle(0, 105, 200, 95) }
    const earlier = surveyStationArchitecture({ ...base, buildingVersions: [{ from: 1700, to: 1890, value: blocker }] })[0]!
    expect(earlier.entrance!.y).toBeGreaterThan(100)
    const later = surveyStationArchitecture({ ...base, buildingVersions: [{ from: 1950, value: blocker }] })[0]!
    expect(later.entrance!.y).toBeLessThan(100)
  })
  it('keeps results deterministic and leaves source station objects untouched', () => {
    const before = JSON.stringify(base.stations), a = surveyStationArchitecture(base), b = surveyStationArchitecture(base)
    expect(a).toEqual(b); expect(JSON.stringify(base.stations)).toBe(before)
    expect(a[0]!.railwayId).toBe('rail')
  })
  it('places a subway stair by its served street rather than over the distant tunnel platform', () => {
    const surveyed = surveyStationArchitecture({ ...base, stations: [{ ...station, mode: 'subway', entrance: { x: 110, y: 35 } }], railways: [{ ...base.railways[0]!, mode: 'subway' }], roads: [{ id: 'street', kind: 'local', width: 10, points: [{ x: 0, y: 35 }, { x: 200, y: 35 }] }] })[0]!
    expect(surveyed.buildingPolygon).toHaveLength(4)
    const meanY = surveyed.buildingPolygon!.reduce((sum, p) => sum + p.y / 4, 0)
    expect(Math.abs(meanY - 35)).toBeCloseTo(7.7)
    expect(Math.abs(meanY - station.point.y)).toBeGreaterThan(50)
    expect(Math.abs(surveyed.entrance!.y - 35)).toBeCloseTo(6.2)
  })
})
