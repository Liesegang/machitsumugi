import { describe, expect, it } from 'vitest'
import { retainCivicAccess } from './civic-access-retention'
import { createCityTimeline, sliceCityAtYear } from './timeline'
import { rectangle } from './geometry'
import type { Building, CityMap, Parcel, Road, TimelineVersion } from './types'

const driveway: Road = { id: 'facility-access-school', points: [{ x: 100, y: 100 }, { x: 100, y: 200 }], width: 3.5, kind: 'local', role: 'access', builtYear: 1880, reason: '学校への接道' }
const street: Road = { id: 'street', points: [{ x: 0, y: 100 }, { x: 300, y: 100 }], width: 6, kind: 'local', builtYear: 1800 }
const parcel = (id: string, y: number): Parcel => ({ id, polygon: rectangle(105, y - 5, 20, 10), entrance: { x: 105, y }, roadId: driveway.id, createdYear: 1900, developedYear: 1900, use: 'residential' })
const house = (p: Parcel): Building => ({ id: `house-${p.id}`, parcelId: p.id, polygon: rectangle(110, p.entrance.y - 3, 8, 6), kind: 'residential', height: 2, builtYear: 1900 })
function fixture(): CityMap {
  const parcels = [parcel('near', 130), parcel('far', 160)], buildings = parcels.map(house)
  const map: CityMap = { width: 300, height: 300, year: 2025, config: { seed: 'access', name: '市', type: 'castle', terrain: 'plain', density: 50, forest: 0, railway: false, stations: 0, arterial: false, facilities: [] }, description: '',
    roads: [street], buildings, parcels, areas: [{ id: 'new-school-yard', kind: 'park', polygon: rectangle(90, 180, 40, 30) }], railways: [], stations: [], facilities: [], districts: [],
    events: [{ id: 'original-road', entityId: driveway.id, kind: 'road', year: 1880, reason: '学校への接道' }],
    snapshots: [1945, 1950, 1970, 2025].map(year => ({ year, households: 2, capacity: 2, vacant: 0, unmet: 0, roads: 1, buildings: 2 })) }
  map.timeline = createCityTimeline(map, { roads: [{ from: 1800, value: street }, { from: 1880, to: 1950, value: driveway }],
    areas: [{ from: 1950, value: map.areas[0]! }] })
  return map
}
const versions = (map: CityMap) => map.timeline!.roads.filter(v => v.value.id === driveway.id)

describe('dated reuse of surviving civic driveway frontages', () => {
  it('keeps only used paving after a campus moves, without changing land or rewriting its original road history', () => {
    const before = fixture(), serialized = JSON.stringify(before), result = retainCivicAccess(before), after = result.map
    expect(result.unresolved).toEqual([])
    expect(result.retained).toEqual([{ roadId: driveway.id, from: 1950, length: 60, parcelIds: ['near', 'far'], sourceRoadId: street.id }])
    expect(versions(after).map(v => [v.from, v.to, v.value.points])).toEqual([
      [1880, 1950, driveway.points], [1950, undefined, [{ x: 100, y: 100 }, { x: 100, y: 160 }]],
    ])
    expect(versions(after)[1]!.value.builtYear).toBe(1880)
    expect(after.roads[0]!.points).toEqual([{ x: 0, y: 100 }, { x: 100, y: 100 }, { x: 300, y: 100 }])
    for (const key of ['buildings', 'parcels', 'areas', 'railways', 'stations', 'facilities', 'districts', 'terrainSurface', 'growthLog'] as const) expect(after[key]).toBe(before[key])
    for (const key of ['buildings', 'parcels', 'areas', 'buildingStates', 'terrainSurfaces', 'growthLog'] as const) expect(after.timeline![key]).toBe(before.timeline![key])
    expect(JSON.stringify(before)).toBe(serialized)
    expect(after.events![0]).toBe(before.events![0])
    expect(after.events!.at(-1)).toMatchObject({ year: 1950, kind: 'road', entityId: driveway.id })
    expect(after.snapshots!.map(s => s.roads)).toEqual([2, 2, 2, 2])
    expect(after.snapshots!.map(s => ({ ...s, roads: 0 }))).toEqual(before.snapshots!.map(s => ({ ...s, roads: 0 })))
    expect(retainCivicAccess(after).map).toBe(after)
  })

  it('uses real active midspan contacts with reversed driveway order and discards the acquired campus tail', () => {
    const map = fixture(), crossing: Road = { ...street, id: 'later-street', points: [{ x: 0, y: 150 }, { x: 300, y: 150 }], builtYear: 1950 }
    map.roads = [crossing]
    map.timeline!.roads = [{ from: 1800, to: 1950, value: street }, { from: 1880, to: 1950, value: { ...driveway, points: [...driveway.points].reverse() } }, { from: 1950, value: crossing }]
    const result = retainCivicAccess(map)
    expect(result.unresolved).toEqual([])
    expect(versions(result.map)[1]!.value.points).toEqual([{ x: 100, y: 160 }, { x: 100, y: 150 }, { x: 100, y: 130 }])
    expect(result.retained[0]).toMatchObject({ length: 30, sourceRoadId: crossing.id })
    expect(result.map.roads.find(r => r.id === crossing.id)!.points).toContainEqual({ x: 100, y: 150 })
  })

  it('shrinks actual service when a property ends, and retires unused paving without later resurrection', () => {
    const map = fixture()
    map.timeline!.buildings = map.timeline!.buildings.map(v => ({ ...v, to: v.value.parcelId === 'far' ? 1970 : 1980 }))
    const future: TimelineVersion<Building> = { from: 1990, value: { ...map.buildings[0]!, id: 'future-house', builtYear: 1990 } }
    map.timeline!.buildings.push(future)
    const result = retainCivicAccess(map)
    expect(versions(result.map).map(v => [v.from, v.to, v.value.points.at(-1)!.y])).toEqual([[1880, 1950, 200], [1950, 1970, 160], [1970, 1980, 130]])
    expect(sliceCityAtYear(result.map, 1975).roads).toHaveLength(2)
    expect(sliceCityAtYear(result.map, 1980).roads).toHaveLength(1)
    expect(result.map.roads).toHaveLength(1)
  })

  it('does not keep an unused driveway or undeveloped title merely because a parcel once faced it', () => {
    const map = fixture(); map.buildings = []; map.timeline!.buildings = []
    expect(retainCivicAccess(map)).toEqual({ map, retained: [], unresolved: [] })
  })

  it.each(['water', 'park', 'building', 'railway'] as const)('refuses %s acquisition across required original paving', kind => {
    const map = fixture()
    if (kind === 'building') map.timeline!.buildings.push({ from: 1950, value: { id: 'new-school', kind: 'public', polygon: rectangle(95, 120, 10, 5), height: 3, builtYear: 1950 } })
    else if (kind === 'railway') map.timeline!.railways.push({ from: 1950, value: { id: 'new-rail', name: '線', builtYear: 1950, points: [{ x: 0, y: 120 }, { x: 300, y: 120 }] } })
    else map.timeline!.areas.push({ from: 1950, value: { id: 'acquired', kind, polygon: rectangle(95, 120, 10, 5) } })
    const result = retainCivicAccess(map)
    expect(result.retained).toEqual([])
    expect(result.unresolved).toHaveLength(1)
    expect(result.unresolved[0]).toMatchObject({ roadId: driveway.id, year: 1950, parcelIds: ['near', 'far'] })
    expect(result.map).toBe(map)
  })

  it('validates later land use too and never extends an interval beyond a physical acquisition', () => {
    const map = fixture()
    map.timeline!.areas.push({ from: 1975, value: { id: 'later-school', kind: 'park', polygon: rectangle(95, 120, 10, 5) } })
    const result = retainCivicAccess(map)
    expect(versions(result.map).at(-1)!.to).toBe(1975)
    expect(result.unresolved[0]).toMatchObject({ year: 1975, reason: expect.stringContaining('later-school') })
  })

  it('keeps a child driveway connected when its parent is adopted in a later year', () => {
    const map = fixture(), parent: Road = { ...street, id: 'facility-access-park', role: 'access' }, publicStreet: Road = { ...street, id: 'public-street', points: [{ x: 0, y: 0 }, { x: 0, y: 300 }] }
    const parentParcel: Parcel = { ...parcel('parent', 105), polygon: rectangle(140, 105, 20, 20), entrance: { x: 150, y: 105 }, roadId: parent.id }
    map.timeline!.parcels.push({ from: 1900, value: parentParcel })
    map.timeline!.buildings.push({ from: 1900, value: { ...house(parentParcel), polygon: rectangle(145, 110, 10, 10) } })
    map.timeline!.roads = [{ from: 1800, value: publicStreet }, { from: 1800, to: 1970, value: parent }, { from: 1880, to: 1950, value: driveway }]
    const result = retainCivicAccess(map)
    expect(result.unresolved).toEqual([])
    for (const year of [1950, 1965, 1970, 2025]) expect(sliceCityAtYear(result.map, year).roads.some(r => r.id === driveway.id)).toBe(true)
    expect(result.map.roads.find(r => r.id === parent.id)!.points).toContainEqual({ x: 100, y: 100 })
  })

  it('retains a parent connector without direct houses while it serves another occupied driveway', () => {
    const map = fixture(), parent: Road = { ...street, id: 'facility-access-park', role: 'access' }, publicStreet: Road = { ...street, id: 'public-street', points: [{ x: 0, y: 0 }, { x: 0, y: 300 }] }
    map.timeline!.roads = [{ from: 1800, value: publicStreet }, { from: 1800, to: 1970, value: parent }, { from: 1880, to: 1950, value: driveway }]
    const result = retainCivicAccess(map)
    expect(result.unresolved).toEqual([])
    expect(result.map.roads.find(r => r.id === parent.id)!.points).toEqual([{ x: 0, y: 100 }, { x: 100, y: 100 }])
    expect(result.map.roads.find(r => r.id === driveway.id)).toBeDefined()
  })

  it('retains the parent before the still-active occupied child itself retires', () => {
    const map = fixture(), parent: Road = { ...street, id: 'facility-access-park', role: 'access' }, publicStreet: Road = { ...street, id: 'public-street', points: [{ x: 0, y: 0 }, { x: 0, y: 300 }] }
    map.timeline!.roads = [{ from: 1800, value: publicStreet }, { from: 1800, to: 1950, value: parent }, { from: 1880, to: 1970, value: driveway }]
    const result = retainCivicAccess(map)
    expect(result.unresolved).toEqual([])
    for (const year of [1950, 1965, 1970, 2025]) {
      const roads = sliceCityAtYear(result.map, year).roads
      expect(roads.some(r => r.id === parent.id)).toBe(true)
      expect(roads.some(r => r.id === driveway.id)).toBe(true)
    }
    expect(result.retained.find(r => r.roadId === parent.id)!.from).toBe(1950)
  })

  it('rejects a later private structure across already adopted paving', () => {
    const map = fixture()
    map.timeline!.buildings.push({ from: 1970, value: { ...house(parcel('new-title', 125)), polygon: rectangle(95, 120, 10, 10) } })
    const result = retainCivicAccess(map)
    expect(versions(result.map).at(-1)!.to).toBe(1970)
    expect(result.unresolved[0]).toMatchObject({ roadId: driveway.id, year: 1970 })
  })

  it('keeps a continuously adopted public prefix through a later private title whose building clears its paving', () => {
    const map = fixture(), newTitle: Parcel = { ...parcel('new-title', 125), createdYear: 1970, developedYear: 1970, polygon: rectangle(95, 118, 20, 12), roadId: 'street' }
    map.timeline!.parcels.push({ from: 1970, value: newTitle })
    map.timeline!.buildings.push({ from: 1970, value: { ...house(newTitle), polygon: rectangle(105, 119, 8, 8), builtYear: 1970 } })
    const before = JSON.stringify(map), result = retainCivicAccess(map)
    expect(result.unresolved).toEqual([])
    expect(versions(result.map).map(v => [v.from, v.to])).toEqual([[1880, 1950], [1950, undefined]])
    for (const year of [1950, 1969, 1970, 2025]) expect(sliceCityAtYear(result.map, year).roads.some(r => r.id === driveway.id)).toBe(true)
    expect(result.map.timeline!.parcels).toBe(map.timeline!.parcels)
    expect(result.map.timeline!.buildings).toBe(map.timeline!.buildings)
    expect(JSON.stringify(map)).toBe(before)
  })

  it('still refuses a new title taking retired paving before its first adoption', () => {
    const map = fixture()
    map.timeline!.parcels.push({ from: 1950, value: { ...parcel('new-title', 125), createdYear: 1950, developedYear: undefined, polygon: rectangle(95, 120, 10, 10), roadId: 'street' } })
    const result = retainCivicAccess(map)
    expect(result.retained).toEqual([])
    expect(result.unresolved[0]).toMatchObject({ roadId: driveway.id, year: 1950, reason: expect.stringContaining('new-title') })
  })

  it('canonically repairs a saved closed service interval without duplicating history or changing another adopted road', () => {
    const map = fixture(), other: Road = { ...driveway, id: 'facility-access-hospital', points: [{ x: 200, y: 100 }, { x: 200, y: 180 }] }
    const p: Parcel = { ...parcel('hospital-frontage', 140), polygon: rectangle(205, 135, 20, 10), entrance: { x: 205, y: 140 }, roadId: other.id }
    map.timeline!.roads.push({ from: 1880, to: 1950, value: other })
    map.timeline!.parcels.push({ from: 1900, value: p })
    map.timeline!.buildings.push({ from: 1900, value: { ...house(p), polygon: rectangle(210, 137, 8, 6) } })
    const complete = retainCivicAccess(map).map, saved = structuredClone(complete)
    saved.timeline!.roads = saved.timeline!.roads.map(v => v.value.id === driveway.id && v.from === 1950 ? { ...v, to: 1970 } : v)
    saved.roads = saved.roads.filter(r => r.id !== driveway.id)
    const before = JSON.stringify(saved), repaired = retainCivicAccess(saved)
    expect(repaired.unresolved).toEqual([])
    expect(repaired.map.timeline!.roads).toEqual(complete.timeline!.roads)
    expect(repaired.map.roads).toEqual(complete.roads)
    expect(repaired.map.timeline!.roads.filter(v => v.value.id === other.id)).toEqual(saved.timeline!.roads.filter(v => v.value.id === other.id))
    expect(repaired.map.events).toEqual(complete.events)
    expect(new Set(repaired.map.events!.map(e => e.id)).size).toBe(repaired.map.events!.length)
    expect(repaired.map.timeline!.events).toEqual(complete.timeline!.events)
    expect(retainCivicAccess(repaired.map).map).toBe(repaired.map)
    expect(JSON.stringify(saved)).toBe(before)
  })

  it('allows subway geometry while still honoring an optional exact physical survey', () => {
    const map = fixture()
    map.timeline!.railways.push({ from: 1950, value: { id: 'subway', name: '地下鉄', mode: 'subway', points: [{ x: 0, y: 120 }, { x: 300, y: 120 }] } })
    expect(retainCivicAccess(map).unresolved).toEqual([])
    const rejected = retainCivicAccess(map, (r, year) => r.points.length && year >= 1970 ? '地盤の取得' : undefined)
    expect(versions(rejected.map).at(-1)!.to).toBe(1970)
    expect(rejected.unresolved[0]!.reason).toBe('地盤の取得')
  })
})
