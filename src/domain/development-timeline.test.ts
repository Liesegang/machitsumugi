import { describe, expect, it } from 'vitest'
import { developLand } from './land-development'
import { scenarioDemandAtYear, simulateUrbanGrowth } from './urban-growth'
import type { CityConfig, Road } from './types'

const config: CityConfig = { name: '年代検証', seed: 'timeline-stock-31', type: 'castle', terrain: 'plain', density: 65, forest: 0, railway: true, stations: 1, arterial: false, facilities: [], era: 'present' }
const center = { x: 900, y: 700 }, station = { id: 's', name: '駅', point: center }
const roads: Road[] = []
for (let y = 400; y <= 1000; y += 100) roads.push({ id: `h${y}`, points: [{ x: 500, y }, { x: 900, y }, { x: 1300, y }], kind: 'local', width: 6, builtYear: 1650, role: 'lane' })
roads.push({ id: 'connector', points: [{ x: 900, y: 400 }, { x: 900, y: 700 }, { x: 900, y: 1000 }], kind: 'local', width: 6, builtYear: 1650, role: 'lane' })
const run = (targetYear: number, suppliedRoads = roads, stations = [station]) => developLand({ config: { ...config, targetYear }, roads: suppliedRoads, center, stations, canPlace: () => true, slope: () => 0 })
describe('as-of historical development', () => {
  it('has real founding homes and exact between-round demand without future parcels', () => {
    const founding = run(1650), beforeRail = run(1899, [...roads, { id: 'future', kind: 'local', width: 6, builtYear: 1955, points: [{ x: 500, y: 1200 }, { x: 1300, y: 1200 }] }])
    expect(founding.buildings.length).toBeGreaterThan(0)
    expect(founding.buildings.every(b => b.builtYear === 1650)).toBe(true)
    expect(beforeRail.parcels.some(parcel => parcel.roadId === 'future')).toBe(false)
    expect(beforeRail.events.every(event => event.year <= 1899)).toBe(true)
    expect(beforeRail.snapshots.at(-1)!.year).toBe(1899)
    expect(beforeRail.snapshots.at(-1)!.households).toBe(scenarioDemandAtYear(config, 1899).households)
    expect(beforeRail.buildings).toEqual(run(1899, roads, []).buildings)
  })
  it('restores old physical buildings by rerunning history and keeps between-round stock stable', () => {
    const before = run(1957), sameRound = run(1955), present = run(2025)
    const structure = (result: ReturnType<typeof run>) => result.buildings.map(({ occupancy: _occupancy, occupiedHouseholds: _occupants, ...building }) => building)
    expect(structure(before)).toEqual(structure(sameRound))
    const replaced = before.buildings.filter(old => present.events.some(event => event.kind === 'acquisition' && event.entityId === old.id))
    expect(replaced.length).toBeGreaterThan(0)
    for (const old of replaced) {
      expect(before.buildings.find(b => b.id === old.id)).toEqual(old)
      expect(present.buildings.some(b => b.id === old.id)).toBe(false)
      expect(present.buildings.find(b => b.parcelId === old.parcelId)!.builtYear).toBeGreaterThan(1957)
    }
    expect(before.snapshots.at(-1)!.year).toBe(1957)
    expect(before.events.every(event => event.year <= 1957)).toBe(true)
  })
  it('does not plan a future railway at1899 and opens it once at1900 despite an older era preset', () => {
    const input = { width: 1200, height: 1000, seed: 'timeline-rail', type: 'post' as const, center: { x: 600, y: 500 }, core: null, areas: [], arterial: false, railway: true, stationPoints: [], density: 0, era: 'historic' as const }
    const before = simulateUrbanGrowth({ ...input, targetYear: 1899, onRailwayPlanning: () => { throw new Error('future railway') } })
    let calls = 0
    const after = simulateUrbanGrowth({ ...input, targetYear: 1901, onRailwayPlanning: () => { calls++; return { stationPoints: [] } } })
    expect(calls).toBe(1)
    expect(before.demandSchedule.at(-1)!.year).toBe(1899)
    expect(after.demandSchedule.at(-1)!.year).toBe(1901)
    expect(before.roads.every(road => road.builtYear <= 1899)).toBe(true)
    expect(after.growthLog.at(-1)!.roadsAdded).toBe(0)
  })
})
