import { describe, expect, it } from 'vitest'
import { developLand } from './land-development'
import type { CityConfig, Road } from './types'
import { pointInPolygon, polygonsOverlap, rectangle } from './geometry'

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
  it('uses surveyed rear gardens on old streets for later infill without moving the old houses', () => {
    const oldStreet: Road[] = [{ ...roads[0]!, id: 'old-deep-holdings', points: [{ x: 300, y: 500 }, { x: 1600, y: 500 }] }]
    const c = { ...config, density: 100 }
    const historic = run({ ...c, era: 'historic' }, oldStreet)
    const current = run(c, oldStreet)
    const infill = current.buildings.filter(b => current.events.some(event => event.kind === 'acquisition' && event.entityId === b.parcelId && event.id.startsWith('infill-acquire-')))
    expect(infill.length).toBeGreaterThan(0)
    for (const building of infill) {
      const parcel = current.parcels.find(p => p.id === building.parcelId)!
      expect(building.builtYear).toBeGreaterThanOrEqual(1955)
      const parent = current.parcels.find(p => `${p.id}-rear` === parcel.id)!
      expect(parent).toBeTruthy()
      expect(parcel.createdYear).toBe(parent.createdYear)
      expect(parcel.createdYear).toBeLessThan(1955)
      expect(parcel.access![0].y).toBe(500)
      expect(building.polygon.every(point => pointInPolygon(point, parcel.polygon))).toBe(true)
      expect(historic.buildings.some(b => b.parcelId === parcel.id)).toBe(false)
      if (parcel.createdYear <= 1800) expect(historic.parcels.find(p => p.id === parcel.id)!.polygon).toEqual(parcel.polygon)
      else expect(historic.parcels.find(p => p.id === parcel.id)).toBeUndefined()
    }
    for (const old of historic.buildings) {
      const surviving = current.buildings.find(b => b.id === old.id)
      if (surviving) expect(surviving.polygon).toEqual(old.polygon)
      expect(current.parcels.find(p => p.id === old.parcelId)!.polygon).toEqual(historic.parcels.find(p => p.id === old.parcelId)!.polygon)
    }
    for (let i = 0; i < current.parcels.length; i++) for (let j = i + 1; j < current.parcels.length; j++) expect(polygonsOverlap(current.parcels[i]!.polygon, current.parcels[j]!.polygon)).toBe(false)
  })
  it('rejects old-street infill when its private entrance is later obstructed', () => {
    const street: Road[] = [{ ...roads[0]!, id: 'old-deep-holdings', points: [{ x: 300, y: 500 }, { x: 1600, y: 500 }] }]
    const c = { ...config, density: 100 }, open = run(c, street)
    const building = open.buildings.find(b => open.events.some(event => event.id.startsWith('infill-acquire-') && event.entityId === b.parcelId))!
    const parcel = open.parcels.find(p => p.id === building.parcelId)!
    const entrance = parcel.access![1], obstruction = rectangle(entrance.x - .5, (parcel.access![0].y + entrance.y) / 2 - .5, 1, 1)
    // The rear building pad remains clear. Only the narrow street connection
    // is taken; checking the footprint alone would create an inaccessible home.
    expect(polygonsOverlap(building.polygon, obstruction)).toBe(false)
    const closed = developLand({ config: c, roads: street, center: { x: 600, y: 500 }, stations: [{ id: 'station', point: { x: 1000, y: 1200 }, name: '試験駅' }], slope: () => 0, canPlace: (polygon, year) => year < 1955 || !polygonsOverlap(polygon, obstruction) })
    expect(closed.buildings.some(b => b.parcelId === parcel.id)).toBe(false)
    expect(closed.events.some(event => event.id.startsWith('infill-acquire-') && event.entityId === parcel.id)).toBe(false)
  })
  it('keeps construction events and saved times consistent', () => {
    const result = run()
    expect(run()).toEqual(result)
    expect(result.snapshots.at(-1)!.year).toBe(2025)
    for (const b of result.buildings) expect(result.events.some(e => e.entityId === b.id && e.year === b.builtYear)).toBe(true)
    for (const snapshot of result.snapshots) expect(snapshot.vacant - snapshot.unmet).toBe(snapshot.capacity - snapshot.households)
  })
  it('acquires actual homes and their old gardens instead of publishing empty lots along every rural road', () => {
    const longRoad: Road = { id: 'rural-through-road', points: [{ x: 100, y: 500 }, { x: 4300, y: 500 }], role: 'lane', kind: 'local', width: 4.5, builtYear: 1650 }
    const result = developLand({ config: { ...config, type: 'post', settlement: 'village', density: 15, railway: false }, roads: [longRoad], center: { x: 500, y: 500 }, stations: [], canPlace: () => true, slope: () => 0 })
    expect(result.buildings.length).toBeGreaterThan(0)
    expect(result.parcels.filter(p => p.polygon.every(point => point.x > 2800))).toEqual([])
    for (const parcel of result.parcels) {
      const acquired = result.events.find(event => event.id === `title-acquisition-${parcel.id}`)!
      expect(acquired?.year).toBe(parcel.createdYear)
      expect(result.history.parcels.filter(version => version.value.id === parcel.id).every(version => version.from >= acquired.year)).toBe(true)
      // Unbuilt old garden titles must belong to a real acquired parent home.
      if (!result.history.buildings.some(version => version.value.parcelId === parcel.id)) {
        expect(parcel.id.endsWith('-rear')).toBe(true)
        expect(result.history.buildings.some(version => `${version.value.parcelId}-rear` === parcel.id)).toBe(true)
      }
    }
  })
  it('gives each rebuilt physical structure a new identity while keeping the same parcel and unique events', () => {
    const result = developLand({ config, roads, center: { x: 600, y: 500 }, stations: [], canPlace: (_polygon, year) => year !== 1955, slope: () => 0 })
    expect(new Set(result.events.map(event => event.id)).size).toBe(result.events.length)
    const constructed = result.events.filter(event => event.kind === 'construction')
    expect(new Set(constructed.map(event => event.entityId)).size).toBe(constructed.length)
    const cleared = result.history.buildings.filter(version => version.to === 1955)
    expect(cleared.length).toBeGreaterThan(0)
    for (const old of cleared) {
      const replacement = result.history.buildings.find(version => version.from >= 1960 && version.value.parcelId === old.value.parcelId)
      if (!replacement) continue
      expect(replacement.value.id).not.toBe(old.value.id)
      expect(replacement.value.builtYear).toBe(replacement.from)
      expect(old.value.builtYear).toBeLessThan(1955)
      expect(result.parcels.find(parcel => parcel.id === old.value.parcelId)!.createdYear).toBeLessThan(1955)
    }
    expect(cleared.some(old => result.history.buildings.some(next => next.value.parcelId === old.value.parcelId && next.from >= 1960))).toBe(true)
    expect(result.events.some(event => event.kind === 'acquisition' && event.year === 1955)).toBe(true)
  })
})
