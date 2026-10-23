import { describe, expect, it } from 'vitest'
import { developLand } from './land-development'
import { scenarioDemandAtYear } from './urban-growth'
import { pointInPolygon } from './geometry'
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
    expect(gentlySloping.parcels.map(p => ({ id: p.id, polygon: p.polygon }))).toEqual(flat.parcels.map(p => ({ id: p.id, polygon: p.polygon })))
    // A 3.3% grade may lower value; it must not reproduce the old 74% collapse.
    expect(gentlySloping.snapshots.at(-1)!.capacity).toBeGreaterThan(flat.snapshots.at(-1)!.capacity * .8)
    expect(gentlySloping.buildings.some(b => (b.builtYear ?? 0) > 1960)).toBe(true)
  })
  it('uses housing shortage to rebuild old station lots with explicit history', () => {
    const acquired = historic.buildings.filter(old => flat.events.some(event => event.kind === 'acquisition' && event.entityId === old.id))
    expect(acquired.length).toBeGreaterThan(0)
    for (const old of acquired) {
      const acquisition = flat.events.find(event => event.kind === 'acquisition' && event.entityId === old.id)!
      const replacement = flat.buildings.find(building => building.parcelId === old.parcelId)!
      expect(acquisition.year).toBeGreaterThanOrEqual(1960)
      const previous = flat.snapshots.filter(snapshot => snapshot.year < acquisition.year).at(-1)!
      expect(scenarioDemandAtYear(config, acquisition.year).households).toBeGreaterThan(previous.capacity)
      expect(replacement.id).not.toBe(old.id)
      const originalParcel = historic.parcels.find(p => p.id === old.parcelId)!
      const currentParcel = flat.parcels.find(p => p.id === old.parcelId)!
      expect(currentParcel.polygon).toEqual(originalParcel.polygon)
      expect(replacement.polygon.every(p => pointInPolygon(p, currentParcel.polygon))).toBe(true)
      expect(replacement.height).toBeGreaterThan(old.height)
      expect(replacement.builtYear).toBe(acquisition.year)
      expect(flat.events.some(event => event.kind === 'construction' && event.entityId === replacement.id && event.year === acquisition.year)).toBe(true)
    }
    expect(flat.snapshots.at(-1)!.capacity).toBeGreaterThan(flat.buildings.length)
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
