import type { Area, CityType, Point, TimelineVersion } from './types'
import { renewExistingRoad } from './road-renewal'
import { frontageCapacity } from './frontage-supply'
import { PlanarRoadGraph, extractStreetBlocks, projectOnRoadSegment, roadLength, roadTravelSpeed } from './road-graph'
import type { RoadRole, SimulatedRoad } from './road-graph'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute, PlanningTerrain } from './road-planner'
import { createLandholdingCost } from './road-alignment'
import { diverseOpportunityBatches, sampleLandOpportunities } from './land-opportunities'
import { transportProjects } from './transport-investment'
import { valleySettlementCandidates } from './valley-settlements'
import { RegionalRoadPlanner } from './regional-road-planner'
import { planModernTransport } from './modern-transport'
import { createRoadProjectCache } from './road-project-cache'
import { investInNeighborhood } from './neighborhood-connections'
import { foundingMarketGates } from './founding-market'
import { commitValleyThroughRoad, planValleyThroughRoad } from './valley-through-road'
import { developmentClimbMinutes, surveyDevelopmentSite } from './development-terrain'
import { isConstructionYear, simulationEndYear, simulationYears } from './simulation-calendar'

export interface UrbanGrowthInput {
  width: number; height: number; seed: string; type: CityType; center: Point; core: Point[] | null; areas: Area[]
  arterial: boolean; railway: boolean; stationPoints: Point[]; bridgeSites?: Point[]; density?: number
  era?: 'historic' | 'railway' | 'present'; terrainModel?: PlanningTerrain
  onProgress?: (year: number) => void
  onPreview?: (roads: SimulatedRoad[], year: number) => void
  onCivicPopulation?: (year: number, population: { point: Point; households: number }[]) => void
  stationAccessProjects?: { station: Point; route: PlannedRoute }[]
  railwayCorridors?: { id: string; points: Point[]; builtYear?: number }[]
  onRailwayPlanning?: (state: { roads: SimulatedRoad[]; centers: GrowthCenter[] }) => { stationPoints: Point[]; stationAccessProjects?: { station: Point; route: PlannedRoute }[]; railwayCorridors?: { id: string; points: Point[]; builtYear?: number }[] }
  untilYear?: number
  targetYear?: number
  settlement?: 'village' | 'rural-town' | 'regional-city' | 'metropolis'
  populationTrend?: 'declining' | 'stable' | 'growing'
  mapSize?: 'small' | 'medium' | 'large'
  expressway?: boolean
  bypass?: boolean
}
export interface GrowthCenter { point: Point; kind: 'historic' | 'station' | 'suburb' | 'industrial'; weight: number; activeYear: number; catchment: number }
export interface GrowthStage { phase: string; roadsAdded: number; year: number; reason: string; households: number; unmetHouseholds: number; constructionCost: number }
export interface DevelopmentCell { id: string; point: Point; households: number; jobs: number; capacity: number; servicedCapacity?: number; servicedYear?: number; builtYear?: number; accessibility: number; landValue: number; ownerResistance: number; area?: number; frontageDepth?: number }
export interface DemandTarget { households: number; jobs: number }
export interface UrbanGrowthResult { roads: SimulatedRoad[]; roadHistory: TimelineVersion<SimulatedRoad>[]; centers: GrowthCenter[]; growthLog: GrowthStage[]; developmentCells: DevelopmentCell[]; demandSchedule: ({ year: number } & DemandTarget)[]; blocks: Point[][] }
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
function randomFrom(seed: string) { let h = 2166136261; for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
function inside(p: Point, polygon: Point[]) { let hit = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i]!, b = polygon[j]!; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit } return hit }

/** Fictional scenario assumptions, in households/jobs. These are not empirical Japanese forecasts. */
export interface DemographicScenario { density?: number; type: CityType; settlement?: UrbanGrowthInput['settlement']; populationTrend?: UrbanGrowthInput['populationTrend']; mapSize?: UrbanGrowthInput['mapSize'] }
export function scenarioDemandAtYear(input: DemographicScenario, year: number): DemandTarget {
  const p = clamp(input.density ?? 65, 0, 100) / 100
  const settlement = input.settlement ?? 'regional-city', trend = input.populationTrend ?? 'growing'
  const peakYear = trend === 'stable' ? 1985 : settlement === 'village' ? 1960 : settlement === 'rural-town' ? 1990 : 2000
  const demandYear = trend === 'growing' ? year : Math.min(year, peakYear)
  const old = 12 * clamp(demandYear - 1700, 0, 150), industrial = 22 * clamp(demandYear - 1850, 0, 100), modern = 95 * clamp(demandYear - 1950, 0, 75)
  const oldScale = input.type === 'newtown' ? .14 : input.type === 'post' ? .66 : input.type === 'onsen' ? .52 : input.type === 'temple' ? .78 : input.type === 'port' ? 1.12 : 1
  const modernScale = input.type === 'newtown' ? 1.42 : input.type === 'post' ? .72 : input.type === 'onsen' ? .64 : input.type === 'temple' ? .86 : input.type === 'port' ? 1.08 : 1
  const base = settlement === 'village' ? 35 : settlement === 'rural-town' ? 60 : settlement === 'metropolis' ? 180 : 100, scale = settlement === 'village' ? .014 : settlement === 'rural-town' ? .22 : 1
  // A larger viewport includes additional neighbouring markets. Population
  // grows with its linear reach (1/2/3), not its area (1/4/9); extra countryside
  // therefore remains countryside. Village demand belongs to one settlement.
  const regionalReach = settlement === 'village' || settlement === 'rural-town' ? 1 : input.mapSize === 'large' ? 3 : input.mapSize === 'medium' ? 2 : 1
  // Matsumoto's 2020 DID reference is 149,054 people / 32.57km² (municipal
  // statistical report). A regional urban crop includes countryside, so the
  // scenario remains below that density: 15,668 households at the default,
  // assuming 2.2 people/household. This is a fiction-setting scale, not a forecast.
  // Only post-1950 regional growth changes; village/rural/metro and history retain their scales.
  const metropolitanModern = settlement === 'metropolis' ? 4.6 : settlement === 'regional-city' ? 2.8 : 1, metropolitanIndustry = settlement === 'metropolis' ? 1.7 : 1
  const retention = settlement === 'village' ? .28 : settlement === 'rural-town' ? .62 : .82
  const decline = trend === 'declining' ? 1 - clamp((year - peakYear) / (2025 - peakYear), 0, 1) * (1 - retention) : 1
  const households = Math.max(1, Math.round((base + p * ((old + industrial * metropolitanIndustry) * oldScale + modern * modernScale * metropolitanModern) * scale * regionalReach) * decline))
  return { households, jobs: Math.round(households * (input.type === 'port' ? .52 : input.type === 'onsen' ? .54 : input.type === 'newtown' ? .26 : .36)) }
}

/**
 * Five-year land/transport simulation. Projects purchase service capacity or reduce network
 * travel time; there is no road-count target and no pre-subdivision of unoccupied land.
 */
export function simulateUrbanGrowth(input: UrbanGrowthInput): UrbanGrowthResult {
  input = { ...input }
  const settlement = input.settlement ?? 'regional-city', catchmentScale = settlement === 'village' ? .44 : settlement === 'rural-town' ? .72 : settlement === 'metropolis' ? 1.45 : 1
  const demandAt = (year: number) => scenarioDemandAtYear(input, year), foundingHouseholds = demandAt(1650).households
  const graph = new PlanarRoadGraph(), centers: GrowthCenter[] = [{ point: input.center, kind: 'historic', weight: input.type === 'newtown' ? .32 : 1.15, activeYear: 1650, catchment: (input.type === 'post' ? 780 : input.type === 'onsen' ? 510 : 640) * catchmentScale }]
  const growthLog: GrowthStage[] = [], demandSchedule: ({ year: number } & DemandTarget)[] = []
  const density = clamp(input.density ?? 65, 0, 100), endYear = simulationEndYear({ ...input, targetYear: input.untilYear ?? input.targetYear })
  type MarketCell = DevelopmentCell & { roadDistance: number; suitability: number; frontageDepth: number; formationCostPerHousehold: number }
  const landRandom = randomFrom(`${input.seed}:land-ownership`), cells: MarketCell[] = []
  const environment = { width: input.width, height: input.height, areas: input.areas, core: input.core, terrain: input.terrainModel, bridgeSites: input.bridgeSites, landCost: createLandholdingCost(input.width, input.height, input.seed) }
  const planner = new RoadPlanner(environment)
  const regionalPlanner = input.terrainModel?.continuationTerrain ? new RegionalRoadPlanner(environment) : null
  const opportunities = sampleLandOpportunities(input.width, input.height, input.center, landRandom)
  for (const opportunity of opportunities) {
    const point = opportunity.point
    const ownership = landRandom(), grade = input.terrainModel?.slope(point) ?? 0
    const forest = input.areas.some(a => a.kind === 'forest' && inside(point, a.polygon))
    if (!planner.suitable(point, 12) || forest || grade > .14) continue
    const formation = surveyDevelopmentSite({ slope: p => input.terrainModel?.slope(p) ?? 0, elevation: input.terrainModel?.elevation }, point)
    if (!formation.viable) continue
    // Broad inherited farming/ownership districts resist conversion; this is not per-house density noise.
    const inheritedFarming = .5 + .25 * Math.sin(point.x / 330 + .7) + .25 * Math.cos(point.y / 460 - point.x / 700)
    cells.push({ id: opportunity.id, point, area: opportunity.area, frontageDepth: clamp(opportunity.spacing * .38, 18, 40), households: 0, jobs: 0, capacity: Math.max(2, Math.round(opportunity.area / 950 * (.85 + landRandom() * .3))), accessibility: 0, landValue: 0, ownerResistance: clamp(.12 + ownership * .28 + inheritedFarming * .35, .1, .85), roadDistance: Infinity, suitability: formation.suitability * (1 - (input.terrainModel?.wetness?.(point) ?? 0) * .2), formationCostPerHousehold: formation.formationCostPerHousehold })
  }
  // A district commitment needs a surrounding supply of affordable pads, rather
  // than one flat point on a mountainside. Index static sites, but read current
  // vacancy when considering a project so occupied land is not sold twice.
  const districtSites = new Map<string, MarketCell[]>()
  for (const cell of cells) if (cell.formationCostPerHousehold < 12) {
    const key = `${Math.floor(cell.point.x / 330)}:${Math.floor(cell.point.y / 330)}`, bucket = districtSites.get(key) ?? []
    bucket.push(cell); districtSites.set(key, bucket)
  }
  const districtSupply = (point: Point) => {
    const x = Math.floor(point.x / 330), y = Math.floor(point.y / 330)
    let vacant = 0
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const cell of districtSites.get(`${x + dx}:${y + dy}`) ?? []) {
      if (distance(cell.point, point) < 330) vacant += cell.capacity - cell.households
      if (vacant >= 90) return vacant
    }
    return vacant
  }
  const ids = new Map<string, number>()
  const nextId = (phase: string, year: number) => { const key = `${phase}-${year}`, n = ids.get(key) ?? 0; ids.set(key, n + 1); return `${key}-${n}` }
  const addProject = (route: PlannedRoute, phase: string, year: number, role: RoadRole, reason: string, width: number, requireConnection = true, preserveEndpoint = false) => {
    const validator = route.boundaryContinuation && regionalPlanner ? regionalPlanner : planner
    if ((!preserveEndpoint && route.length < 20) || !validator.validate(route.points, width, route.bridgeLength > 0)) return 0
    // Bridge decks are explicit pieces, rather than labeling a complete cross-country route a bridge.
    const chunks: { path: Point[]; bridge: boolean }[] = []
    const crossesWater = (a: Point, b: Point) => {
      const n = Math.max(1, Math.ceil(distance(a, b)))
      for (let j = 0; j <= n; j++) if (validator.waterAt(lerp(a, b, j / n))) return true
      return false
    }
    let run: Point[] = [route.points[0]!], mode = crossesWater(route.points[0]!, route.points[1]!)
    for (let i = 1; i < route.points.length; i++) {
      const water = crossesWater(route.points[i - 1]!, route.points[i]!)
      if (water !== mode && run.length > 1) { chunks.push({ path: run, bridge: mode }); run = [route.points[i - 1]!]; mode = water }
      run.push(route.points[i]!)
    }
    if (run.length > 1) chunks.push({ path: run, bridge: mode })
    const length = chunks.reduce((sum, chunk) => sum + roadLength(chunk.path), 0)
    const projects = chunks.map((chunk, i) => ({ points: chunk.path, metadata: { id: nextId(phase, year), builtYear: year, phase, role: chunk.bridge ? 'bridge' as const : role, reason, width, kind: role === 'highway' && input.arterial && route.boundaryContinuation ? 'arterial' as const : 'local' as const, constructionCost: route.cost * roadLength(chunk.path) / Math.max(length, 1e-9), ...(chunk.bridge ? { bridge: true } : {}), ...(route.boundaryContinuation ? { boundaryContinuation: true } : {}), preserveEndpoint: preserveEndpoint || chunks.length > 1 }, requireConnection: i ? true : requireConnection }))
    // Bank approach, deck and exit form one project. A rejected mandatory
    // section must never leave a newly constructed road ending at the river.
    const added = projects.length === 1 ? Number(!!graph.add(projects[0]!.points, projects[0]!.metadata, projects[0]!.requireConnection)) : graph.addBatch(projects)?.length ?? 0
    if (added && phase === 'regional') input.onPreview?.(graph.roads, year)
    return added
  }
  const dryPoint = (point: Point, radius = 160) => {
    if (planner.suitable(point, 14)) return point
    for (let ring = 1; ring <= 7; ring++) for (let i = 0; i < 16; i++) {
      const angle = i * Math.PI / 8, candidate = { x: clamp(point.x + Math.cos(angle) * radius * ring / 4, 24, input.width - 24), y: clamp(point.y + Math.sin(angle) * radius * ring / 4, 24, input.height - 24) }
      if (planner.suitable(candidate, 14)) return candidate
    }
    return null
  }

  // Existing regional trade and field access predate the simulated town. They are not four rays from its center.
  const initialRandom = randomFrom(`${input.seed}:founding-trade`)
  let hub = dryPoint(input.core ? { x: input.center.x + 40, y: Math.max(...input.core.map(p => p.y)) + 72 } : input.center, 120) ?? input.center
  let wharf: Point | null = null
  if (input.type === 'port') {
    const seas = input.areas.filter(area => area.kind === 'water' && (area.id === 'sea' || area.id.startsWith('sea-')))
    const shores = seas.length ? seas : input.areas.filter(area => area.id === 'river')
    if (shores.length) {
      // Island coasts are inner rings of the sea polygon, not its map-edge ring.
      const nearest = shores.flatMap(shore => [shore.polygon, ...(shore.holes ?? [])].flatMap(ring => ring.map((p, i) => projectOnRoadSegment(input.center, p, ring[(i + 1) % ring.length]!).point))).sort((a, b) => distance(a, input.center) - distance(b, input.center))[0]!
      const d = distance(nearest, input.center) || 1
      wharf = dryPoint({ x: nearest.x + (input.center.x - nearest.x) / d * 85, y: nearest.y + (input.center.y - nearest.y) / d * 85 }, 80)
      if (wharf) hub = wharf
    }
  }
  // The accessible gate market, rather than the inaccessible castle enclosure, generates trade.
  centers[0]!.point = hub
  let terminals = [
    dryPoint({ x: 28, y: input.height * (.43 + initialRandom() * .21) }, 200),
    dryPoint({ x: input.width * (.30 + initialRandom() * .22), y: 28 }, 180),
    dryPoint({ x: input.width - 28, y: input.height * (.48 + initialRandom() * .25) }, 200),
    dryPoint({ x: input.width * (.36 + initialRandom() * .20), y: input.height - 28 }, 180),
  ].filter((p): p is Point => p !== null)
  let foundingReason = '隣接集落・市場・渡河点を結ぶ既存街道'
  const valleySurveys: PlannedRoute[] = []
  const boundary = (direction: Point) => {
    const ds = [direction.x > 0 ? (input.width - 28 - hub.x) / direction.x : direction.x < 0 ? (28 - hub.x) / direction.x : Infinity, direction.y > 0 ? (input.height - 28 - hub.y) / direction.y : direction.y < 0 ? (28 - hub.y) / direction.y : Infinity]
    const t = Math.min(...ds.filter(value => value > 0))
    return dryPoint({ x: hub.x + direction.x * t, y: hub.y + direction.y * t }, 180)
  }
  if (input.type === 'post') {
    terminals = [terminals[0]!, terminals[2]!]
    foundingReason = '峠・隣宿・渡河点の間を往来する一本の宿場街道'
  } else if (input.type === 'temple') {
    terminals = [dryPoint({ x: hub.x - 80, y: input.height - 28 }, 180), dryPoint({ x: 28, y: hub.y * .8 }, 180)].filter((p): p is Point => p !== null)
    foundingReason = '寺社の門へ向かう巡礼参道と周辺集落の通行路'
  } else if (input.type === 'onsen') {
    const channel = input.terrainModel?.channelAt?.(hub)
    const river = input.terrainModel?.rivers?.find(river => river.id === channel?.riverId) ?? input.terrainModel?.rivers?.find(river => river.id === 'river')
    if (river) for (const direction of valleySettlementCandidates({ river: river.points, origin: hub, candidates: cells.map(cell => cell.point), slope: p => input.terrainModel?.slope(p) ?? 0 })) {
      for (const settlement of direction.slice(0, 8)) {
        const route = planner.plan(hub, settlement, { role: 'lane', width: 4.5, allowBridge: false, maxNodes: 6000 })
        if (route && route.length <= distance(hub, settlement) * 1.8) { valleySurveys.push(route); break }
      }
    }
    terminals = []
    foundingReason = '湯場と谷の上流・下流集落を結ぶ谷沿いの往来'
  } else if (input.type === 'port') {
    terminals = [terminals[0]!, terminals[1]!]
    foundingReason = '船着場の荷揚げ場と内陸市場・生産地を結ぶ輸送路'
  } else if (input.type === 'newtown') {
    terminals = [boundary({ x: .12, y: -1 }), boundary({ x: -.12, y: 1 })].filter((p): p is Point => p !== null)
    foundingReason = '鉄道開業前の農村を通る旧道と耕作地への往来'
  }
  terminals = terminals.filter(Boolean)
  const foundingWidth = settlement === 'village' ? 4.5 : settlement === 'rural-town' ? 7 : input.type === 'onsen' ? 7 : input.type === 'post' ? 9 : input.type === 'temple' ? 10 : input.type === 'newtown' ? 7.5 : input.arterial ? 13 : 9
  const foundingRole: RoadRole = settlement === 'village' ? 'lane' : settlement === 'rural-town' ? 'collector' : input.arterial ? 'highway' : 'collector'
  let foundingCost = 0
  const surveyFoundingRoutes = (market: Point) => {
  for (const [i, terminal] of terminals.entries()) {
    const attachment = graph.nearest(terminal, Infinity)
    const start = i === 0 ? market : attachment?.point ?? market
    // Extending a trade route's degree-one end creates one through alignment.
    // A T/cross junction instead keeps its independent turning directions.
    const startHeading = i === 0 ? undefined : graph.openEndHeading(start)
    const options = { role: foundingRole, width: foundingWidth, allowBridge: true, startHeading, maxNodes: 20000 }
    const route = regionalPlanner ? regionalPlanner.toBoundary(start, terminal, options) : planner.plan(start, terminal, options)
    if (route) { foundingCost += route.cost; addProject(route, 'regional', 1650, foundingRole, foundingReason, foundingWidth, i !== 0) }
  }
  }
  surveyFoundingRoutes(hub)
  if (!graph.roads.length && input.core) {
    for (const gate of foundingMarketGates({ core: input.core, center: input.center, terminals, planner, role: foundingRole, width: foundingWidth })) {
      surveyFoundingRoutes(gate)
      if (!graph.roads.length) continue
      hub = gate; centers[0]!.point = hub
      break
    }
  }
  for (const route of valleySurveys) if (addProject(route, 'regional', 1650, 'lane', foundingReason, 4.5, graph.roads.length > 0)) foundingCost += route.cost
  if (!graph.roads.length && input.type === 'port') {
    // A fishing landing need not begin with a modern-width regional highway.
    // When hills prevent that route, connect to a nearby inland producer by an
    // older narrow cart lane; later development must grow from this real link.
    const shoreHeight = input.terrainModel?.elevation(hub) ?? 0
    const producers = cells.filter(cell => {
      const d = distance(cell.point, hub)
      return d >= 280 && d <= 700 && cell.suitability > .55 && planner.suitable(cell.point, 5) && (input.terrainModel?.elevation(cell.point) ?? shoreHeight + 2) > shoreHeight + 1
    }).map(cell => ({ cell, score: cell.suitability * (1 + Math.min(30, Math.max(0, (input.terrainModel?.elevation(cell.point) ?? 10) - shoreHeight)) / 30) / (100 + distance(cell.point, hub)) }))
      .sort((a, b) => b.score - a.score || a.cell.id.localeCompare(b.cell.id))
    for (const { cell } of producers) {
      const route = planner.plan(hub, cell.point, { role: 'lane', width: 5, maxNodes: 6000 })
      if (!route || route.length > distance(hub, cell.point) * 1.8) continue
      if (addProject(route, 'regional', 1650, 'lane', '船着場と近傍の陸上生産集落を結ぶ成立期の細い往来', 5, false)) { foundingCost += route.cost; break }
    }
  }
  // Agricultural access predates urbanisation. Productive sectors are acquired
  // from an existing route, then become accessible sources for the next sector.
  // Three fixed compass rays cannot explain a connected agricultural landscape.
  const agriculturalSectors: MarketCell[] = []
  const agriculturalCandidates = cells.filter(cell => distance(cell.point, input.center) > 480 && (input.terrainModel?.slope(cell.point) ?? 0) < .065 && cell.suitability > .65)
    .map(cell => ({ cell, score: cell.ownerResistance + (input.terrainModel?.wetness?.(cell.point) ?? .2) * .65 - (input.terrainModel?.slope(cell.point) ?? 0) * 4 }))
    .sort((a, b) => b.score - a.score || a.cell.id.localeCompare(b.cell.id))
  for (const { cell } of agriculturalCandidates) if (agriculturalSectors.every(other => distance(other.point, cell.point) > (settlement === 'village' ? 500 : settlement === 'rural-town' ? 400 : 320))) agriculturalSectors.push(cell)
  const pendingSectors = new Set(agriculturalSectors)
  while (pendingSectors.size) {
    let best: { cell: MarketCell; near: NonNullable<ReturnType<PlanarRoadGraph['nearest']>>; score: number } | null = null
    for (const cell of pendingSectors) {
      const near = graph.nearest(cell.point, 620)
      if (!near) continue
      if (near.distance <= 150) { pendingSectors.delete(cell); continue }
      const score = (cell.ownerResistance + .3) / (100 + near.distance)
      if (!best || score > best.score) best = { cell, near, score }
    }
    if (!best) break
    pendingSectors.delete(best.cell)
    const route = planner.plan(best.near.point, best.cell.point, { role: 'farm', width: 3.5, maxNodes: 3500 })
    // Avoid costly hillside detours; an inaccessible sector remains uncultivated.
    if (route && route.length < best.near.distance * 1.55 && route.cost < 700) addProject(route, 'regional', 1650, 'farm', '耕作適地のまとまりへ旧街道・既存農道から接続する農道', 3.5)
  }
  growthLog.push({ phase: 'regional', year: 1650, roadsAdded: graph.roads.length, reason: '成立以前の街道・渡河・耕作地へのアクセス', households: foundingHouseholds, unmetHouseholds: 0, constructionCost: foundingCost })
  if (!graph.roads.length) return { roads: [], roadHistory: [], centers, growthLog, developmentCells: cells, demandSchedule, blocks: [] }
  const inheritedCorridor = graph.roads.filter(road => road.role !== 'farm')
  // Retainer/merchant grants follow a castle edge and its outward gate approach.
  // Only the accessible, dry adjoining quarters inherit this survey: the rest
  // of the settlement keeps older property/terrain routes. No streets are laid
  // out until occupied land actually needs a connected frontage project.
  type HistoricQuarter = { origin: Point; along: Point; outward: Point; extent: number; depth: number }
  const historicQuarters: HistoricQuarter[] = []
  if (input.type === 'castle' && input.core) {
    const candidates = input.core.map((a, i, polygon) => {
      const b = polygon[(i + 1) % polygon.length]!, length = distance(a, b), along = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
      const outward = { x: along.y, y: -along.x }, origin = lerp(a, b, .5)
      const site = { x: origin.x + outward.x * 210, y: origin.y + outward.y * 210 }
      const near = graph.nearest(site, 350), grade = input.terrainModel?.slope(site) ?? 0
      return { origin, along, outward, extent: length * .65 + 100, depth: 430, length, site, score: near ? 1 / (100 + near.distance) - grade * .04 : -Infinity }
    }).filter(q => q.length > 170 && q.score > -Infinity && planner.suitable(q.site, 7))
      .sort((a, b) => b.score - a.score)
    for (const quarter of candidates) {
      // One gate quarter and a distinct adjoining quarter are enough to form a
      // historic nucleus; overlapping rotated grants would recreate a quilt.
      if (historicQuarters.some(q => q.outward.x * quarter.outward.x + q.outward.y * quarter.outward.y > .45)) continue
      historicQuarters.push(quarter)
      if (historicQuarters.length === 2) break
    }
  }
  const quarterAt = (point: Point) => historicQuarters.find(q => {
    const x = point.x - q.origin.x, y = point.y - q.origin.y
    return Math.abs(x * q.along.x + y * q.along.y) < q.extent && x * q.outward.x + y * q.outward.y > 48 && x * q.outward.x + y * q.outward.y < q.depth
  })
  const corridorDistances = new Map<string, number>()
  if (input.type === 'post' || input.type === 'onsen') for (const cell of cells) {
    let d = Infinity
    for (const road of inheritedCorridor) for (let i = 1; i < road.points.length; i++) d = Math.min(d, distance(projectOnRoadSegment(cell.point, road.points[i - 1]!, road.points[i]!).point, cell.point))
    corridorDistances.set(cell.id, d)
  }

  // Productive, actually connected farming districts can support small local
  // markets. Their demand is a share of the same population, not extra houses.
  const villageCandidates = agriculturalSectors.filter(cell => distance(cell.point, hub) > 700 && distance(cell.point, hub) < Math.max(1900, Math.min(input.width, input.height) * .65) && (graph.nearest(cell.point, 12)?.distance ?? Infinity) < 12)
    .map(cell => ({ cell, productiveArea: cells.filter(other => distance(other.point, cell.point) < 280 && other.suitability > .65).reduce((sum, other) => sum + (other.area ?? 0), 0) }))
    .filter(candidate => candidate.productiveArea > 90000).sort((a, b) => b.productiveArea - a.productiveArea || a.cell.id.localeCompare(b.cell.id))
  for (const { cell } of villageCandidates) if (centers.every(center => distance(center.point, cell.point) > (settlement === 'village' ? 1400 : settlement === 'rural-town' ? 1000 : settlement === 'metropolis' ? 1100 : 800))) centers.push({ point: cell.point, kind: 'historic', weight: settlement === 'village' ? .12 : settlement === 'rural-town' ? .24 : settlement === 'metropolis' ? .72 : .32, activeYear: 1650, catchment: (settlement === 'metropolis' ? 430 : 260) * catchmentScale })
  let allocated = 0, budget = 0, capitalFund = 0, previousTarget = foundingHouseholds, lastProjectYear = 1650
  const completedTransport = new Set<string>(), transportCache = new Map<string, PlannedRoute | null>()
  const activatedStations = new Set<number>(), plannedDistricts: { center: Point; year: number; angle: number; completed: number }[] = []
  const completedProgrammes = new Set<'bypass' | 'expressway'>()
  let programmeSpent = 0
  const existing = (year: number) => {
    const active = centers.filter(center => center.activeYear <= year)
    const marketPrice = 1 + .75 * Math.log1p(Math.max(0, demandAt(year).households - foundingHouseholds) / 250)
    const functions = active.map(center => ({ center, time: graph.accessibilityFrom(center.point) }))
    for (const cell of cells) {
      const near = graph.nearest(cell.point, 160)
      cell.roadDistance = near?.distance ?? Infinity
      cell.servicedCapacity = frontageCapacity(cell, cell.roadDistance)
      let access = 0
      for (const item of functions) {
        const minutes = item.time(cell.point) * (year < 1900 ? 2.7 : year < 1950 ? 1.5 : 1) + developmentClimbMinutes(cell.point, item.center.point, input.terrainModel?.elevation, year)
        const local = distance(cell.point, item.center.point)
        // Network benefit must agree with local market reach; a highway does not urbanize every roadside.
        access += item.center.weight * Math.exp(-minutes / (item.center.kind === 'suburb' ? 5 : 7)) * Math.exp(-local / (item.center.catchment * (year < 1900 ? .95 : 1.25)))
      }
      if (year < 1900 && (input.type === 'post' || input.type === 'onsen')) access *= .35 + .65 * Math.exp(-(corridorDistances.get(cell.id) ?? 0) / (input.type === 'post' ? 95 : 130))
      cell.accessibility = access
      const retention = cell.ownerResistance * (year < 1950 ? .30 : .22)
      cell.landValue = access * cell.suitability * marketPrice - retention - cell.formationCostPerHousehold / (year < 1900 ? 28 : 36)
      if (cell.roadDistance < cell.frontageDepth && cell.servicedYear === undefined) cell.servicedYear = year
    }
  }
  const occupy = (target: number, year: number) => {
    const candidates = cells.filter(cell => cell.roadDistance < cell.frontageDepth + 1 && cell.households < (cell.servicedCapacity ?? 0) && cell.landValue > (year < 1900 ? .045 : .025)).sort((a, b) => b.landValue - a.landValue || a.id.localeCompare(b.id))
    for (const cell of candidates) {
      if (allocated >= target) break
      const n = Math.min((cell.servicedCapacity ?? 0) - cell.households, target - allocated)
      cell.households += n; allocated += n; if (n && cell.builtYear === undefined) cell.builtYear = year
    }
  }
  const yearPhase = (year: number) => year < 1900 ? 'oldtown' : year < 1955 ? 'railway' : 'suburban'
  type Candidate = { route: PlannedRoute; value: number; cost: number; role: RoadRole; width: number; reason: string; served: MarketCell[] }
  const rejectedProjects = new Set<PlannedRoute>()
  const cachedRoute = createRoadProjectCache(planner, () => budget)
  const neighborhoodRouteCache = new Map<string, PlannedRoute | null>()
  let railwayPlanned = false

  existing(1650); occupy(foundingHouseholds, 1650)
  demandSchedule.push({ year: 1650, ...demandAt(1650) })
  growthLog[0]!.unmetHouseholds = Math.max(0, foundingHouseholds - allocated)
  const years = simulationYears(endYear)
  for (const [step, year] of years.entries()) {
    if (!step) continue
    // The first regular levy remains the pre-existing five-year1700 round.
    // Between-round occupancy endpoints below do not spend project funds.
    const elapsed = year >= 1700 && years[step - 1]! < 1700 ? 5 : year - years[step - 1]!
    if (year % 25 === 0 || year === endYear) input.onProgress?.(year)
    const target = demandAt(year), phase = yearPhase(year)
    demandSchedule.push({ year, ...target })
    if (!isConstructionYear(year)) {
      existing(year)
      if (allocated > target.households) for (const cell of cells.filter(cell => cell.households > 0).sort((a, b) => a.landValue - b.landValue || a.id.localeCompare(b.id))) {
        const leaving = Math.min(cell.households, allocated - target.households)
        cell.households -= leaving; allocated -= leaving
        if (allocated <= target.households) break
      }
      occupy(target.households, year)
      growthLog.push({ phase, year, roadsAdded: 0, reason: '次の五年事業期まで既存道路・住宅供給の利用状況を更新', households: target.households, unmetHouseholds: Math.max(0, target.households - allocated), constructionCost: 0 })
      input.onPreview?.(graph.roads, year)
      continue
    }
    if (settlement === 'metropolis' && year === 1955) for (const cell of cells) cell.capacity = Math.max(cell.capacity, Math.round((cell.area ?? cell.capacity * 950) / 240))
    const before = graph.roads.length, random = randomFrom(`${input.seed}:projects:${year}`)
    let expenditure = 0
    if (year === 1955 && input.type === 'onsen' && input.arterial && regionalPlanner) {
      const channel = input.terrainModel?.channelAt?.(hub)
      const river = input.terrainModel?.rivers?.find(river => river.id === channel?.riverId) ?? input.terrainModel?.rivers?.find(river => river.id === 'river')
      const connectionPoints = graph.roads.filter(road => !road.controlledAccess && !road.bridge && road.role !== 'farm').flatMap(road => road.points).filter(point => distance(point, hub) <= 700)
      const project = river ? planValleyThroughRoad({ width: input.width, height: input.height, origin: hub, river: river.points, planner, regionalPlanner, connectionPoints }) : null
      if (project) {
        const reason = `近隣地域を結び既存市街の道路へ接続する国道${project.headwaterPass ? '・地形を測量した谷間や山麓の経路' : ''}（地方人口とは別の地域交通整備枠${Math.round(project.fundingLimit)}、投資${Math.round(project.route.cost)}）`
        // The first section starts outside the crop. Shared section endpoints
        // and an exact inherited street attachment connect the full programme.
        const committed = commitValleyThroughRoad(graph, project, { year, reason, nextId: () => nextId('regional-highway', year) })
        if (committed) expenditure += project.route.cost
      }
    }
    if (year >= 1900 && input.railway && !railwayPlanned) {
      const opening = input.onRailwayPlanning?.({ roads: graph.roads, centers })
      if (opening) Object.assign(input, opening)
      railwayPlanned = true
    }
    const activeRailways = year >= 1900 && input.railway ? (input.railwayCorridors ?? []).filter(corridor => (corridor.builtYear ?? 1900) <= year) : []
    const transportRevision = planner.transportRevision
    planner.setRailwayCorridors(activeRailways); regionalPlanner?.setRailwayCorridors(activeRailways)
    if (planner.transportRevision !== transportRevision) transportCache.clear()
    if (year >= 1900 && input.railway && density > 0) for (const [i, station] of input.stationPoints.entries()) {
      if (activatedStations.has(i)) continue
      const surveyed = input.stationAccessProjects?.find(project => distance(project.station, station) < 1e-7)
      if (surveyed && planner.validate(surveyed.route.points, 4, surveyed.route.bridgeLength > 0)) {
        addProject(surveyed.route, 'railway', year, 'access', '開業前に用地・既存街路接続を検査した駅前アクセス事業', 4, true, true)
        if (graph.ensureJunction(station)) {
          centers.push({ point: station, kind: 'station', weight: input.type === 'newtown' ? 1.5 : 1.04, activeYear: year, catchment: 470 * catchmentScale })
          activatedStations.add(i); expenditure += surveyed.route.cost; continue
        }
      }
      const near = graph.nearest(station, 1800)
      if (!near) continue
      const forecourt = near.distance <= 24, width = forecourt ? 3.5 : 10, role = forecourt ? 'access' : 'collector'
      const route = forecourt ? planner.validate([near.point, station], width) ? planner.cost([near.point, station], role) : null : planner.plan(near.point, station, { role, width, allowBridge: true, maxNodes: 9000 })
      if (route && !graph.ensureJunction(station)) addProject(route, 'railway', year, role, '鉄道開業に伴う駅前広場・街路への接続', width, true, true)
      if (graph.ensureJunction(station)) {
        centers.push({ point: station, kind: 'station', weight: input.type === 'newtown' ? 1.5 : 1.04, activeYear: year, catchment: 470 * catchmentScale })
        activatedStations.add(i); expenditure += route?.cost ?? 0
      } else {
        // A small hillside station need not have a 10m station avenue. Try a
        // real local access road from alternative existing streets; keep the
        // exact rail-side endpoint and all terrain/water constraints.
        for (const anchor of graph.projections(station, 900, 10)) {
          const access = planner.plan(anchor.point, station, { role: 'access', width: 4, allowBridge: true, maxNodes: 9000 })
          if (!access) continue
          addProject(access, 'railway', year, 'access', '広い駅前街路が通らない地形での生活道からの駅アクセス', 4, true, true)
          if (!graph.ensureJunction(station)) continue
          centers.push({ point: station, kind: 'station', weight: input.type === 'newtown' ? 1.5 : 1.04, activeYear: year, catchment: 470 * catchmentScale })
          activatedStations.add(i); expenditure += access.cost; break
        }
      }
    }
    if (input.type === 'port' && year === 1750 && density > 0) centers.push({ point: wharf ?? hub, kind: 'industrial', weight: .65, activeYear: year, catchment: 440 })
    existing(year)
    // Depopulation releases occupancy, never the inherited road or building
    // history. The physical stock can become vacant and later be reused.
    if (allocated > target.households) for (const cell of cells.filter(cell => cell.households > 0).sort((a, b) => a.landValue - b.landValue || a.id.localeCompare(b.id))) {
      const leaving = Math.min(cell.households, allocated - target.households)
      cell.households -= leaving; allocated -= leaving
      if (allocated <= target.households) break
    }
    occupy(target.households, year)
    const unmet = Math.max(0, target.households - allocated)
    const populationFalling = target.households < previousTarget
    const expansionAllowed = !populationFalling || allocated < target.households * .9
    // Taxes and development contributions fund projects; no demand means no scheduled expansion.
    // One-off development contribution:15 credits/new household, split between
    // local access(12) and public inter-market capital(3). Annual road levy is
    // .022 credit/occupied household/YEAR, so a five-year tick collects five years.
    const newDemand = Math.max(0, target.households - previousTarget)
    budget += density ? newDemand * 12 : 0
    capitalFund += density ? newDemand * 3 + allocated * .022 * elapsed : 0
    if (density > 0 && !populationFalling) {
      const renewal = renewExistingRoad({ graph, planner, cells, year, funds: capitalFund })
      if (renewal) { capitalFund -= renewal.cost; expenditure += renewal.cost; transportCache.clear(); neighborhoodRouteCache.clear() }
    }
    previousTarget = target.households
    // Optional regional programmes are surveyed in twenty-year transport-plan
    // rounds. Their public capital comes from the wider region:10 credits per
    // household and job in this scenario, not a second local development tax.
    // Each whole scheme still needs positive discounted time benefit and every
    // mandatory physical access; a checked option cannot override geography.
    if (regionalPlanner && !populationFalling && density > 0 && year >= 1965 && (year - 1965) % 20 === 0 && (input.expressway || input.bypass)) {
      const occupied = new Map<string, MarketCell[]>()
      for (const cell of cells.filter(cell => cell.households > 0)) { const key = `${Math.floor(cell.point.x / 150)}:${Math.floor(cell.point.y / 150)}`, bucket = occupied.get(key) ?? []; bucket.push(cell); occupied.set(key, bucket) }
      const landCost = (p: Point) => {
        let acquisition = 0
        const x = Math.floor(p.x / 150), y = Math.floor(p.y / 150)
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const cell of occupied.get(`${x + dx}:${y + dy}`) ?? []) acquisition += cell.households / cell.capacity * Math.exp(-((distance(p, cell.point) / 80) ** 2)) * 2.5
        return environment.landCost(p) + acquisition
      }
      const projectEnvironment = { ...environment, landCost }, modernPlanner = new RoadPlanner(projectEnvironment), widerPlanner = new RegionalRoadPlanner(projectEnvironment)
      for (const kind of ['bypass', 'expressway'] as const) {
        if (!input[kind] || completedProgrammes.has(kind)) continue
        const project = planModernTransport({ graph, planner: modernPlanner, regionalPlanner: widerPlanner, width: input.width, height: input.height, households: target.households, jobs: target.jobs, funds: Math.max(0, (target.households + target.jobs) * 10 - programmeSpent), kind, year })
        if (!project) continue
        const reason = kind === 'expressway' ? `地域間交通の高速道路と立体IC（${Math.round(project.trips)}移動/日、${project.minutesSaved.toFixed(1)}分短縮）` : `中心市街地を迂回する地域バイパス（${Math.round(project.trips)}移動/日、${project.minutesSaved.toFixed(1)}分短縮）`
        const additions = [{ points: project.mainline.points, metadata: { id: nextId('suburban', year), builtYear: year, phase: 'suburban', role: project.role, reason, width: project.width, kind: 'arterial' as const, constructionCost: project.mainline.cost, level: kind === 'expressway' ? 1 : 0, controlledAccess: kind === 'expressway', boundaryContinuation: true }, requireConnection: false }, ...project.accesses.map(access => ({ points: access.route.points, metadata: { id: nextId('suburban', year), builtYear: year, phase: 'suburban', role: access.role, reason: '高速道路ICと既存市街地の間を結ぶ接続道路・方向別ランプ', width: access.width, kind: 'local' as const, constructionCost: access.route.cost, level: access.level, controlledAccess: access.controlledAccess, preserveEndpoint: true }, requireConnection: true }))]
        if (!graph.addBatch(additions)) continue
        programmeSpent += project.cost; expenditure += project.cost; completedProgrammes.add(kind)
        existing(year); occupy(target.households, year)
      }
    }
    if (density > 0 && year >= 1750 && !populationFalling) {
      while (capitalFund > 100) {
        const project = transportProjects({ graph, planner, centers, cells, year, funds: capitalFund, arterial: input.arterial, completed: completedTransport, cache: transportCache })[0]
        if (!project) break
        completedTransport.add(project.pair)
        if (!addProject(project.route, phase, year, project.role, `市場・駅・集落間の交通を集める公共道路（${Math.round(project.trips)}移動/日、迂回${project.minutesSaved.toFixed(1)}分短縮）`, project.width, true, false)) continue
        capitalFund -= project.route.cost; expenditure += project.route.cost
        existing(year); occupy(target.households, year)
      }
    }
    if (year >= 1955 && unmet > 90 && !populationFalling && (settlement === 'regional-city' || settlement === 'metropolis' || (input.type === 'newtown' && target.households > 700)) && plannedDistricts.length < (input.type === 'newtown' ? 3 : 2) && year - lastProjectYear >= 10) {
      const stationCenters = centers.filter(c => c.kind === 'station')
      const occupiedCenter = (input.type === 'newtown' ? stationCenters[plannedDistricts.length % Math.max(1, stationCenters.length)] : null)?.point ?? centers.filter(c => c.kind === 'station' || c.kind === 'historic')[0]!.point
      const site = cells.filter(c => c.households === 0 && c.suitability > .76 && c.roadDistance > 60 && c.roadDistance < 350 && distance(c.point, occupiedCenter) > (input.type === 'newtown' ? 280 : 700) && distance(c.point, occupiedCenter) < (input.type === 'newtown' ? 1100 : 1600) && plannedDistricts.every(d => distance(d.center, c.point) > 700) && districtSupply(c.point) >= 90 && (input.type !== 'newtown' || [-1, 1].every(dx => [-1, 1].every(dy => { const corner = { x: c.point.x + dx * 330, y: c.point.y + dy * 330 }; return planner.suitable(corner, 12) && !input.areas.some(a => a.kind === 'forest' && inside(corner, a.polygon)) })))).sort((a, b) => (b.accessibility * .6 + b.suitability - b.ownerResistance) - (a.accessibility * .6 + a.suitability - a.ownerResistance))[0]
      if (site) {
        const near = graph.nearest(site.point, 500)!
        const route = planner.plan(near.point, site.point, { role: 'collector', width: 10, maxNodes: 5500 })
        if (route && route.cost < budget * .55 && addProject(route, 'suburban', year, 'collector', '人口増加に対応する住宅地開発の接続道路', 10)) {
          const stations = input.stationPoints, railAngle = stations.length > 1 ? Math.atan2(stations.at(-1)!.y - stations[0]!.y, stations.at(-1)!.x - stations[0]!.x) : Math.atan2(near.b.y - near.a.y, near.b.x - near.a.x)
          budget -= route.cost; expenditure += route.cost; centers.push({ point: site.point, kind: 'suburb', weight: input.type === 'newtown' ? 1.05 : .66, activeYear: year, catchment: 330 }); plannedDistricts.push({ center: site.point, year, angle: input.type === 'newtown' ? railAngle : Math.atan2(near.b.y - near.a.y, near.b.x - near.a.x), completed: 0 }); lastProjectYear = year
        }
      }
    }
    let estateChanged = false
    if (input.type === 'newtown' && year >= 1955 && target.households - allocated > 40) for (const district of plannedDistricts) {
      if (year <= district.year) continue
      const along = { x: Math.cos(district.angle), y: Math.sin(district.angle) }, across = { x: -along.y, y: along.x }
      const at = (u: number, v: number): Point => ({ x: district.center.x + along.x * u + across.x * v, y: district.center.y + along.y * u + across.y * v })
      const projects: [Point, Point][] = [[at(0, 0), at(330, 0)], [at(0, 0), at(-330, 0)], [at(0, 0), at(0, 330)], [at(0, 0), at(0, -330)]]
      for (const offset of [85, -85, 170, -170, 255, -255]) projects.push([at(0, offset), at(330, offset)], [at(0, offset), at(-330, offset)], [at(offset, 0), at(offset, 330)], [at(offset, 0), at(offset, -330)])
      for (let funded = 0; funded < 2 && district.completed < projects.length; funded++) {
      const [a, b] = projects[district.completed]!, near = graph.nearest(a, 3)
      if (!near || !planner.suitable(b, 6.5)) { district.completed++; continue }
      const route = cachedRoute(near.point, b, 'lane', 6.5, undefined, true)
      if (!route) { district.completed++; continue }
      const potential = cells.filter(c => !c.households && distance(c.point, district.center) < 470 && c.landValue > .025).reduce((sum, c) => sum + c.capacity, 0)
      // A land-readjustment district is a bounded commitment; empty demand does
      // not create a citywide grid, and only two scheduled streets are funded per tick.
      if (route.cost > budget || route.cost > potential * 30) continue
      if (addProject(route, 'suburban', year, 'lane', '鉄道を基準に測量した限定住区の段階的な区画道路', 6.5)) { budget -= route.cost; expenditure += route.cost; district.completed++; estateChanged = true }
      else district.completed++
      }
    }
    if (estateChanged) { existing(year); occupy(target.households, year) }
    if (unmet > 0 && density > 0 && expansionAllowed) {
      let projects = 0
      const remainingCells = cells.filter(c => c.households < c.capacity && c.roadDistance >= c.frontageDepth + 2).length
      // Each success services new land; each geometric failure is permanently
      // rejected. This finite safety bound is derived from remaining alternatives,
      // rather than imposing a fixed road construction quota on the economy.
      while (budget > 20 && allocated < target.households && projects < remainingCells * 3) {
        // Valuable, currently unserved land is considered; all other land remains farmland/open space.
        const rankedOpportunities = cells.filter(c => c.households < c.capacity && c.roadDistance >= c.frontageDepth + 2 && c.roadDistance < 380 && c.landValue > .025 && (input.type !== 'newtown' || year < 1955 || plannedDistricts.every(d => { const x = c.point.x - d.center.x, y = c.point.y - d.center.y, u = x * Math.cos(d.angle) + y * Math.sin(d.angle), v = -x * Math.sin(d.angle) + y * Math.cos(d.angle); return Math.abs(u) > 360 || Math.abs(v) > 360 })))
          .map(c => ({ cell: c, score: c.landValue * (c.capacity - c.households) / (35 + c.roadDistance) * (.9 + random() * .2) }))
          .sort((a, b) => b.score - a.score || a.cell.id.localeCompare(b.cell.id))
        const selection: { project: Candidate | null } = { project: null }
        // A scheduling window never rejects all lower-ranked land. An entirely
        // infeasible window yields to the next finite batch, evaluated lazily.
        for (const opportunities of diverseOpportunityBatches(rankedOpportunities)) {
        for (const opportunity of opportunities) {
          const cell = opportunity.cell, anchors = graph.projections(cell.point, 430, 12)
          if (!anchors.length) continue
          const first = anchors[0]!, ax = first.point.x - cell.point.x, ay = first.point.y - cell.point.y
          const opposite = anchors.filter(a => distance(a.point, first.point) > 90 && ((a.point.x - cell.point.x) * ax + (a.point.y - cell.point.y) * ay) / ((distance(a.point, cell.point) || 1) * (distance(first.point, cell.point) || 1)) < -.20)
            .sort((a, b) => distance(a.point, cell.point) - distance(b.point, cell.point))[0]
          const alternatives: { route: PlannedRoute | null; role: RoadRole; width: number; survey?: boolean }[] = []
          const quarter = quarterAt(cell.point)
          if (quarter) {
            const x = cell.point.x - quarter.origin.x, y = cell.point.y - quarter.origin.y
            const u = x * quarter.along.x + y * quarter.along.y, v = x * quarter.outward.x + y * quarter.outward.y
            const at = (a: number, b: number): Point => ({ x: quarter.origin.x + quarter.along.x * a + quarter.outward.x * b, y: quarter.origin.y + quarter.along.y * a + quarter.outward.y * b })
            const lines: [Point, Point][] = [[at(-quarter.extent, v), at(quarter.extent, v)], [at(u, 48), at(u, quarter.depth)]]
            for (const [a, b] of lines) {
              const length = distance(a, b), target = projectOnRoadSegment(cell.point, a, b).t
              const hits = graph.crossings(a, b), anchor = hits.slice().sort((p, q) => Math.abs(p.t - target) - Math.abs(q.t - target))[0]
              if (!anchor || Math.abs(anchor.t - target) * length > 320) continue
              const direction = Math.sign(target - anchor.t) || 1
              const beyond = hits.filter(hit => (hit.t - target) * direction > .03).sort((p, q) => Math.abs(p.t - target) - Math.abs(q.t - target))[0]
              const endpoint = beyond?.point ?? lerp(a, b, clamp(target + direction * Math.max(45, cell.frontageDepth * 2) / length, 0, 1))
              const width = year < 1900 ? 5.4 : 5.8
              if (planner.validate([anchor.point, endpoint], width)) alternatives.push({ route: cachedRoute(anchor.point, endpoint, 'lane', width, undefined, true), role: 'lane', width, survey: true })
            }
          }
          const hasRoute = () => alternatives.some(alternative => alternative.route && !rejectedProjects.has(alternative.route))
          if (!hasRoute() && opposite) { const role: RoadRole = 'lane', width = year < 1900 ? 5.7 : 6.3; alternatives.push({ route: cachedRoute(first.point, opposite.point, role, width, cell.point), role, width }) }
          const desiredLength = clamp(cell.frontageDepth * 3.3, 65, 150), accessWidth = cell.frontageDepth < 25 ? 3.3 : 4.6
          const extend = Math.min(80, Math.max(0, desiredLength - first.distance)), d = distance(first.point, cell.point)
          const beyond = { x: cell.point.x + (cell.point.x - first.point.x) / d * extend, y: cell.point.y + (cell.point.y - first.point.y) / d * extend }
          const endpoint = planner.suitable(beyond, accessWidth) ? beyond : cell.point
          if (!hasRoute() || !quarter) alternatives.push({ route: cachedRoute(first.point, endpoint, 'access', accessWidth), role: 'access', width: accessWidth })
          for (const { route, role, width, survey } of alternatives) {
          if (!route || rejectedProjects.has(route) || route.length > 720 || route.cost > budget || route.length < 35) continue
          const minX = Math.min(...route.points.map(p => p.x)) - 40, maxX = Math.max(...route.points.map(p => p.x)) + 40, minY = Math.min(...route.points.map(p => p.y)) - 40, maxY = Math.max(...route.points.map(p => p.y)) + 40
          const segments = route.points.slice(1).map((b, i) => ({ a: route.points[i]!, b }))
          const suppliedCapacity = new Map<MarketCell, number>()
          const served = cells.filter(c => {
            const p = c.point
            if (c.households >= c.capacity || c.landValue <= .025 || c.roadDistance <= c.frontageDepth || p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) return false
            let nearest = c.roadDistance
            for (const s of segments) if (p.x >= Math.min(s.a.x, s.b.x) - c.frontageDepth && p.x <= Math.max(s.a.x, s.b.x) + c.frontageDepth && p.y >= Math.min(s.a.y, s.b.y) - c.frontageDepth && p.y <= Math.max(s.a.y, s.b.y) + c.frontageDepth) nearest = Math.min(nearest, distance(projectOnRoadSegment(p, s.a, s.b).point, p))
            const additional = Math.max(0, frontageCapacity(c, nearest) - Math.max(c.households, c.servicedCapacity ?? 0))
            if (additional > 0) suppliedCapacity.set(c, additional)
            return additional > 0
          })
          const capacity = Math.min(target.households - allocated, served.reduce((sum, c) => sum + suppliedCapacity.get(c)!, 0))
          let travelBenefit = 0
          if (role !== 'access' && graph.nearest(route.points.at(-1)!, .2)) {
            const impedance = year < 1900 ? 2.7 : year < 1950 ? 1.5 : 1
            const oldTime = graph.travelTime(route.points[0]!, route.points.at(-1)!) * impedance, newTime = route.length / roadTravelSpeed({ role }) * impedance
            const catchmentHouseholds = cells.filter(c => c.households > 0 && distance(c.point, cell.point) < 220).reduce((sum, c) => sum + c.households, 0)
            // Trips made by existing residents also justify a link. Access-only
            // cul-de-sacs receive no artificial network benefit from a future loop.
            travelBenefit = Math.max(0, oldTime - newTime) * Math.min(160, catchmentHouseholds + allocated * .02) * 12
          }
          const remainingCapacity = served.reduce((sum, c) => sum + suppliedCapacity.get(c)!, 0)
          const formationCost = remainingCapacity ? capacity / remainingCapacity * served.reduce((sum, c) => sum + suppliedCapacity.get(c)! * c.formationCostPerHousehold, 0) : 0
          const benefit = capacity * (year < 1900 ? 28 : 36) - formationCost + travelBenefit
          const value = benefit - route.cost
          if (value <= 0 || capacity < 1) continue
          if (!selection.project || value / route.cost > selection.project.value / selection.project.cost) selection.project = { route, value, cost: route.cost, role, width, served, reason: survey ? `城郭の門・屋敷割に沿う街路の段階的な延長（追加供給${Math.round(capacity)}世帯相当）` : opposite && role !== 'access' ? `宅地需要への接道と既存道路間の迂回短縮（追加供給${Math.round(capacity)}世帯相当）` : `未充足住宅需要に対応する接道（追加供給${Math.round(capacity)}世帯相当）` }
          }
        }
        if (selection.project) break
        }
        const best = selection.project
        if (!best) break
        const added = addProject(best.route, phase, year, best.role, best.reason, best.width)
        if (!added) { rejectedProjects.add(best.route); projects++; continue }
        budget -= best.cost; expenditure += best.cost; projects++
        // Market can immediately occupy newly serviced land, without rebuilding older roads or houses.
        for (const cell of best.served) { cell.roadDistance = graph.nearest(cell.point, 100)?.distance ?? Infinity; cell.servicedCapacity = frontageCapacity(cell, cell.roadDistance); if (cell.roadDistance < cell.frontageDepth + 1 && cell.servicedYear === undefined) cell.servicedYear = year }
        occupy(target.households, year)
      }
    }
    // Existing residents can justify a missing neighbourhood link even after
    // every housing request has been served. Ten-year local transport rounds
    // use the existing resident road levy in the finite capital account, including
    // declining years. The same project is never charged to development fees.
    if (density > 0) {
      const investment = investInNeighborhood({ graph, planner, cells, year, funds: capitalFund, cache: neighborhoodRouteCache,
        commit: project => !!addProject(project.route, phase, year, 'lane', `近隣住区の既存住民による迂回を短縮する接続道路（${Math.round(project.trips)}移動/日、${project.minutesSaved.toFixed(1)}分短縮）`, project.width),
      })
      capitalFund -= investment.spent; expenditure += investment.spent
      if (investment.completed) { existing(year); occupy(target.households, year) }
    }
    growthLog.push({ phase, year, roadsAdded: graph.roads.length - before, reason: graph.roads.length > before ? '既存宅地の供給を利用した後、予算と開発便益を満たす交通事業を実施' : '既存供給で需要を充足、または新設事業が採算・地形条件を満たさない', households: target.households, unmetHouseholds: Math.max(0, target.households - allocated), constructionCost: expenditure })
    // Detached snapshot: civic programmes may inspect this round's occupied
    // catchments without modifying later simulation cells or retaining aliases.
    if (year >= 1955) input.onCivicPopulation?.(year, cells.filter(cell => cell.households > 0).map(cell => ({ point: { ...cell.point }, households: cell.households })))
    if (year % 25 === 0 || year === endYear) input.onPreview?.(graph.roads, year)
  }
  const finalTarget = demandSchedule.at(-1) ?? demandAt(1650)
  for (const cell of cells) cell.jobs = Math.round(cell.households * finalTarget.jobs / finalTarget.households)
  return { roads: graph.roads, roadHistory: graph.roadHistory, centers, growthLog, developmentCells: cells, demandSchedule, blocks: extractStreetBlocks(graph.roads) }
}

