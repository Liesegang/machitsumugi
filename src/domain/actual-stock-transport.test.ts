import { describe, expect, it } from 'vitest'
import { finalizeActualStockTransport } from './actual-stock-transport'
import { createCityTimeline, sliceCityAtYear } from './timeline'
import { rectangle } from './geometry'
import type { CityMap } from './types'

const terrain = { elevation: () => 10, slope: () => 0, waterAt: () => false, seaAt: () => false, bridgeSites: [] }
function fixture(): CityMap {
  const map: CityMap = {
    width: 1300, height: 700, year: 2025, config: { name: '試験町', seed: 'actual-stock', type: 'castle', terrain: 'plain', density: 65, forest: 0, railway: false, stations: 1, arterial: false, facilities: [], era: 'present' },
    roads: [{ id: 'old-road', points: [{ x: 100, y: 300 }, { x: 1100, y: 300 }], kind: 'local', role: 'lane', width: 4, builtYear: 1700 }],
    buildings: [{ id: 'occupied', parcelId: 'homes', polygon: rectangle(1060, 325, 50, 30), kind: 'residential', height: 8, builtYear: 1955, occupiedHouseholds: 1400, occupancy: 'occupied' }],
    parcels: [{ id: 'homes', polygon: rectangle(1050, 320, 70, 50), entrance: { x: 1080, y: 300 }, roadId: 'old-road', createdYear: 1955, developedYear: 1955, use: 'residential' }],
    stations: [{ id: 'destination', point: { x: 100, y: 300 }, name: '試験駅', builtYear: 1900 }],
    areas: [{ id: 'field', kind: 'field', landUse: 'farmland', polygon: rectangle(50, 250, 1150, 100) }],
    railways: [], facilities: [], districts: [], description: '', events: [],
  }
  map.timeline = createCityTimeline(map)
  return map
}

describe('terminal actual built-stock transport investment', () => {
  it('uses actual occupied frontage once, spends finite retained capital, and preserves earlier history and standing stock', () => {
    const map = fixture(), before = JSON.stringify(map), old = JSON.stringify(sliceCityAtYear(map, 2020)), result = finalizeActualStockTransport(map, { funds: 20_000, terrain })
    expect(result.projects.some(p => p.kind === 'renewal')).toBe(true)
    expect(result.spent).toBeGreaterThan(0)
    expect(result.spent).toBeLessThanOrEqual(20_000)
    expect(result.remainingFunds).toBe(20_000 - result.spent)
    for (const project of result.projects) {
      expect(project.dailyVehicleMinutesSaved).toBeGreaterThan(0)
      expect(project.benefit).toBeGreaterThan(project.cost)
    }
    expect(result.map.buildings).toEqual(map.buildings)
    expect(result.map.parcels?.map(p => p.polygon)).toEqual(map.parcels?.map(p => p.polygon))
    expect(result.map.roads[0]!.modifiedYear).toBe(2025)
    const historical = sliceCityAtYear(result.map, 2020)
    expect(historical.roads).toEqual(sliceCityAtYear(map, 2020).roads)
    expect(historical.areas).toEqual(sliceCityAtYear(map, 2020).areas)
    expect(JSON.stringify(sliceCityAtYear(map, 2020))).toBe(old)
    expect(JSON.stringify(map)).toBe(before)
    const second = finalizeActualStockTransport(result.map, { funds: result.remainingFunds, terrain })
    expect(second.map).toBe(result.map)
    expect(second.spent).toBe(0)
  })

  it('never uses future stock or invents capital, households or a compulsory road project', () => {
    const map = fixture()
    for (const funds of [0, 1, NaN]) expect(finalizeActualStockTransport(map, { funds, terrain }).spent).toBe(0)
    expect(finalizeActualStockTransport({ ...map, year: 2020 }, { funds: 20_000, terrain }).map.year).toBe(2020)
    expect(finalizeActualStockTransport({ ...map, year: 1955 }, { funds: 20_000, terrain }).spent).toBe(0)
    expect(finalizeActualStockTransport({ ...map, buildings: map.buildings.map(b => ({ ...b, occupiedHouseholds: 0 })) }, { funds: 20_000, terrain }).spent).toBe(0)
    expect(finalizeActualStockTransport({ ...map, config: { ...map.config, density: 0 } }, { funds: 20_000, terrain }).spent).toBe(0)
  })

  it('protects standing buildings, public grounds and private flag access across the full widened width', () => {
    for (const obstacle of ['building', 'park', 'castle', 'private-access']) {
      const map = fixture(), polygon = rectangle(500, 303, 30, 20)
      if (obstacle === 'building') map.buildings.push({ id: 'standing', polygon, kind: 'public', height: 1 })
      if (obstacle === 'park') map.areas.push({ id: 'public-park', kind: 'park', polygon })
      if (obstacle === 'castle') map.areas.push({ id: 'castle-courtyard', kind: 'field', polygon })
      if (obstacle === 'private-access') map.parcels!.push({ id: 'flag', polygon: rectangle(500, 320, 20, 20), entrance: { x: 510, y: 300 }, access: [{ x: 510, y: 300 }, { x: 510, y: 330 }], roadId: 'old-road', createdYear: 1900, use: 'residential' })
      map.timeline = createCityTimeline(map)
      expect(finalizeActualStockTransport(map, { funds: 20_000, terrain }).projects).toEqual([])
    }
  })

  it('cannot widen an unsurveyed water crossing or turn a private facility drive into a public collector', () => {
    const map = fixture(), wet = (p: { x: number; y: number }) => p.x > 490 && p.x < 510
    map.areas.push({ id: 'river', kind: 'water', polygon: rectangle(490, 0, 20, 700) })
    expect(finalizeActualStockTransport(map, { funds: 20_000, terrain: { ...terrain, waterAt: wet } }).projects).toEqual([])
    const privateMap = fixture()
    privateMap.roads[0]!.id = 'facility-access-onsen'
    privateMap.parcels![0]!.roadId = 'facility-access-onsen'
    expect(finalizeActualStockTransport(privateMap, { funds: 20_000, terrain }).projects).toEqual([])
  })

  it('fits an8m alternative around a standing building that blocks9.5m and verifies actual reassigned savings', () => {
    const map = fixture()
    map.roads[0]!.width = 6.3
    map.buildings[0]!.occupiedHouseholds = 2600
    map.buildings.push({ id: 'standing-near-road', polygon: rectangle(500, 304.2, 30, 20), kind: 'public', height: 1 })
    map.timeline = createCityTimeline(map)
    const before = JSON.stringify(map), result = finalizeActualStockTransport(map, { funds: 20_000, terrain })
    expect(result.projects).not.toHaveLength(0)
    expect(result.map.roads[0]!.width).toBe(8)
    if (!('diagnostics' in result)) throw new Error('A completed actual-stock appraisal must report traffic diagnostics')
    expect(result.diagnostics.finalDailyVehicleMinutes).toBeLessThan(result.diagnostics.initialDailyVehicleMinutes)
    expect(result.spent).toBeLessThanOrEqual(20_000)
    expect(result.map.buildings).toEqual(map.buildings)
    expect(JSON.stringify(map)).toBe(before)
    expect(sliceCityAtYear(result.map, 2020).roads).toEqual(sliceCityAtYear(map, 2020).roads)
  })
})
