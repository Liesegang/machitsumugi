import type { Area, CityConfig, Point, Railway } from './types'
import type { PolygonRegion } from './geometry'
import { corridorPolygon, distance, pointInRegion, polygonOverlapsRegion } from './geometry'
import type { PlanningTerrain } from './road-planner'
import { RoadPlanner } from './road-planner'
import { RegionalRoadPlanner } from './regional-road-planner'
import { planModernTransport } from './modern-transport'
import type { LayoutRoadResult } from './layout-first-roads'
import type { RoadProject } from './road-graph'

export interface LayoutRegionalInput {
  config: CityConfig; width: number; height: number; terrain: PlanningTerrain; areas: Area[]
  reserves?: PolygonRegion[]; railways?: Railway[]
  transport: Pick<LayoutRoadResult, 'graph' | 'roads' | 'zones'>
}
export interface LayoutRegionalDiagnostics {
  proposed: ('bypass' | 'expressway')[]; completed: ('bypass' | 'expressway')[]
  unavailable: { kind: 'bypass' | 'expressway'; reason: string }[]
  /** Explicit finite scenario credits and trip generators, not historical accounts. */
  initialFunds: number; spent: number; householdTripGenerators: number; jobTripGenerators: number
}

/** Optional regional infrastructure is designed atomically before housing.
 * Reuses the actual modern-route/IC engineering programme, without the annual
 * city economy. Every enabled corridor still needs real land and full ramps. */
export function augmentLayoutFirstRegional(input: LayoutRegionalInput) {
  const { config, width, height, terrain, transport } = input, { graph } = transport
  const requested = (['bypass', 'expressway'] as const).filter(kind => config[kind])
  const mapScale = Math.sqrt(width * height / 12_000_000), density = Math.max(0, Math.min(1, config.density / 100))
  const populationScale = config.settlement === 'metropolis' ? 40000 : config.settlement === 'regional-city' ? 18000 : config.settlement === 'rural-town' ? 2500 : 300
  const householdTripGenerators = Math.round(populationScale * Math.max(.6, mapScale) * (.4 + .6 * density))
  const jobTripGenerators = Math.round(householdTripGenerators * .55 + (config.settlement === 'village' ? 0 : 3000 * mapScale))
  const initialFunds = Math.round((width + height) * 2 * (config.settlement === 'metropolis' ? 32 : config.settlement === 'regional-city' ? 25 : config.settlement === 'rural-town' ? 10 : 3))
  const diagnostics: LayoutRegionalDiagnostics = { proposed: [...requested], completed: [], unavailable: [], initialFunds, spent: 0, householdTripGenerators, jobTripGenerators }
  if (!requested.length) return { roads: graph.roads, diagnostics }
  if (!terrain.continuationTerrain) {
    diagnostics.unavailable = requested.map(kind => ({ kind, reason: '区域外へ続く実地形を測量できません。' }))
    return { roads: graph.roads, diagnostics }
  }
  const reserves = input.reserves ?? []
  const protectedAt = (p: Point) => reserves.some(region => pointInRegion(p, region))
  const landCost = (p: Point) => {
    if (protectedAt(p)) return Infinity
    let urbanLand = 0
    for (const zone of transport.zones) {
      const d = distance(zone.center, p) / Math.max(1, zone.radius)
      if (d < 1.2) urbanLand = Math.max(urbanLand, (1 - d / 1.2) ** 2 * (zone.kind === 'historic' ? 8 : 3.5) * zone.density)
    }
    return urbanLand
  }
  const environment = { width, height, terrain, areas: input.areas, core: null, landCost, exactLandCost: true }
  const planner = new RoadPlanner(environment), regionalPlanner = new RegionalRoadPlanner(environment)
  planner.setRailwayCorridors(input.railways ?? []); regionalPlanner.setRailwayCorridors(input.railways ?? [])
  planner.setRailwayRoadNetwork(graph.roads); regionalPlanner.setRailwayRoadNetwork(graph.roads)
  const clearGrounds = (points: Point[], roadWidth: number) => {
    if (!reserves.length) return true
    for (let i = 1; i < points.length; i++) {
      const strip = corridorPolygon(points[i - 1]!, points[i]!, roadWidth / 2 + .75)
      for (const region of reserves) if (polygonOverlapsRegion(strip, region)) return false
    }
    return true
  }
  for (const kind of requested) {
    const year = kind === 'bypass' ? 1975 : 1985
    const project = planModernTransport({ graph, planner, regionalPlanner, width, height, households: householdTripGenerators, jobs: jobTripGenerators, funds: initialFunds - diagnostics.spent, kind, year, planningLimits: { maxPairs: 2, maxAnchors: 3, maxDeltas: 3, maxNodes: 2400 } })
    if (!project) { diagnostics.unavailable.push({ kind, reason: '地形・接続・曲線半径・工費を満たす連続した計画が成立しませんでした。' }); continue }
    const routeWidth = [{ points: project.mainline.points, width: project.width, role: project.role }, ...project.accesses.map(access => ({ points: access.route.points, width: access.width, role: access.role }))]
    if (routeWidth.some(route => !clearGrounds(route.points, route.width) || !planner.railwayWidthAllows(route.points, .01, route.width, route.role))) {
      diagnostics.unavailable.push({ kind, reason: '施設の用地または鉄道の保護幅を確保できませんでした。' }); continue
    }
    const prefix = `layout-${kind}`
    const metadata = { builtYear: year, phase: 'regional-modernization', reason: kind === 'bypass' ? '中心市街地を迂回する広域道路' : '区域外へ続く高速道路と実際に接続したインターチェンジ', constructionCost: 0, kind: 'arterial' as const }
    const projects: RoadProject[] = [{ points: project.mainline.points, metadata: { ...metadata, id: `${prefix}-mainline`, role: project.role, width: project.width, level: kind === 'expressway' ? 1 : 0, controlledAccess: kind === 'expressway', boundaryContinuation: true, bridge: project.mainline.bridgeLength > 0, constructionCost: project.mainline.cost }, requireConnection: false }]
    for (const [index, access] of project.accesses.entries()) projects.push({ points: access.route.points, metadata: { ...metadata, id: `${prefix}-access-${index}`, role: access.role, width: access.width, level: access.level, controlledAccess: access.controlledAccess, preserveEndpoint: true, constructionCost: access.route.cost }, requireConnection: true })
    if (!graph.addBatch(projects)) { diagnostics.unavailable.push({ kind, reason: '本線・取付道路・ランプを一体として接続できませんでした。' }); continue }
    diagnostics.completed.push(kind); diagnostics.spent += project.cost
    planner.setRailwayRoadNetwork(graph.roads); regionalPlanner.setRailwayRoadNetwork(graph.roads)
  }
  return { roads: graph.roads, diagnostics }
}
