import { describe, expect, it } from 'vitest'
import { developLand } from './land-development'
import { pointInPolygon, polygonArea, polygonsOverlap } from './geometry'
import type { CityConfig, Road } from './types'

// The street supply is deliberately identical in each comparison. These checks
// isolate market/stock behavior from the separate terrain and road simulations.
const config: CityConfig = { name: '検証市', seed: 'review', type: 'castle', terrain: 'plain', density: 65, forest: 0, railway: true, stations: 1, arterial: false, facilities: [], era: 'present' }
const roads: Road[] = []
for (let y = 500; y <= 2500; y += 100) roads.push({ id: `h${y}`, points: Array.from({ length: 21 }, (_, i) => ({ x: 1000 + i * 100, y })), kind: 'local', width: 6, builtYear: 1650, role: 'lane' })
for (let x = 1000; x <= 3000; x += 100) roads.push({ id: `v${x}`, points: Array.from({ length: 21 }, (_, i) => ({ x, y: 500 + i * 100 })), kind: 'local', width: 6, builtYear: 1650, role: 'lane' })
const station = { id: 's', name: '検証駅', point: { x: 2000, y: 1500 } }
const run = (grade = 0, era: CityConfig['era'] = 'present', futureStation = true) => developLand({ config: { ...config, era }, roads, center: { x: 2000, y: 1500 }, stations: futureStation ? [station] : [], canPlace: () => true, slope: () => grade })
const historic = run(0, 'historic')
const flat = run()

describe('land market and surviving historic stock regressions', () => {
  it('does not lose most housing on a gentle grade when physical lot supply is unchanged', () => {
    const gentlySloping = run(.033)
    // Market choices may differ; the same acquired holding must still have the
    // same physical title. Unchosen frontage options are no longer saved lots.
    const flatTitles = new Map(flat.parcels.map(parcel => [parcel.id, parcel]))
    for (const parcel of gentlySloping.parcels) if (flatTitles.has(parcel.id)) expect(parcel.polygon).toEqual(flatTitles.get(parcel.id)!.polygon)
    // A 3.3% grade may lower value; it must not reproduce the old 74% collapse.
    expect(gentlySloping.snapshots.at(-1)!.capacity).toBeGreaterThan(flat.snapshots.at(-1)!.capacity * .8)
    expect(gentlySloping.buildings.some(b => (b.builtYear ?? 0) > 1960)).toBe(true)
  })
  it('uses housing shortage to rebuild old station lots with explicit history', () => {
    const acquisitions = flat.events.filter(event => event.id.startsWith('redevelop-acquire-'))
    expect(acquisitions.length).toBeGreaterThan(0)
    for (const acquisition of acquisitions) {
      const previous = flat.history.buildings.find(version => version.value.id === acquisition.entityId)!, old = previous.value
      const next = flat.history.buildings.find(version => version.from === acquisition.year && version.value.parcelId === old.parcelId)!, replacement = next.value
      expect(acquisition.year).toBeGreaterThanOrEqual(1960)
      expect(previous.to).toBe(acquisition.year)
      expect(acquisition.year - old.builtYear!).toBeGreaterThanOrEqual(35)
      expect(replacement.id).not.toBe(old.id)
      const originalParcel = flat.history.parcels.find(version => version.value.id === old.parcelId)!.value
      const currentParcel = flat.history.parcels.find(version => version.value.id === old.parcelId && version.from <= acquisition.year && (version.to === undefined || acquisition.year < version.to))!.value
      expect(currentParcel.polygon).toEqual(originalParcel.polygon)
      expect(currentParcel.createdYear).toBe(originalParcel.createdYear)
      expect(replacement.polygon.every(p => pointInPolygon(p, currentParcel.polygon))).toBe(true)
      expect(replacement.kind).toBe('residential')
      expect(currentParcel.use).toBe('residential')
      // The project supplies real dwellings, including conversion from a shop
      // whose upper floor need not become taller. Shared space is still paid
      // from its actual floor area rather than assigning units to a label.
      expect(replacement.height * 2).toBeGreaterThan(1)
      expect(polygonArea(replacement.polygon) * replacement.height).toBeGreaterThanOrEqual(replacement.height * 2 * 90)
      expect(replacement.builtYear).toBe(acquisition.year)
      expect(flat.events.some(event => event.kind === 'construction' && event.entityId === replacement.id && event.year === acquisition.year)).toBe(true)
    }
    expect(flat.snapshots.at(-1)!.capacity).toBeGreaterThan(flat.buildings.length)
  })
  it('buys a real larger modern holding beside an old road instead of freezing every future dwelling to its old house option', () => {
    const assembled = flat.parcels.filter(parcel => parcel.id.startsWith('housing-'))
    expect(assembled.length).toBeGreaterThan(0)
    const roadIds = new Map(roads.map(road => [road.id, road]))
    for (const parcel of assembled) {
      expect(roadIds.get(parcel.roadId)?.builtYear).toBe(1650)
      expect(parcel.createdYear).toBeGreaterThanOrEqual(1955)
      expect(polygonArea(parcel.polygon)).toBeGreaterThanOrEqual(850)
      expect(historic.parcels.some(old => old.id === parcel.id)).toBe(false)
      const first = flat.history.parcels.find(version => version.value.id === parcel.id)!
      expect(first.from).toBe(parcel.createdYear)
      expect(flat.events.some(event => event.id === `title-acquisition-${parcel.id}` && event.year === first.from)).toBe(true)
      const building = flat.buildings.find(building => building.parcelId === parcel.id)!
      expect(building.height).toBeGreaterThanOrEqual(3)
      expect(building.polygon.every(point => pointInPolygon(point, parcel.polygon))).toBe(true)
      expect(polygonArea(building.polygon)).toBeGreaterThan(polygonArea(parcel.polygon) * .6)
      for (const other of flat.parcels) if (other.id !== parcel.id && !other.retiredYear) expect(polygonsOverlap(parcel.polygon, other.polygon)).toBe(false)
    }
  })
  it('keeps old buildings and parcel geometry unless an acquisition records their replacement', () => {
    for (const old of historic.buildings) {
      const surviving = flat.buildings.find(building => building.id === old.id)
      if (surviving) {
        // Occupants can move into a surviving historic house; its physical
        // structure and provenance must remain unchanged without acquisition.
        const structure = ({ occupancy: _occupancy, occupiedHouseholds: _households, ...building }: typeof old) => building
        expect(structure(surviving)).toEqual(structure(old))
      }
      else expect(flat.events.some(event => event.kind === 'acquisition' && event.entityId === old.id)).toBe(true)
      const oldParcel = historic.parcels.find(p => p.id === old.parcelId)!
      const currentParcel = flat.parcels.find(p => p.id === old.parcelId)!
      expect(currentParcel.polygon).toEqual(oldParcel.polygon)
      expect(currentParcel.createdYear).toBe(oldParcel.createdYear)
    }
  })
  it('does not let a future station change historic development', () => {
    const withoutRailway = run(0, 'historic', false)
    expect(historic.buildings).toEqual(withoutRailway.buildings)
    expect(historic.parcels).toEqual(withoutRailway.parcels)
    expect(historic.snapshots).toEqual(withoutRailway.snapshots)
  })
})
