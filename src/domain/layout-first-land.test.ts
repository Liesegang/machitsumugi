import { describe, expect, it } from 'vitest'
import { developLayoutFirstLand, layoutFirstBuildingFootprint } from './layout-first-land'
import type { LayoutFirstZone } from './layout-first-types'
import type { CityConfig, Point, Road } from './types'
import { buildingServiceYears } from './building-lifecycle'
import { extractStreetBlocks } from './road-graph'
import { boundsOf, corridorPolygon, distance, distanceToSegment, pointInPolygon, polygonArea, polygonsOverlap, rectangle, seededRandom } from './geometry'

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
    expect(result.buildings.every(b => b.polygon.length === 4 || b.polygon.length === 6)).toBe(true)
    expect(result.buildings.some(b => b.polygon.length === 6)).toBe(true)
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
  it('uses legible apartment bars on connected station collectors and keeps their depth and length within the actual holding', () => {
    const result = run({ roads: grid().map(road => ({ ...road, kind: 'arterial', role: 'collector', width: 9 })), stations: [{ point: { x: 220, y: 0 } }], zones: [{ ...zone, kind: 'residential', builtYear: 1900, maximumFloors: 10 }] })
    const apartments = result.buildings.filter(b => b.kind === 'residential' && b.height >= 4)
    expect(apartments.length).toBeGreaterThan(5)
    for (const building of apartments) {
      expect(building.polygon).toHaveLength(4)
      expect(distance(building.polygon[0]!, building.polygon[1]!)).toBeLessThanOrEqual(45 + 1e-7)
      expect(distance(building.polygon[1]!, building.polygon[2]!)).toBeGreaterThanOrEqual(12 - 1e-7)
      expect(distance(building.polygon[1]!, building.polygon[2]!)).toBeLessThanOrEqual(16 + 1e-7)
    }
    expect(result.metrics.grossFloorArea).toBeGreaterThan(result.metrics.footprintArea * 2.5)
    for (const building of result.buildings) expect(building.polygon.every(point => pointInPolygon(point, result.parcels.find(p => p.id === building.parcelId)!.polygon))).toBe(true)
  })
  it('renews historic centre blocks with compact walkups and taller wide-street frontage while preserving old low frames', () => {
    const roads = grid().map(road => road.id === 'vertical-2' ? { ...road, kind: 'arterial' as const, role: 'collector' as const, width: 9 } : road)
    const blocks = [0, 1, 2, 3].flatMap(x => [0, 1, 2].map(y => ({ id: `block-${x}-${y}`, polygon: rectangle(x * 110, y * 110, 110, 110) })))
    const result = run({ config: { ...config, settlement: 'metropolis' }, roads, blocks, center: { x: 220, y: 180 }, stations: [{ point: { x: 220, y: 0 }, builtYear: 1900 }], zones: [{ ...zone, maximumFloors: 2 }] })
    const walkups = result.buildings.filter(building => building.kind === 'residential' && building.height >= 3)
    expect(walkups.length).toBeGreaterThan(50)
    for (const building of walkups) {
      expect(building.height).toBeLessThanOrEqual(4)
      expect(polygonArea(building.polygon)).toBeLessThan(350)
      const parcel = result.parcels.find(parcel => parcel.id === building.parcelId)!
      const frontage = roads.find(road => road.id === parcel.roadId)!
      expect(frontage.kind === 'local' || parcel.id.endsWith('-rear') && parcel.access!.length > 2).toBe(true)
    }
    const wideFrontage = result.buildings.filter(building => building.kind === 'commercial' && result.parcels.find(parcel => parcel.id === building.parcelId)!.roadId === 'vertical-2')
    expect(wideFrontage.length).toBeGreaterThan(5)
    expect(wideFrontage.every(building => building.height >= 4 && building.height <= 8)).toBe(true)
    expect(result.history.buildings.filter(frame => frame.from < 1955).every(frame => frame.value.height <= 2)).toBe(true)
    expect(result.history.buildings.some(frame => frame.from < 1900)).toBe(true)
  })
  it('keeps ordinary homes small when a district label has no connected station or collector context', () => {
    for (const kind of ['residential', 'station', 'apartment'] as const) {
      const result = run({ zones: [{ ...zone, kind, builtYear: 1955, maximumFloors: 12 }] })
      expect(result.buildings.length).toBeGreaterThan(150)
      expect(result.buildings.every(building => building.height <= 2)).toBe(true)
      expect(result.buildings.every(building => polygonArea(building.polygon) < 350)).toBe(true)
    }
  })

  it('packs connected inner blocks with narrower frontages and rear homes while keeping outer grain and mixed building sizes', () => {
    const roads = grid(90), blocks = [0, 1, 2, 3].flatMap(x => [0, 1, 2].map(y => ({ id: `compact-${x}-${y}`, polygon: rectangle(x * 90, y * 90, 90, 90) })))
    const input = { config: { ...config, settlement: 'metropolis' as const }, roads, blocks, zones: [{ ...zone, maximumFloors: 2 }] }
    const outer = run(input), dense = run({ ...input, center: { x: 180, y: 135 } }), disconnected = run({ ...input, center: { x: 9000, y: 9000 } })
    expect(disconnected.parcels).toEqual(outer.parcels)
    expect(disconnected.history.buildings).toEqual(outer.history.buildings)
    const interior = (result: typeof dense) => result.parcels.filter(parcel => parcel.polygon.every(point => point.x > 0 && point.x < 360 && point.y > 0 && point.y < 270))
    const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!
    const residential = (result: typeof dense) => result.buildings.filter(building => building.kind === 'residential' && interior(result).some(parcel => parcel.id === building.parcelId))
    const denseHomes = residential(dense), outerHomes = residential(outer)
    const coverage = (result: typeof dense, homes: typeof denseHomes) => homes.map(building => polygonArea(building.polygon) / polygonArea(result.parcels.find(parcel => parcel.id === building.parcelId)!.polygon))
    expect(denseHomes.length).toBeGreaterThan(outerHomes.length * 1.25)
    expect(median(interior(dense).map(parcel => polygonArea(parcel.polygon)))).toBeLessThan(median(interior(outer).map(parcel => polygonArea(parcel.polygon))) * .75)
    expect(median(coverage(dense, denseHomes))).toBeGreaterThan(median(coverage(outer, outerHomes)) + .08)
    expect(median(denseHomes.map(building => polygonArea(building.polygon)))).toBeGreaterThan(median(outerHomes.map(building => polygonArea(building.polygon))) * .55)
    expect(median(denseHomes.map(building => polygonArea(building.polygon)))).toBeLessThan(median(outerHomes.map(building => polygonArea(building.polygon))))
    expect(new Set(denseHomes.map(building => Math.round(polygonArea(building.polygon)))).size).toBeGreaterThan(35)
    expect(dense.buildings.some(building => building.kind === 'commercial' && polygonArea(building.polygon) > 150)).toBe(true)
    expect(interior(dense).filter(parcel => parcel.id.endsWith('-rear')).length).toBeGreaterThan(30)
  })

  it('owns the entire deep inner holding through separately accessed rear titles without crossing water, reserves or other buildings', () => {
    const roads: Road[] = [
      { id: 'north', points: [{ x: 20, y: 30 }, { x: 420, y: 30 }], kind: 'arterial', role: 'collector', width: 9, builtYear: 1770 },
      { id: 'east', points: [{ x: 420, y: 30 }, { x: 420, y: 180 }], kind: 'local', width: 6, builtYear: 1770 },
      { id: 'south', points: [{ x: 420, y: 180 }, { x: 20, y: 180 }], kind: 'local', width: 6, builtYear: 1770 },
      { id: 'west', points: [{ x: 20, y: 180 }, { x: 20, y: 30 }], kind: 'local', width: 6, builtYear: 1770 },
    ]
    const water = rectangle(210, 50, 12, 110), reserve = rectangle(275, 110, 20, 35)
    const result = run({ config: { ...config, settlement: 'metropolis' }, roads, center: { x: 20, y: 30 }, blocks: [{ id: 'deep-inner-block', polygon: rectangle(20, 30, 400, 150) }], zones: [{ ...zone, polygon: rectangle(0, 0, 440, 220) }], reserves: [{ polygon: reserve }], canPlace: polygon => !polygonsOverlap(polygon, water) })
    expect(result.parcels.some(parcel => parcel.id.endsWith('-inner-2-rear'))).toBe(true)
    const groups = new Map<string, typeof result.parcels>()
    for (const parcel of result.parcels.filter(parcel => parcel.polygon.every(point => point.x > 20 && point.x < 420 && point.y > 30 && point.y < 180))) {
      const id = parcel.id.replace(/(?:-inner-\d+)?-rear$/, ''), group = groups.get(id) ?? []
      group.push(parcel); groups.set(id, group)
    }
    const divided = [...groups].filter(([, group]) => group.some(parcel => parcel.id.endsWith('-rear')))
    expect(divided.length).toBeGreaterThan(8)
    for (const [id, group] of divided) {
      expect(group.some(parcel => parcel.id === id)).toBe(true)
      const bounds = boundsOf(group.flatMap(parcel => parcel.polygon))
      expect(group.reduce((sum, parcel) => sum + polygonArea(parcel.polygon), 0) / ((bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY))).toBeGreaterThan(.96)
    }
    for (const parcel of result.parcels) {
      expect(polygonsOverlap(parcel.polygon, water)).toBe(false)
      expect(polygonsOverlap(parcel.polygon, reserve)).toBe(false)
      for (const other of result.parcels) if (other !== parcel) expect(polygonsOverlap(parcel.polygon, other.polygon)).toBe(false)
      for (let i = 1; i < parcel.access!.length; i++) {
        const corridor = corridorPolygon(parcel.access![i - 1]!, parcel.access![i]!, 1.4)
        expect(polygonsOverlap(corridor, water)).toBe(false)
        expect(polygonsOverlap(corridor, reserve)).toBe(false)
        for (const frame of result.history.buildings) expect(polygonsOverlap(corridor, frame.value.polygon)).toBe(false)
        for (const other of result.parcels) if (other !== parcel) expect(polygonsOverlap(corridor, other.polygon)).toBe(false)
      }
    }
  })
  it('does not backdate station shops before the station or a future connecting road opens', () => {
    const frontage: Road = { id: 'old-frontage', points: [{ x: 100, y: 180 }, { x: 420, y: 180 }], kind: 'local', width: 6, builtYear: 1770 }
    for (const connectionYear of [1770, 1975]) {
      const connector: Road = { id: 'station-connector', points: [{ x: 20, y: 180 }, { x: 100, y: 180 }], kind: 'local', width: 6, builtYear: connectionYear }
      const input = { roads: [frontage, connector], stations: [{ point: { x: 20, y: 180 }, builtYear: 1900 }], zones: [{ ...zone, kind: 'residential' as const, maximumFloors: 6 }] }
      const present = run(input), beforeRail = run({ ...input, config: { ...config, targetYear: 1850 } })
      const shops = present.parcels.filter(parcel => parcel.roadId === frontage.id && parcel.use === 'commercial')
      expect(shops.length).toBeGreaterThan(2)
      expect(shops.every(parcel => parcel.createdYear >= Math.max(1900, connectionYear))).toBe(true)
      expect(present.history.buildings.filter(frame => shops.some(parcel => parcel.id === frame.value.parcelId)).every(frame => frame.from >= Math.max(1900, connectionYear))).toBe(true)
      expect(beforeRail.buildings.every(building => building.kind !== 'commercial')).toBe(true)
      expect(beforeRail.buildings.some(building => building.kind === 'residential')).toBe(true)
    }
  })
  it('dates compact narrow-lane houses and their inner titles by the station and the complete connecting route', () => {
    const frontage: Road = { id: 'old-narrow-lane', points: [{ x: 100, y: 180 }, { x: 420, y: 180 }], kind: 'local', width: 4.5, builtYear: 1770 }
    const block = { id: 'station-lane-block', polygon: rectangle(100, 180, 320, 90) }
    for (const connectionYear of [1770, 1975]) {
      const connector: Road = { ...frontage, id: 'narrow-station-connector', points: [{ x: 20, y: 180 }, { x: 100, y: 180 }], builtYear: connectionYear }
      const input = { config: { ...config, settlement: 'metropolis' as const }, roads: [frontage, connector], blocks: [block], stations: [{ point: { x: 20, y: 180 }, builtYear: 1900 }], zones: [{ ...zone, kind: 'residential' as const }] }
      const present = run(input), old = run({ ...input, config: { ...input.config, targetYear: 1850 } })
      const inner = present.parcels.filter(parcel => parcel.roadId === frontage.id && parcel.entrance!.y > 180)
      expect(inner.filter(parcel => parcel.use === 'residential' && parcel.id.endsWith('-rear')).length).toBeGreaterThan(3)
      expect(inner.every(parcel => parcel.createdYear >= Math.max(1900, connectionYear))).toBe(true)
      expect(present.history.buildings.filter(frame => inner.some(parcel => parcel.id === frame.value.parcelId)).every(frame => frame.from >= Math.max(1900, connectionYear))).toBe(true)
      expect(old.parcels.some(parcel => parcel.roadId === frontage.id && parcel.entrance!.y > 180)).toBe(false)
      expect(old.parcels).toEqual(present.parcels.filter(parcel => parcel.createdYear <= 1850))
      expect(old.history.buildings.map(frame => frame.value)).toEqual(present.history.buildings.filter(frame => frame.from <= 1850).map(frame => frame.value))
    }
  })
  it('keeps every compact private approach inside its ownership beside a curved street', () => {
    const top = Array.from({ length: 81 }, (_, i): Point => ({ x: 25 + i * 4, y: 120 + Math.sin(i / 8) * 12 }))
    const bottom = [...top].reverse().map(point => ({ x: point.x, y: point.y + 90 }))
    const road: Road = { id: 'curved-block', points: [...top, ...bottom, top[0]!], kind: 'local', width: 6, builtYear: 1770 }
    const blocks = extractStreetBlocks([road]).map((polygon, i) => ({ id: `curved-${i}`, polygon }))
    expect(blocks).toHaveLength(1)
    const result = run({ config: { ...config, settlement: 'metropolis' }, roads: [road], blocks, center: top[0] })
    expect(result.metrics.rearTitles).toBeGreaterThan(10)
    for (const parcel of result.parcels) for (let i = 1; i < parcel.access!.length; i++) {
      const path = corridorPolygon(parcel.access![i - 1]!, parcel.access![i]!, 1.4)
      for (const other of result.parcels) if (other !== parcel) expect(polygonsOverlap(path, other.polygon)).toBe(false)
      for (const frame of result.history.buildings) expect(polygonsOverlap(path, frame.value.polygon)).toBe(false)
    }
  })
  it('retains shallow recesses on small ordinary stock while bounding apartment mass on deep plots', () => {
    let recessed = 0
    for (const form of ['house', 'shop', 'workshop', 'apartment'] as const) for (let i = 0; i < 30; i++) {
      const footprint = layoutFirstBuildingFootprint({ body: [0, 80, 0, 80], form, rear: false, year: 1995, random: seededRandom(`footprint-${form}-${i}`) })
      expect(footprint.every(point => point.x > 0 && point.x < 80 && point.y > 0 && point.y < 80)).toBe(true)
      if (form === 'apartment') {
        expect(footprint).toHaveLength(4)
        expect(distance(footprint[0]!, footprint[1]!)).toBe(45)
        expect(distance(footprint[1]!, footprint[2]!)).toBeGreaterThanOrEqual(12)
        expect(distance(footprint[1]!, footprint[2]!)).toBeLessThanOrEqual(16)
      } else {
        expect([4, 6]).toContain(footprint.length)
        if (footprint.length === 6) {
          recessed++
          expect(footprint[0]!.x - footprint[4]!.x).toBeLessThanOrEqual(3.5 + 1e-7)
          expect(footprint[4]!.y - footprint[0]!.y).toBeLessThanOrEqual(4 + 1e-7)
        }
      }
    }
    expect(recessed).toBeGreaterThan(10)
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
