import { beforeAll, describe, expect, it } from 'vitest'
import { generateLayoutCity, LAYOUT_GENERATOR_VERSION, layoutGenerationReport } from './layout-first-generator'
import type { TerrainModel, TerrainModelInput } from './terrain'
import type { Area, CityConfig, CityMap, Point, Road } from './types'
import { boundsOf, corridorPolygon, intersectRegions, overlaps, polygonOverlapsRegion, rectangle, regionArea } from './geometry'
import { buildingServiceYears } from './building-lifecycle'
import { sliceCityAtYear } from './timeline'
import { parseProject } from './project'
import { controlledRoad, materializeRoadJunctions } from './road-graph'
import { featureHistory } from '../map/inspect'

/** An explicit surveyed synthetic plain/coast. Engineering and composition are
 * production modules; only geological erosion is replaced by this known DEM. */
function surveyedTerrain(input: TerrainModelInput, coastal = false): TerrainModel {
  const water: Area[] = coastal ? [{ id: 'sea', kind: 'water', waterLevel: 0, name: '試験湾', polygon: rectangle(0, 2350, input.width, input.height - 2350) }] : []
  const forest: Area = { id: 'forest-survey', kind: 'forest', polygon: rectangle(50, 50, 850, input.height - 100), name: '試験林' }
  const waterAt = (p: Point) => coastal && p.y >= 2350
  const elevation = (p: Point) => coastal ? waterAt(p) ? 0 : 2 : 20 + p.x * .001
  const slope = () => coastal ? 0 : .001
  const continuationBounds = { minX: -500, minY: -500, maxX: input.width + 500, maxY: input.height + 500 }
  const contains = (p: Point) => p.x >= continuationBounds.minX && p.x <= continuationBounds.maxX && p.y >= continuationBounds.minY && p.y <= continuationBounds.maxY
  const columns = 10, rows = 10, rawDEM = new Float32Array(columns * rows).fill(coastal ? 2 : 20)
  const hydrology = {
    extent: 9000, columns, rows, resolution: 1000, seed: 1, initialDEM: rawDEM.slice(), rawDEM,
    hydroDEM: rawDEM.slice(), flowTo: new Int32Array(rawDEM.length).fill(-1), accumulatedArea: new Float64Array(rawDEM.length), ocean: new Uint8Array(rawDEM.length), order: Int32Array.from({ length: rawDEM.length }, (_, i) => i), processedCells: rawDEM.length, outletArea: 0, fillVolume: 0, alluvium: new Float32Array(rawDEM.length),
    erosion: { iterations: 0, elapsedYears: 0, terrainBalanceError: 0 }, sediment: { erodedSourceVolume: 0, storedVolume: 0, exportedVolume: 0, massBalanceError: 0 },
    cropOrigin: { x: 0, y: 0 }, frame: { worldAnchor: { x: 0, y: 0 }, localAnchor: { x: 0, y: 0 }, angle: 0, mirrored: false },
    localResolution: 1000, localDEM: rawDEM.slice(), localColumns: columns, localRows: rows, channelEvolution: [], oxbows: [], depressionLakes: [],
  } as unknown as TerrainModel['hydrology']
  return { areas: [...water, forest], elevation, slope, waterAt, bridgeSites: [], cityOrigin: { x: input.width * .5, y: input.height * (coastal ? .4 : .5) }, landform: p => waterAt(p) ? 'water' : 'terrace', wetness: () => .08, terrainCost: p => waterAt(p) ? Infinity : 1, cultivable: p => !waterAt(p), bankDistance: () => Infinity, channelAt: () => null, rivers: [], bridgeCandidates: [], continuationTerrain: { bounds: continuationBounds, contains, elevation, slope, waterAt, seaAt: waterAt }, hydrology }
}
const config: CityConfig = { name: '街区設計市', seed: 'layout-all-civics-physical', type: 'castle', terrain: 'plain', density: 70, forest: 60, railway: false, stations: 2, arterial: true, facilities: ['castle', 'shrine', 'school', 'university', 'hospital', 'police', 'shop', 'park', 'onsen'], settlement: 'regional-city', relief: 'lowland', mapSize: 'small', targetYear: 2025, bypass: false, expressway: false, subway: false, cityEngine: 'layout' }
let inland: CityMap, coast: CityMap
let inlandSourceCalls = 0, coastSourceCalls = 0
const inlandSource = (input: TerrainModelInput) => { inlandSourceCalls++; return surveyedTerrain(input) }
const coastSource = (input: TerrainModelInput) => { coastSourceCalls++; return surveyedTerrain(input, true) }

it('rejects a requested port on an entirely dry inland survey instead of reporting partial civic success', () => {
  let sourceCalls = 0
  let failure: unknown
  try {
    generateLayoutCity({ ...config, seed: 'layout-inland-port-must-fail', type: 'newtown', facilities: ['port'], density: 0, forest: 0, settlement: 'village' }, undefined, undefined, input => {
      sourceCalls++
      // The supplied survey has no water or shoreline, even if the normal
      // requested-port defaults select a coastal terrain configuration.
      return surveyedTerrain(input)
    })
  } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toContain('港の用地と接道を確保できませんでした')
  expect((failure as Error).message).toContain('生成を中止しました')
  expect((failure as Error).cause).toMatchObject({ missing: ['port'], access: { unserved: [] } })
  expect(sourceCalls).toBe(1)
})

/** Independent exact-centreline reachability, not the planner's own success flag. */
function physicalRoadComponents(roads: Road[]) {
  const normalized = materializeRoadJunctions(roads.filter(road => !controlledRoad(road) && (road.level ?? 0) === 0))
  const key = (p: Point) => `${Math.round(p.x * 1e5)}:${Math.round(p.y * 1e5)}`
  const parents = new Map<string, string>()
  const root = (id: string): string => { const parent = parents.get(id); if (parent === undefined) { parents.set(id, id); return id } if (parent === id) return id; const result = root(parent); parents.set(id, result); return result }
  for (const road of normalized) for (let i = 1; i < road.points.length; i++) { const a = root(key(road.points[i - 1]!)), b = root(key(road.points[i]!)); if (a !== b) parents.set(a, b) }
  const boundaryRoots = new Set(normalized.filter(road => road.boundaryContinuation).map(road => root(key(road.points[0]!))))
  return { served: (point: Point) => boundaryRoots.has(root(key(point))), byId: new Map(normalized.map(road => [road.id, road])), boundaries: boundaryRoots.size }
}

describe('layout-first composed city integration on a known surveyed DEM', () => {
  beforeAll(() => { inland = generateLayoutCity(config, undefined, undefined, inlandSource) }, 25000)
  beforeAll(() => { coast = generateLayoutCity({ ...config, seed: 'layout-coastal-civics-physical', type: 'port', terrain: 'coast', railway: true, facilities: ['port', 'school', 'hospital', 'shrine', 'park', 'shop'] }, undefined, undefined, coastSource) }, 25000)

  it('reserves every requested civic programme before household titles and retains a street of separate shop buildings', () => {
    expect(inland.unplacedFacilities, JSON.stringify(inland.unplacedFacilities)).toEqual([])
    for (const kind of config.facilities) expect(inland.facilities.some(f => f.kind === kind), kind).toBe(true)
    expect(inland.buildings.length).toBeGreaterThan(500)
    expect(inland.facilities.find(f => f.kind === 'shop')).toBeTruthy()
    expect(inland.buildings.filter(b => b.kind === 'commercial').length).toBeGreaterThan(20)
    expect(inland.buildings.some(b => b.name?.includes('大学') && b.kind === 'public')).toBe(true)
    expect(inland.buildings.filter(b => b.use === 'lodging').length).toBeGreaterThanOrEqual(4)
  })
  it('places a genuine dry coastal port and station grounds while keeping all ordinary buildings off water, civic reserves and railway corridors', () => {
    expect(coast.unplacedFacilities, JSON.stringify(coast.unplacedFacilities)).toEqual([])
    expect(coast.facilities.some(f => f.kind === 'port')).toBe(true)
    expect(coast.railways).toHaveLength(1)
    expect(coast.stations.length).toBeGreaterThanOrEqual(1)
    for (const map of [inland, coast]) {
      const water = map.areas.filter(area => area.kind === 'water').map(region => ({ ...region, bounds: boundsOf(region.polygon) }))
      const grounds = map.areas.filter(area => area.id.startsWith('facility-lot-') || area.id.startsWith('station-forecourt-')).map(region => ({ ...region, bounds: boundsOf(region.polygon) }))
      const rail = map.railways.filter(line => line.mode !== 'subway').flatMap(line => line.points.slice(1).map((p, i) => { const polygon = corridorPolygon(line.points[i]!, p, 7); return { polygon, bounds: boundsOf(polygon) } }))
      for (const building of map.buildings) {
        const bounds = boundsOf(building.polygon)
        for (const area of water.filter(area => overlaps(bounds, area.bounds))) expect(intersectRegions({ polygon: building.polygon }, area).reduce((sum, part) => sum + regionArea(part), 0), `${building.id}/${area.id}`).toBeLessThan(1e-5)
        if (!building.parcelId) continue
        expect(grounds.some(area => overlaps(bounds, area.bounds) && polygonOverlapsRegion(building.polygon, area)), building.id).toBe(false)
        expect(rail.some(area => overlaps(bounds, area.bounds) && polygonOverlapsRegion(building.polygon, area)), building.id).toBe(false)
      }
    }
  })
  it('replaces ordinary commercial/public physical frames while leaving the original title and retired geometry intact', () => {
    const history = inland.timeline!, oldShop = history.buildings.find(v => v.value.kind === 'commercial' && v.from < 1800 && v.value.parcelId)!
    expect(oldShop).toBeTruthy(); expect(oldShop.to).toBeLessThan(1900)
    const currentShop = inland.buildings.find(b => b.parcelId === oldShop.value.parcelId)!
    expect(currentShop).toBeTruthy(); expect(currentShop.id).not.toBe(oldShop.value.id); expect(currentShop.builtYear).toBeGreaterThan(1900)
    const title = inland.parcels!.find(p => p.id === oldShop.value.parcelId)!
    expect(title.createdYear).toBeLessThanOrEqual(oldShop.from)
    const firstBath = history.buildings.find(v => v.value.id === 'facility-building-onsen-0')!
    expect(firstBath.from).toBe(1650); expect(firstBath.to).toBeLessThan(1800)
    expect(inland.buildings.some(b => b.id === firstBath.value.id)).toBe(false)
    const nextBath = history.buildings.find(version => version.value.id.startsWith('facility-building-onsen-0-replacement-') && version.from === firstBath.to)!
    expect(nextBath).toBeTruthy()
    const onsen = inland.facilities.find(facility => facility.kind === 'onsen')!
    const civicEvents = featureHistory(inland, { type: 'facility', item: onsen })
    expect(civicEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: firstBath.value.id, kind: 'construction', year: firstBath.from }),
      expect.objectContaining({ entityId: firstBath.value.id, kind: 'demolition', year: firstBath.to }),
      expect.objectContaining({ entityId: nextBath.value.id, kind: 'construction', year: nextBath.from }),
    ]))
    const beforeRebuild = sliceCityAtYear(inland, firstBath.to! - 1)
    const pastEvents = featureHistory(beforeRebuild, { type: 'facility', item: beforeRebuild.facilities.find(facility => facility.id === onsen.id)! })
    expect(pastEvents.some(event => event.entityId === firstBath.value.id && event.kind === 'construction')).toBe(true)
    expect(pastEvents.every(event => event.year <= beforeRebuild.year!)).toBe(true)
    expect(pastEvents.some(event => (event.entityId === firstBath.value.id && event.kind === 'demolition') || event.entityId === nextBath.value.id)).toBe(false)
    const currentPublic = inland.buildings.find(building => building.id.startsWith('facility-building-onsen-0-replacement-'))!
    expect(inland.events).toEqual(expect.arrayContaining([expect.objectContaining({ entityId: currentPublic.id, kind: 'construction', year: currentPublic.builtYear })]))
    expect(new Set(history.buildings.map(v => v.value.id)).size).toBe(history.buildings.length)
    for (const building of inland.buildings.filter(b => !b.id.startsWith('castle-'))) expect(2025 - building.builtYear!, building.id).toBeLessThan(buildingServiceYears(config.seed, building))
  })
  it('connects every institutional gate and station entrance to an external public road at its real opening date', () => {
    for (const map of [inland, coast]) {
      const report = layoutGenerationReport(map)!
      expect(report.transport.unservedAccessIds, JSON.stringify(report.transport)).toEqual([])
      expect(report.transport.boundaryConnections).toBeGreaterThanOrEqual(1)
      const years = [...new Set([1650, 1900, 2025, ...map.timeline!.facilities.filter(version => version.value.kind !== 'shop').map(version => version.from)])].sort((a, b) => a - b)
      for (const year of years) {
        const past = sliceCityAtYear(map, year), graph = physicalRoadComponents(past.roads)
        expect(graph.boundaries, `${map.config.seed}/${year}`).toBeGreaterThanOrEqual(1)
        for (const facility of past.facilities.filter(f => f.kind !== 'shop')) {
          const id = facility.kind === 'castle' ? 'facility-access-castle' : `facility-access-${facility.kind}-0`
          const approach = graph.byId.get(id)
          expect(approach, `${facility.kind}/${year}: missing actual entrance path`).toBeTruthy()
          expect(graph.served(approach!.points[0]!), `${map.config.seed}/${facility.kind}/${year}: gate is isolated or borrows a future road`).toBe(true)
        }
        for (const station of past.stations.filter(s => s.mode !== 'subway')) {
          const approach = graph.byId.get(station.id.replace('station-', 'station-access-'))!
          expect(approach, `${station.id}/${year}`).toBeTruthy()
          expect(graph.served(approach.points[0]!), `${station.id}/${year}: public forecourt gate`).toBe(true)
          expect(graph.served(station.entrance!), `${station.id}/${year}: station door`).toBe(true)
        }
        // Every ordinary shop/house is on an actually connected public street;
        // a label alone cannot certify a disconnected private access spur.
        for (const parcel of past.parcels ?? []) {
          const road = graph.byId.get(parcel.roadId)
          expect(road, `${parcel.id}/${year}`).toBeTruthy()
          expect(graph.served(road!.points[0]!), `${parcel.id}/${year}: isolated frontage road`).toBe(true)
        }
      }
    }
  })
  it('roundtrips the selected engine and slices all dates without re-running terrain or city generation', () => {
    const project = parseProject(JSON.stringify({ version: 2, config: inland.config, snapshot: inland, annotations: [], style: 'standard', layers: { buildings: true, roads: true, railway: true, labels: true, facilities: true, terrain: true, grid: false } }))
    expect(project.config.cityEngine).toBe('layout'); expect(project.snapshot!.generatorVersion).toBe(LAYOUT_GENERATOR_VERSION)
    const historical = JSON.stringify(project.snapshot!.timeline!.buildings)
    for (const year of [1650, 1770, 1850, 1900, 1955, 2025, 1850, 2025]) {
      const map = sliceCityAtYear(project.snapshot!, year)
      expect(map.year).toBe(year)
      expect(map.buildings.every(b => b.builtYear! <= year)).toBe(true)
      expect(map.roads.every(r => (r.builtYear ?? 1650) <= year)).toBe(true)
    }
    expect(JSON.stringify(project.snapshot!.timeline!.buildings)).toBe(historical)
    expect(inlandSourceCalls).toBe(1); expect(coastSourceCalls).toBe(1)
    expect(project.snapshot!.areas.some(area => area.landUse === 'meadow')).toBe(true)
  })
})
