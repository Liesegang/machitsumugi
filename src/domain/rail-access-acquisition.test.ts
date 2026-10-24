import { describe, expect, it } from 'vitest'
import { acquireRailSeveredHoldings } from './rail-access-acquisition'
import { retainCivicAccess } from './civic-access-retention'
import { rectangle } from './geometry'
import { createCityTimeline, sliceCityAtYear } from './timeline'
import type { Building, CityMap, Parcel, Road } from './types'

function fixture() {
  const access: Road = { id: 'facility-access-school', role: 'access', kind: 'local', width: 3.5, builtYear: 1880, points: [{ x: 100, y: 100 }, { x: 100, y: 200 }] }
  const street: Road = { id: 'public', kind: 'local', width: 6, builtYear: 1800, points: [{ x: 0, y: 100 }, { x: 300, y: 100 }] }
  const parcel: Parcel = { id: 'holding', polygon: rectangle(105, 155, 20, 10), entrance: { x: 105, y: 160 }, roadId: access.id, createdYear: 1900, developedYear: 1900, use: 'residential' }
  const house: Building = { id: 'house', parcelId: parcel.id, kind: 'residential', height: 2, builtYear: 1900, polygon: rectangle(110, 157, 8, 6), occupancy: 'occupied', occupiedHouseholds: 1 }
  const replacement: Building = { ...house, id: 'replacement', builtYear: 2000, height: 4, occupiedHouseholds: 8 }
  const map: CityMap = { width: 300, height: 300, year: 2025, config: { name: '市', seed: 'severance', type: 'castle', terrain: 'plain', density: 50, forest: 0, railway: true, stations: 0, arterial: false, facilities: [] }, description: '',
    roads: [street], parcels: [parcel], buildings: [replacement], areas: [], railways: [{ id: 'rail', name: '線', builtYear: 1950, points: [{ x: 0, y: 120 }, { x: 300, y: 120 }] }], stations: [], districts: [], facilities: [],
    events: [{ id: 'old-build', year: 1900, kind: 'construction', entityId: house.id, reason: '建築' }, { id: 'future-build', year: 2000, kind: 'construction', entityId: replacement.id, reason: '建替え' }],
    snapshots: [1945, 1950, 2025].map(year => ({ year, households: 10, capacity: year < 2000 ? 1 : 8, vacant: 0, unmet: year < 2000 ? 9 : 2, roads: 1, buildings: 1 })) }
  map.timeline = createCityTimeline(map, { roads: [{ from: 1800, value: street }, { from: 1880, to: 1950, value: access }],
    buildings: [{ from: 1900, to: 2000, value: house }, { from: 2000, value: replacement }], buildingStates: [{ id: house.id, from: 1900, occupancy: 'occupied', occupiedHouseholds: 1 }, { id: replacement.id, from: 2000, occupancy: 'occupied', occupiedHouseholds: 8 }] })
  return map
}
const problem = { roadId: 'facility-access-school', year: 1950, parcelIds: ['holding'], reason: 'rail' }

describe('explicit fictional railway severance acquisition', () => {
  it('acquires a footprint-clear holding whose sole existing paving is taken, preserving all earlier history', () => {
    const map = fixture(), before = JSON.stringify(map), result = acquireRailSeveredHoldings(map, [problem]), after = result.map
    expect(result.acquisitions).toEqual([{ parcelId: 'holding', roadId: problem.roadId, railwayId: 'rail', year: 1950, buildingIds: ['house', 'replacement'] }])
    expect(JSON.stringify(map)).toBe(before)
    expect({ ...sliceCityAtYear(after, 1945), timeline: undefined }).toEqual({ ...sliceCityAtYear(map, 1945), timeline: undefined })
    expect(after.timeline!.parcels).toEqual([{ ...map.timeline!.parcels[0]!, to: 1950 }])
    expect(after.timeline!.buildings).toEqual([{ ...map.timeline!.buildings[0]!, to: 1950 }])
    expect(after.timeline!.buildingStates).toEqual([map.timeline!.buildingStates[0]])
    expect(after.parcels).toEqual([]); expect(after.buildings).toEqual([])
    expect(after.areas[0]).toMatchObject({ name: '鉄道事業・接道喪失に伴う取得地', polygon: map.parcels![0]!.polygon })
    expect(after.events!.some(e => e.id === 'future-build')).toBe(false)
    expect(after.events!.at(-1)).toMatchObject({ year: 1950, kind: 'acquisition', entityId: 'holding', reason: '線の開通に伴い既設通路を鉄道用地に取得。代替の公道接面がない敷地を併せて取得。' })
    expect(after.snapshots).toEqual([map.snapshots![0], ...map.snapshots!.slice(1).map(s => ({ ...s, capacity: 0, unmet: 10, buildings: 0 }))])
    expect(retainCivicAccess(after).unresolved).toEqual([])
  })

  it('does not acquire a holding with another real public frontage', () => {
    const map = fixture(), alternative: Road = { id: 'alternative', kind: 'local', width: 6, builtYear: 1950, points: [{ x: 127, y: 140 }, { x: 127, y: 180 }] }
    map.timeline!.roads.push({ from: 1950, value: alternative }); map.roads.push(alternative)
    expect(acquireRailSeveredHoldings(map, [problem])).toEqual({ map, acquisitions: [] })
  })

  it('requires a newly opening railway and actual paving acquisition, not an arbitrary later civic or private conflict', () => {
    for (const mode of ['older-rail', 'clear-access', 'subway'] as const) {
      const map = fixture(), rail = map.timeline!.railways[0]!
      if (mode === 'older-rail') rail.from = 1945
      else if (mode === 'clear-access') rail.value.points = [{ x: 0, y: 250 }, { x: 300, y: 250 }]
      else rail.value.mode = 'subway'
      expect(acquireRailSeveredHoldings(map, [problem])).toEqual({ map, acquisitions: [] })
    }
  })

  it('does not count lodging/industrial stock as household capacity', () => {
    const map = fixture()
    map.timeline!.buildings = map.timeline!.buildings.map(v => ({ ...v, value: { ...v.value, kind: 'commercial', use: 'lodging' } }))
    map.snapshots = map.snapshots!.map(s => ({ ...s, capacity: 0, unmet: 10 })); map.timeline!.snapshots = map.snapshots
    const after = acquireRailSeveredHoldings(map, [problem]).map
    expect(after.snapshots!.every(s => s.capacity === 0 && s.unmet === 10)).toBe(true)
  })

  it('keeps a recorded private access reaching a real alternative street outside the title', () => {
    const map = fixture(), parcel = map.timeline!.parcels[0]!.value
    parcel.access = [{ x: 105, y: 160 }, { x: 105, y: 170 }, { x: 180, y: 170 }]
    map.timeline!.roads.push({ from: 1950, value: { id: 'alternative', kind: 'local', width: 6, points: [{ x: 180, y: 140 }, { x: 180, y: 200 }] } })
    expect(acquireRailSeveredHoldings(map, [problem])).toEqual({ map, acquisitions: [] })
  })

  it('preserves paving beneath a surveyed railway bridge and never assumes unknown bridge clearance means acquisition', () => {
    for (const surveyed of [true, false]) {
      const map = fixture(), rail = map.timeline!.railways[0]!.value
      rail.structures = [{ kind: 'bridge', from: rail.points[0]!, to: rail.points[1]!, maxHeight: 10 }]
      if (surveyed) {
        rail.elevations = [10, 10]
        map.timeline!.terrainSurfaces = [{ from: 1650, value: { columns: 4, rows: 4, cellSize: 100, elevations: new Array(16).fill(0) } }]
        const retention = retainCivicAccess(map)
        expect(retention.unresolved).toEqual([])
        expect(retention.map.roads.some(r => r.id === problem.roadId)).toBe(true)
      }
      expect(acquireRailSeveredHoldings(map, [problem])).toEqual({ map, acquisitions: [] })
    }
  })

  it('requires actual full-width severance, not a narrow rail-land nibble of one paved shoulder', () => {
    const map = fixture()
    map.timeline!.railways[0]!.value.points = [{ x: 108, y: 0 }, { x: 108, y: 300 }]
    expect(acquireRailSeveredHoldings(map, [problem])).toEqual({ map, acquisitions: [] })
  })
})
