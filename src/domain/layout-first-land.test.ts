import { describe, expect, it } from 'vitest'
import { developLayoutFirstLand } from './layout-first-land'
import type { LayoutFirstZone } from './layout-first-types'
import type { CityConfig, Point, Road } from './types'
import { buildingServiceYears } from './building-lifecycle'
import { corridorPolygon, distanceToSegment, pointInPolygon, polygonArea, polygonsOverlap, rectangle } from './geometry'

const config: CityConfig = { name: '試験町', seed: 'layout-physical-frames', type: 'post', terrain: 'plain', density: 75, forest: 0, railway: false, stations: 0, arterial: false, facilities: [], targetYear: 2025, settlement: 'regional-city' }
const zone: LayoutFirstZone = { id: 'district', center: { x: 220, y: 180 }, radius: 500, polygon: rectangle(0, 0, 440, 360), kind: 'historic', builtYear: 1770, density: 1, maximumFloors: 4 }
const grid = (size = 110): Road[] => [0, 1, 2, 3, 4].map((i): Road => ({ id: `vertical-${i}`, points: [{ x: i * size, y: 0 }, { x: i * size, y: 330 }], kind: 'local', width: 6, builtYear: 1770 })).concat([0, 1, 2, 3].map((i): Road => ({ id: `horizontal-${i}`, points: [{ x: 0, y: i * size }, { x: 440, y: i * size }], kind: 'local', width: 6, builtYear: 1770 })))
const run = (overrides: Partial<Parameters<typeof developLayoutFirstLand>[0]> = {}) => developLayoutFirstLand({ config, roads: grid(), zones: [zone], canPlace: () => true, slope: () => 0, ...overrides })

describe('layout-first land composition', () => {
  it('fills full physical blocks with varied holdings and present-day buildings in one bounded pass', () => {
    const result = run()
    expect(result.buildings.length).toBeGreaterThan(150)
    expect(result.metrics.titleArea / (440 * 330), JSON.stringify(result.metrics)).toBeGreaterThan(.48)
    expect(new Set(result.buildings.map(b => Math.round(polygonArea(b.polygon)))) .size).toBeGreaterThan(40)
    expect(result.buildings.some(b => b.polygon.length > 4)).toBe(true)
    const center = rectangle(145, 145, 40, 40)
    expect(result.parcels.some(p => polygonsOverlap(p.polygon, center))).toBe(true)
    for (const parcel of result.parcels) {
      const road = grid().find(road => road.id === parcel.roadId)!
      const attachment = parcel.access![0]!
      expect(Math.min(...road.points.slice(1).map((point, i) => distanceToSegment(attachment, road.points[i]!, point)))).toBeLessThan(1e-7)
    }
  })
  it('keeps civic reservations and complete water polygons clear, with no parcel/building/road collisions', () => {
    const water = rectangle(195, 0, 25, 360), reserve = rectangle(245, 125, 75, 70)
    const result = run({ reserves: [{ polygon: reserve }], canPlace: polygon => !polygonsOverlap(polygon, water) })
    expect(result.buildings.length).toBeGreaterThan(100)
    for (const parcel of result.parcels) {
      expect(polygonsOverlap(parcel.polygon, water)).toBe(false)
      expect(polygonsOverlap(parcel.polygon, reserve)).toBe(false)
    }
    for (let i = 0; i < result.parcels.length; i++) for (let j = i + 1; j < result.parcels.length; j++) expect(polygonsOverlap(result.parcels[i]!.polygon, result.parcels[j]!.polygon)).toBe(false)
    for (const building of result.buildings) {
      const parcel = result.parcels.find(p => p.id === building.parcelId)!
      expect(building.polygon.every(p => pointInPolygon(p, parcel.polygon))).toBe(true)
      for (const road of grid()) for (let i = 1; i < road.points.length; i++) expect(polygonsOverlap(building.polygon, corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2))).toBe(false)
    }
  })
  it('keeps a1770title while replacing ordinary commercial frames, with distinct IDs and immutable past geometry', () => {
    const present = run(), old = present.history.buildings.find(frame => frame.from === 1770 && frame.value.kind === 'commercial')!
    expect(old).toBeTruthy(); expect(old.to).toBeLessThan(1900)
    const title = present.parcels.find(p => p.id === old.value.parcelId)!, current = present.buildings.find(b => b.parcelId === title.id)!
    expect(title.createdYear).toBe(1770); expect(current.id).not.toBe(old.value.id)
    expect(current.builtYear).toBeGreaterThan(1900)
    for (const building of present.buildings) expect(2025 - building.builtYear!).toBeLessThan(buildingServiceYears(config.seed, building))
    expect(new Set(present.history.buildings.map(frame => frame.value.id)).size).toBe(present.history.buildings.length)
    const earlier = run({ config: { ...config, targetYear: 1850 } })
    expect(earlier.history.buildings.map(frame => frame.value)).toEqual(present.history.buildings.filter(frame => frame.from <= 1850).map(frame => frame.value))
    expect(present.history.buildings.find(frame => frame.value.id === old.value.id)!.value.polygon).toEqual(old.value.polygon)
  })
  it('does not reset lot sampling at every tiny curve sample or attach buildings to elevated/controlled roads', () => {
    const points = Array.from({ length: 151 }, (_, i): Point => ({ x: 25 + i * 2, y: 170 + Math.sin(i / 30) * 8 }))
    const road: Road = { id: 'curve', points, kind: 'local', width: 6, builtYear: 1955 }
    const result = run({ roads: [road], zones: [{ ...zone, kind: 'residential', builtYear: 1955 }] })
    expect(result.buildings.length).toBeGreaterThan(15)
    expect(result.buildings.length).toBeLessThan(60)
    const elevated = run({ roads: [{ ...road, id: 'viaduct', level: 1 }, { ...road, id: 'motorway', controlledAccess: true }] })
    expect(elevated.buildings).toEqual([])
  })
  it('uses diverse large footprints in station districts and keeps them within each acquired holding', () => {
    const result = run({ zones: [{ ...zone, kind: 'station', builtYear: 1900, maximumFloors: 10 }] })
    expect(result.buildings.some(b => b.height >= 5 && b.polygon.length >= 6)).toBe(true)
    expect(result.metrics.grossFloorArea).toBeGreaterThan(result.metrics.footprintArea * 3)
    for (const building of result.buildings) expect(building.polygon.every(point => pointInPolygon(point, result.parcels.find(p => p.id === building.parcelId)!.polygon))).toBe(true)
  })
  it('surveys rear-title access at full width for every physical building version', () => {
    const result = run()
    expect(result.metrics.rearTitles).toBeGreaterThan(5)
    for (const parcel of result.parcels.filter(p => p.id.endsWith('-rear'))) {
      for (let i = 1; i < parcel.access!.length; i++) {
        const path = corridorPolygon(parcel.access![i - 1]!, parcel.access![i]!, 1.4)
        for (const frame of result.history.buildings.filter(frame => frame.value.parcelId === parcel.id)) expect(polygonsOverlap(path, frame.value.polygon)).toBe(false)
        for (const building of result.buildings.filter(b => b.parcelId !== parcel.id)) expect(polygonsOverlap(path, building.polygon)).toBe(false)
      }
    }
  })
  it('keeps dry frontage on a collector containing a bridge while refusing its wet span', () => {
    const river = rectangle(200, 0, 35, 360), road: Road = { id: 'cross-river-collector', points: [{ x: 20, y: 160 }, { x: 420, y: 160 }], kind: 'arterial', role: 'collector', width: 9, builtYear: 1900, bridge: true }
    const result = run({ roads: [road], canPlace: polygon => !polygonsOverlap(polygon, river) })
    expect(result.buildings.some(b => b.polygon.every(p => p.x < 200))).toBe(true)
    expect(result.buildings.some(b => b.polygon.every(p => p.x > 235))).toBe(true)
    for (const parcel of result.parcels) {
      expect(polygonsOverlap(parcel.polygon, river)).toBe(false)
      for (let i = 1; i < parcel.access!.length; i++) expect(polygonsOverlap(corridorPolygon(parcel.access![i - 1]!, parcel.access![i]!, 1.4), river)).toBe(false)
    }
  })
  it('dates declining vacancies without altering physical buildings, titles or old occupancy', () => {
    const growing = run({ config: { ...config, populationTrend: 'growing' } }), declining = run({ config: { ...config, populationTrend: 'declining' } })
    expect(declining.parcels).toEqual(growing.parcels)
    expect(declining.history.buildings).toEqual(growing.history.buildings)
    expect(declining.events).toEqual(growing.events)
    expect(declining.buildings.filter(b => b.occupancy === 'vacant').length).toBeGreaterThan(growing.buildings.filter(b => b.occupancy === 'vacant').length)
    expect(declining.buildings.reduce((sum, b) => sum + (b.occupiedHouseholds ?? 0), 0)).toBeLessThan(growing.buildings.reduce((sum, b) => sum + (b.occupiedHouseholds ?? 0), 0))
    expect(declining.history.buildingStates.filter(s => s.from <= 1850)).toEqual(growing.history.buildingStates.filter(s => s.from <= 1850))
    expect(declining.history.buildingStates.some(s => s.from === 1975 || s.from === 1995)).toBe(true)
    for (const result of [growing, declining]) for (const building of result.buildings) {
      const capacity = building.kind === 'residential' ? Math.max(1, Math.floor(polygonArea(building.polygon) * building.height / 85)) : 0
      expect(building.occupiedHouseholds).toBeGreaterThanOrEqual(0)
      expect(building.occupiedHouseholds).toBeLessThanOrEqual(capacity)
      if (building.occupancy === 'vacant') expect(building.occupiedHouseholds).toBe(0)
      const state = result.history.buildingStates.filter(s => s.id === building.id).sort((a, b) => b.from - a.from)[0]!
      expect(state).toMatchObject({ occupancy: building.occupancy, occupiedHouseholds: building.occupiedHouseholds })
    }
  })
})
