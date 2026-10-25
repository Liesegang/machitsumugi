import { describe, expect, it } from 'vitest'
import { scenarioDemandAtYear, simulateUrbanGrowth } from './urban-growth'
import { developLand } from './land-development'
import { simulationYears } from './simulation-calendar'
import type { CityConfig, Road } from './types'

describe('settlement scale and demographic history', () => {
  it('calibrates regional urban demand while preserving rural, metropolitan and historical scales', () => {
    const input = { type: 'castle' as const, density: 65 }
    expect(scenarioDemandAtYear(input, 2025).households).toBe(15668)
    expect(scenarioDemandAtYear(input, 1800).households).toBe(880)
    expect(scenarioDemandAtYear(input, 1950).households).toBe(2700)
    expect(scenarioDemandAtYear({ ...input, settlement: 'village' }, 2025).households).toBe(136)
    expect(scenarioDemandAtYear({ ...input, settlement: 'rural-town' }, 2025).households).toBe(1651)
    expect(scenarioDemandAtYear({ ...input, settlement: 'metropolis' }, 2025).households).toBeGreaterThan(20000)
    const metropolitanCrop = scenarioDemandAtYear({ type: 'post', density: 85, settlement: 'metropolis' }, 2025)
    // A4×3km major-city demand is below Tokyo's2020 household density, and
    // above the old23k-household regional-scale crop. This is a demand target,
    // never permission to exceed the physical housing/road/terrain capacity.
    expect(metropolitanCrop.households).toBeGreaterThan(80000)
    expect(metropolitanCrop.households).toBeLessThan(100000)
    expect(scenarioDemandAtYear({ ...input, mapSize: 'large' }, 2025).households).toBeGreaterThan(20000)
    expect(scenarioDemandAtYear({ ...input, mapSize: 'large', settlement: 'village' }, 2025)).toEqual(scenarioDemandAtYear({ ...input, settlement: 'village' }, 2025))
    expect(scenarioDemandAtYear({ ...input, populationTrend: 'stable' }, 2025)).toEqual(scenarioDemandAtYear({ ...input, populationTrend: 'stable' }, 1985))
    const decline = { ...input, settlement: 'village' as const, populationTrend: 'declining' as const }
    expect(scenarioDemandAtYear(decline, 2025).households).toBeLessThan(scenarioDemandAtYear(decline, 1960).households)
    expect(scenarioDemandAtYear(decline, 1930)).toEqual(scenarioDemandAtYear({ ...decline, populationTrend: 'growing' }, 1930))
  })

  it('retains acquired land and dated stock while declining demand creates vacancy and eventual old-building clearance', () => {
    const config = { name: '山里', seed: 'vacancy-17', type: 'post', terrain: 'plain', density: 65, forest: 0, railway: false, stations: 1, arterial: false, facilities: [], era: 'present', settlement: 'village', populationTrend: 'declining' } as CityConfig
    const roads: Road[] = [{ id: 'old-valley', points: [{ x: 200, y: 500 }, { x: 1600, y: 500 }], kind: 'local', role: 'lane', width: 4.5, builtYear: 1650 }]
    const result = developLand({ config, roads, center: { x: 900, y: 500 }, stations: [], canPlace: () => true, slope: () => 0 })
    const final = result.snapshots.at(-1)!, peak = result.snapshots.reduce((a, b) => a.households > b.households ? a : b)
    expect(final.households).toBeLessThan(peak.households)
    expect(final.buildings).toBeGreaterThan(0)
    const clearedAfterPeak = result.history.buildings.filter(version => version.to !== undefined && version.to > peak.year)
    expect(clearedAfterPeak.length).toBeGreaterThan(0)
    for (const version of clearedAfterPeak) {
      expect(version.value.builtYear).toBeLessThan(version.to!)
      expect(result.events.some(event => event.kind === 'acquisition' && event.entityId === version.value.id && event.year === version.to)).toBe(true)
      expect(result.parcels.some(parcel => parcel.id === version.value.parcelId)).toBe(true)
    }
    expect(final.vacant).toBeGreaterThan(0)
    expect(result.buildings.some(building => (building as unknown as { occupancy: string }).occupancy === 'vacant')).toBe(true)
    // Potential frontages are no longer pre-owned titles. Initial residential
    // purchases are now recorded; declining demand must still retain that
    // physical stock rather than buying/clearing additional land after the
    // scenario's demographic peak (occupied stock can plateau earlier).
    const acquisitions = result.events.filter(event => event.id.startsWith('title-acquisition-'))
    expect(acquisitions.length).toBeGreaterThan(0)
    const demandPeak = simulationYears(2025).reduce((a, b) => scenarioDemandAtYear(config, a).households > scenarioDemandAtYear(config, b).households ? a : b)
    expect(acquisitions.every(event => event.year <= demandPeak)).toBe(true)
    for (const event of acquisitions) expect(result.parcels.some(parcel => parcel.id === event.entityId && parcel.createdYear === event.year)).toBe(true)
  })

  it('scales inherited road standards and keeps a small village out of metropolitan road investment', () => {
    const growth = simulateUrbanGrowth({ width: 1800, height: 1400, center: { x: 900, y: 700 }, core: null, areas: [], seed: 'village-roads-21', type: 'post', density: 65, arterial: true, railway: false, stationPoints: [], settlement: 'village', populationTrend: 'declining' })
    expect(growth.roads.length).toBeGreaterThan(0)
    expect(growth.roads.filter(road => road.builtYear === 1650).every(road => road.width <= 4.5)).toBe(true)
    expect(growth.roads.some(road => road.role === 'highway')).toBe(false)
    expect(growth.demandSchedule.at(-1)!.households).toBeLessThan(35)
  })

  it('keeps direct building frontages off the motorway and its controlled slip roads', () => {
    const config = { name: '広域', seed: 'motorway-frontage', type: 'castle', terrain: 'plain', density: 65, forest: 0, railway: false, stations: 1, arterial: true, facilities: [], settlement: 'metropolis' } as CityConfig
    const roads: Road[] = [{ id: 'modern-mainline', points: [{ x: 200, y: 500 }, { x: 1600, y: 500 }], kind: 'arterial', role: 'expressway', controlledAccess: true, level: 1, width: 22, builtYear: 1965 }, { id: 'ramp', points: [{ x: 400, y: 800 }, { x: 700, y: 500 }], kind: 'local', role: 'ramp', controlledAccess: true, level: 1, width: 7, builtYear: 1965 }]
    const result = developLand({ config, roads, center: { x: 900, y: 500 }, stations: [], canPlace: () => true, slope: () => 0 })
    expect(result.parcels).toEqual([])
    expect(result.buildings).toEqual([])
  })
})
