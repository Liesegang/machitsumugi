import type { CityMap, GrowthEvent, Point, Road, TimelineVersion } from './types'
import { boundsOf, corridorPolygon, distance, overlaps, polygonOverlapsRegion, regionArea, subtractRegions } from './geometry'
import type { PolygonRegion } from './geometry'
import { PlanarRoadGraph, controlledRoad, extractStreetBlocks } from './road-graph'
import type { RoadRole, SimulatedRoad } from './road-graph'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute, PlanningTerrain } from './road-planner'
import { assignRoadTraffic } from './road-traffic'
import type { TrafficDestination } from './road-traffic'
import { renewExistingRoad } from './road-renewal'
import { bankConnectionProjects } from './bank-connection-bridges'
import { neighborhoodConnections } from './neighborhood-connections'
import { surveyedProjectCost } from './surveyed-project-cost'
import { createLandholdingCost } from './road-alignment'
import { createCityTimeline } from './timeline'
import { applyActualTransportLand } from './actual-stock-transport-land'

export interface ActualStockProject { kind: 'renewal' | 'connection'; roadIds: string[]; cost: number; benefit: number; dailyVehicleMinutesSaved: number }
type RegionRecord = PolygonRegion & { bounds: ReturnType<typeof boundsOf> }
const privateRoad = (road: Road) => /^(facility-access-|castle-path-|station-approach|station-access)/.test(road.id) || road.role === 'access' && /駅/.test(road.reason ?? '')
const corridors = (points: Point[], width: number): PolygonRegion[] => points.slice(1).flatMap((b, i) => distance(points[i]!, b) > .001 ? [{ polygon: corridorPolygon(points[i]!, b, width / 2) }] : [])
function regionIndex(regions: PolygonRegion[]) {
  const bins = new Map<string, RegionRecord[]>()
  for (const region of regions) {
    const record = { ...region, bounds: boundsOf(region.polygon) }
    for (let x = Math.floor(record.bounds.minX / 100); x <= Math.floor(record.bounds.maxX / 100); x++) for (let y = Math.floor(record.bounds.minY / 100); y <= Math.floor(record.bounds.maxY / 100); y++) {
      const key = `${x}:${y}`, bucket = bins.get(key) ?? []; bucket.push(record); bins.set(key, bucket)
    }
  }
  return (region: PolygonRegion) => {
    const bounds = boundsOf(region.polygon), found = new Set<RegionRecord>()
    for (let x = Math.floor(bounds.minX / 100); x <= Math.floor(bounds.maxX / 100); x++) for (let y = Math.floor(bounds.minY / 100); y <= Math.floor(bounds.maxY / 100); y++) for (const record of bins.get(`${x}:${y}`) ?? []) if (overlaps(bounds, record.bounds)) found.add(record)
    return [...found]
  }
}
function replaceCurrent<T extends { id: string }>(versions: TimelineVersion<T>[], changed: Set<string>, values: T[], year: number) {
  return [...versions.flatMap(v => !changed.has(v.value.id) || v.to !== undefined && v.to <= year || v.from > year ? [v] : v.from < year ? [{ ...v, to: year }] : []), ...values.filter(v => changed.has(v.id)).map(value => ({ from: year, value }))]
}

/** One terminal2025 appraisal reconciles built demand with the earlier land
 * integration approximation. Earlier views receive no future stock, geometry
 * or tax receipts. This is not a second city/erosion/building simulation.
 */
export function finalizeActualStockTransport(map: CityMap, options: { funds: number; terrain: PlanningTerrain; core?: Point[] | null }) {
  const year = map.year ?? map.timeline?.throughYear ?? 2025, marker = `actual-stock-transport-${year}`
  const unchanged = () => ({ map, spent: 0, remainingFunds: options.funds, projects: [] as ActualStockProject[] })
  if (year !== 2025 || map.config.density <= 0 || !Number.isFinite(options.funds) || options.funds <= 0 || map.events?.some(event => event.id === marker)) return unchanged()
  const parcels = new Map((map.parcels ?? []).map(parcel => [parcel.id, parcel]))
  const cells = map.buildings.filter(b => (b.occupiedHouseholds ?? 0) > 0).flatMap(building => {
    const parcel = parcels.get(building.parcelId ?? '')
    return parcel ? [{ point: parcel.entrance, households: building.occupiedHouseholds!, roadId: parcel.roadId, area: regionArea(parcel), frontageDepth: 40 }] : []
  })
  if (!cells.length) return unchanged()
  const base = new PlanarRoadGraph()
  base.roads.push(...map.roads.map(road => ({ ...road, builtYear: road.builtYear ?? 1650, role: road.role ?? 'lane', phase: 'suburban', reason: road.reason ?? '', constructionCost: 0 } as SimulatedRoad)))
  let graph = base.fork()
  const publicBase = new PlanarRoadGraph()
  publicBase.roads.push(...graph.roads.filter(r => !privateRoad(r) && !controlledRoad(r) && r.role !== 'farm' && !r.bridge))
  const publicGraph = publicBase.fork(), gate = (point: Point) => publicGraph.nearest(point, 600)?.point
  const destinations: TrafficDestination[] = []
  const addDestination = (point: Point | undefined, weight: number) => { const p = point && gate(point); if (p) destinations.push({ point: p, weight }) }
  for (const station of map.stations) addDestination(station.entrance ?? station.point, 1)
  for (const facility of map.facilities) if (['shop', 'port', 'hospital', 'castle'].includes(facility.kind)) addDestination(facility.point, facility.kind === 'hospital' ? .25 : facility.kind === 'castle' ? .6 : 1.2)
  if (!destinations.length) return unchanged()
  const planner = new RoadPlanner({ width: map.width, height: map.height, areas: map.areas, core: options.core ?? null, terrain: options.terrain, landCost: createLandholdingCost(map.width, map.height, map.config.seed) })
  planner.setRailwayCorridors(map.railways)
  const protectedRegions: PolygonRegion[] = [
    ...map.buildings.map(b => ({ polygon: b.polygon })),
    ...map.stations.flatMap(s => s.buildingPolygon ? [{ polygon: s.buildingPolygon }] : []),
    ...map.areas.filter(a => a.kind === 'park' || a.landUse === 'wetland' || /^(castle-|historic-core|facility-|civic-)/.test(a.id)),
    ...(map.parcels ?? []).flatMap(p => p.access ? corridors(p.access, 2.8) : []),
  ]
  const protectedNear = regionIndex(protectedRegions), projects: ActualStockProject[] = [], acquired: PolygonRegion[] = []
  let spent = 0, serial = 0, assignments = 0
  const assign = (roads: readonly Road[]) => { assignments++; return assignRoadTraffic({ roads, cells, destinations, year }) }
  let traffic = assign(graph.roads)
  const initialDailyVehicleMinutes = traffic.totalDailyVehicleMinutes, initialUnservedPeakTrips = traffic.unservedPeakTrips
  const available = () => options.funds - spent
  const rowNear = regionIndex(map.roads.flatMap(r => corridors(r.points, r.width)))
  const newLand = (paths: { path: Point[]; width: number }[]) => paths.flatMap(path => corridors(path.path, path.width).flatMap(region => subtractRegions(region, rowNear(region))).filter(region => regionArea(region) > .001))
  const protectedLand = (strips: PolygonRegion[]) => strips.some(strip => protectedNear(strip).some(obstacle => polygonOverlapsRegion(strip.polygon, obstacle) && subtractRegions(strip, [obstacle]).reduce((sum, region) => sum + regionArea(region), 0) < regionArea(strip) - .001))
  const accept = (staged: PlanarRoadGraph, cost: number, strips: PolygonRegion[], kind: ActualStockProject['kind'], roadIds: string[]) => {
    if (!Number.isFinite(cost) || cost <= 0 || cost > available() || protectedLand(strips)) return null
    const next = assign(staged.roads), saved = traffic.totalDailyVehicleMinutes - next.totalDailyVehicleMinutes, benefit = saved * 250 * 8 * .02 / 60
    if (!(saved > 0) || !Number.isFinite(benefit) || benefit <= cost || next.unservedPeakTrips > traffic.unservedPeakTrips + 1e-7) return null
    graph = staged; traffic = next; spent += cost; acquired.push(...strips)
    const project = { kind, roadIds, cost, benefit, dailyVehicleMinutesSaved: saved }; projects.push(project)
    planner.setRailwayRoadNetwork(graph.roads)
    return project
  }

  // At most four surveyed renewal alternatives, and two accepted corridors.
  const rejected = new Set<string>()
  for (let attempt = 0, accepted = 0; attempt < 4 && accepted < 2 && available() > 0; attempt++) {
    const staged = graph.fork(), before = new Map(staged.roads.map(r => [r.id, r]))
    planner.setRailwayRoadNetwork(staged.roads)
    const result = renewExistingRoad({ graph: staged, cells, destinations, traffic, year, funds: available(), actualStock: true, planner: {
      validate: (points, width, bridge) => !staged.roads.some(r => r.points === points && (privateRoad(r) || rejected.has(`${r.id}:${width}`))) && planner.validate(points, width, bridge) && !protectedLand(newLand([{ path: points, width }])),
      railwayWidthAllows: (points, oldWidth, newWidth, role) => planner.railwayWidthAllows(points, oldWidth, newWidth, role),
      cost: (points, role, bridge) => planner.cost(points, role, bridge),
    } })
    if (!result) break
    const strips = newLand(result.roads.map(r => ({ path: r.points, width: r.width })))
    if (accept(staged, result.cost, strips, 'renewal', result.roads.map(r => r.id))) accepted++
    else for (const road of result.roads) if (before.has(road.id)) rejected.add(`${road.id}:${road.width}`)
  }

  type Connection = { route: PlannedRoute; width: number }
  let connectionAppraisals = 0, connections = 0
  const evaluated = new WeakMap<Point[], { staged: PlanarRoadGraph; cost: number; strips: PolygonRegion[]; ids: string[]; next: ReturnType<typeof assignRoadTraffic>; benefit: number; saved: number }>()
  const networkBenefit = (route: PlannedRoute, width: number, role: RoadRole) => {
    if (connectionAppraisals >= 4 || connections >= 2) return undefined
    const staged = graph.fork(), chunks: { path: Point[]; bridge: boolean; reused: boolean }[] = []
    let path: Point[] = [route.points[0]!], mode = false
    const wet = (a: Point, b: Point) => { const n = Math.max(1, Math.ceil(distance(a, b))); for (let i = 0; i <= n; i++) if (options.terrain.waterAt({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n })) return true; return false }
    for (let i = 1; i < route.points.length; i++) {
      const bridge = wet(route.points[i - 1]!, route.points[i]!)
      if (path.length > 1 && bridge !== mode) { chunks.push({ path, bridge: mode, reused: false }); path = [route.points[i - 1]!] }
      mode = bridge; path.push(route.points[i]!)
    }
    if (path.length > 1) chunks.push({ path, bridge: mode, reused: false })
    for (const chunk of chunks) chunk.reused = !!staged.reusableRoad(chunk.path, { width, role: chunk.bridge ? 'bridge' : role, bridge: chunk.bridge, level: 0, controlledAccess: false })
    const priced = surveyedProjectCost({ route, role, chunks, surveyCost: (points, physicalRole, bridge) => planner.cost(points, physicalRole, bridge) })
    const strips = newLand(chunks.filter(c => !c.reused).map(c => ({ path: c.path, width })))
    if (!Number.isFinite(priced.newTotal) || priced.newTotal <= 0 || priced.newTotal > available() || protectedLand(strips) || !planner.validate(route.points, width, route.bridgeLength > 0) || !planner.railwayAllows(route.points, role) || chunks.some(chunk => !chunk.reused && !planner.railwayWidthAllows(chunk.path, .001, width, role))) return 0
    const additions = chunks.map((chunk, i) => ({ points: chunk.path, metadata: { id: `actual-stock-${year}-${serial++}`, builtYear: year, phase: 'suburban', role: chunk.bridge ? 'bridge' as const : role, bridge: chunk.bridge, width, kind: 'local' as const, constructionCost: priced.costs[i]!, reason: '既存建物の交通需要に基づく接続事業', preserveEndpoint: true } }))
    if (!staged.addBatch(additions)) return 0
    connectionAppraisals++
    const next = assign(staged.roads), saved = traffic.totalDailyVehicleMinutes - next.totalDailyVehicleMinutes, benefit = saved * 250 * 8 * .02 / 60
    if (!(saved > 0) || benefit <= priced.newTotal || next.unservedPeakTrips > traffic.unservedPeakTrips + 1e-7) return 0
    evaluated.set(route.points, { staged, cost: priced.newTotal, strips, ids: staged.roads.filter(r => !graph.roads.some(old => old.id === r.id)).map(r => r.id), next, benefit, saved })
    return benefit
  }
  const commit = (project: Connection) => {
    const result = evaluated.get(project.route.points)
    if (!result || result.cost > available() || connections >= 2) return false
    graph = result.staged; traffic = result.next; spent += result.cost; acquired.push(...result.strips); connections++
    projects.push({ kind: 'connection', roadIds: result.ids, cost: result.cost, benefit: result.benefit, dailyVehicleMinutesSaved: result.saved })
    planner.setRailwayRoadNetwork(graph.roads)
    return true
  }
  // Generators survey real occupied bank/local anchors; they do not create a
  // street-count target. Counterfactual results are the sole commit authority.
  for (let round = 0; round < 2 && connections < 2 && connectionAppraisals < 4; round++) {
    const input = { graph, planner, cells, year, settlement: map.config.settlement ?? 'regional-city', cache: new Map<string, PlannedRoute | null>(), availableFunds: available, trafficTime: (a: Point, b: Point) => traffic.travelTime(a, b), networkBenefit }
    let connected = false
    for (const project of bankConnectionProjects(input)) { if (commit(project)) { connected = true; break } if (connectionAppraisals >= 4) break }
    if (!connected && connectionAppraisals < 4) for (const project of neighborhoodConnections({ ...input, cache: new Map() })) { if (commit(project)) { connected = true; break } if (connectionAppraisals >= 4) break }
    if (!connected) break
  }

  const original = new Map(map.roads.map(r => [r.id, r])), changed = new Set(graph.roads.filter(r => { const old = original.get(r.id); return !old || old.width !== r.width || old.role !== r.role || old.modifiedYear !== r.modifiedYear || JSON.stringify(old.points) !== JSON.stringify(r.points) }).map(r => r.id))
  const roads = graph.roads.map(r => changed.has(r.id) ? r : original.get(r.id)!)
  const history = map.timeline ?? createCityTimeline(map)
  const events: GrowthEvent[] = [...(map.events ?? []), { id: marker, year, kind: 'road', entityId: 'road-network', reason: `既存住宅・公共施設間の交通調査に基づき、道路予算の残額で${projects.length}件の拡幅・接続事業を実施` }, ...projects.flatMap(p => p.roadIds.map(id => ({ id: `actual-stock-road-${year}-${id}`, year, kind: 'road' as const, entityId: id, reason: `既存住宅の交通需要に基づく${p.kind === 'renewal' ? '拡幅' : '接続'}事業（工事費${p.cost.toFixed(1)}、便益${p.benefit.toFixed(1)}）` })))]
  const geometryChanged = roads.some(r => !original.has(r.id) || JSON.stringify(r.points) !== JSON.stringify(original.get(r.id)!.points))
  const blocks = geometryChanged ? extractStreetBlocks(roads).map(polygon => {
    let hash = 2166136261
    for (const point of polygon) for (const n of [Math.round(point.x * 10), Math.round(point.y * 10)]) hash = Math.imul(hash ^ n, 16777619)
    return { id: `block-${hash >>> 0}`, polygon }
  }) : map.blocks
  const snapshots = map.snapshots?.map(snapshot => snapshot.year === year ? { ...snapshot, roads: roads.length } : snapshot)
  const historySnapshots = history.snapshots?.map(snapshot => snapshot.year === year ? { ...snapshot, roads: roads.length } : snapshot)
  const stage = { phase: 'actual-stock', year, roadsAdded: roads.length - map.roads.length, constructionCost: spent, reason: '既存住宅と公共施設の交通需要に基づく道路予算内の整備' }
  const growthLog = projects.length ? [...(map.growthLog ?? []), stage] : map.growthLog
  const historyGrowth = projects.length ? [...(history.growthLog ?? []), stage] : history.growthLog
  const result = { ...map, roads, blocks, snapshots, growthLog, events, timeline: { ...history, roads: replaceCurrent(history.roads, changed, roads, year), snapshots: historySnapshots, growthLog: historyGrowth, events } }
  return { map: applyActualTransportLand(result, { year, strips: acquired, roadIds: [...new Set(projects.flatMap(p => p.roadIds))] }), spent, remainingFunds: options.funds - spent, projects,
    diagnostics: { assignments, households: cells.reduce((sum, c) => sum + c.households, 0), destinations: destinations.length, initialDailyVehicleMinutes, finalDailyVehicleMinutes: traffic.totalDailyVehicleMinutes, initialUnservedPeakTrips, finalUnservedPeakTrips: traffic.unservedPeakTrips } }
}
