import type { Area, CityType, Point } from './types'
import { PlanarRoadGraph, extractStreetBlocks, projectOnRoadSegment, roadTravelSpeed } from './road-graph'
import type { RoadRole, SimulatedRoad } from './road-graph'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute, PlanningTerrain } from './road-planner'

export interface UrbanGrowthInput {
  width: number; height: number; seed: string; type: CityType; center: Point; core: Point[] | null; areas: Area[]
  arterial: boolean; railway: boolean; stationPoints: Point[]; bridgeSites?: Point[]; density?: number
  era?: 'historic' | 'railway' | 'present'; terrainModel?: PlanningTerrain
  onProgress?: (year: number) => void
}
export interface GrowthCenter { point: Point; kind: 'historic' | 'station' | 'suburb' | 'industrial'; weight: number; activeYear: number; catchment: number }
export interface GrowthStage { phase: string; roadsAdded: number; year: number; reason: string; households: number; unmetHouseholds: number; constructionCost: number }
export interface DevelopmentCell { id: string; point: Point; households: number; jobs: number; capacity: number; servicedYear?: number; builtYear?: number; accessibility: number; landValue: number; ownerResistance: number }
export interface DemandTarget { households: number; jobs: number }
export interface UrbanGrowthResult { roads: SimulatedRoad[]; centers: GrowthCenter[]; growthLog: GrowthStage[]; developmentCells: DevelopmentCell[]; demandSchedule: ({ year: number } & DemandTarget)[]; blocks: Point[][] }
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
function randomFrom(seed: string) { let h = 2166136261; for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
function inside(p: Point, polygon: Point[]) { let hit = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i]!, b = polygon[j]!; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit } return hit }

/** Fictional scenario assumptions, in households/jobs. These are not empirical Japanese forecasts. */
export function scenarioDemandAtYear(input: { density?: number; type: CityType }, year: number): DemandTarget {
  const p = clamp(input.density ?? 65, 0, 100) / 100
  const old = 12 * clamp(year - 1700, 0, 150), industrial = 22 * clamp(year - 1850, 0, 100), modern = 95 * clamp(year - 1950, 0, 75)
  const oldScale = input.type === 'newtown' ? .14 : input.type === 'post' ? .66 : input.type === 'onsen' ? .52 : input.type === 'temple' ? .78 : input.type === 'port' ? 1.12 : 1
  const modernScale = input.type === 'newtown' ? 1.42 : input.type === 'post' ? .72 : input.type === 'onsen' ? .64 : input.type === 'temple' ? .86 : input.type === 'port' ? 1.08 : 1
  const households = Math.round(100 + p * ((old + industrial) * oldScale + modern * modernScale))
  return { households, jobs: Math.round(households * (input.type === 'port' ? .52 : input.type === 'onsen' ? .54 : input.type === 'newtown' ? .26 : .36)) }
}

/**
 * Five-year land/transport simulation. Projects purchase service capacity or reduce network
 * travel time; there is no road-count target and no pre-subdivision of unoccupied land.
 */
export function simulateUrbanGrowth(input: UrbanGrowthInput): UrbanGrowthResult {
  const graph = new PlanarRoadGraph(), centers: GrowthCenter[] = [{ point: input.center, kind: 'historic', weight: input.type === 'newtown' ? .32 : 1.15, activeYear: 1650, catchment: input.type === 'post' ? 780 : input.type === 'onsen' ? 510 : 640 }]
  const growthLog: GrowthStage[] = [], demandSchedule: ({ year: number } & DemandTarget)[] = []
  const density = clamp(input.density ?? 65, 0, 100), endYear = input.era === 'historic' ? 1800 : input.era === 'railway' ? 1930 : 2025
  const landRandom = randomFrom(`${input.seed}:land-ownership`), cells: (DevelopmentCell & { roadDistance: number; suitability: number })[] = []
  const cellSize = 78
  const planner = new RoadPlanner({ width: input.width, height: input.height, areas: input.areas, core: input.core, terrain: input.terrainModel, bridgeSites: input.bridgeSites })
  for (let row = 0; row < Math.floor(input.height / cellSize); row++) for (let col = 0; col < Math.floor(input.width / cellSize); col++) {
    const point = { x: (col + .5 + (landRandom() - .5) * .33) * cellSize, y: (row + .5 + (landRandom() - .5) * .33) * cellSize }
    const ownership = landRandom(), grade = input.terrainModel?.slope(point) ?? 0
    const forest = input.areas.some(a => a.kind === 'forest' && inside(point, a.polygon))
    if (!planner.suitable(point, 12) || forest || grade > .14) continue
    // Broad inherited farming/ownership districts resist conversion; this is not per-house density noise.
    const inheritedFarming = .5 + .25 * Math.sin(point.x / 330 + .7) + .25 * Math.cos(point.y / 460 - point.x / 700)
    cells.push({ id: `land-${row}-${col}`, point, households: 0, jobs: 0, capacity: Math.round(5 + landRandom() * 3), accessibility: 0, landValue: 0, ownerResistance: clamp(.12 + ownership * .28 + inheritedFarming * .35, .1, .85), roadDistance: Infinity, suitability: Math.max(.25, 1 - grade * 4 - (input.terrainModel?.wetness?.(point) ?? 0) * .2) })
  }
  const ids = new Map<string, number>()
  const nextId = (phase: string, year: number) => { const key = `${phase}-${year}`, n = ids.get(key) ?? 0; ids.set(key, n + 1); return `${key}-${n}` }
  const addProject = (route: PlannedRoute, phase: string, year: number, role: RoadRole, reason: string, width: number, requireConnection = true, preserveEndpoint = false) => {
    if (!planner.validate(route.points, width, route.bridgeLength > 0)) return 0
    // Bridge decks are explicit pieces, rather than labeling a complete cross-country route a bridge.
    const chunks: { path: Point[]; bridge: boolean }[] = []
    let run: Point[] = [route.points[0]!], mode = planner.waterAt(lerp(route.points[0]!, route.points[1]!, .5))
    for (let i = 1; i < route.points.length; i++) {
      const water = planner.waterAt(lerp(route.points[i - 1]!, route.points[i]!, .5))
      if (water !== mode && run.length > 1) { chunks.push({ path: run, bridge: mode }); run = [route.points[i - 1]!]; mode = water }
      run.push(route.points[i]!)
    }
    if (run.length > 1) chunks.push({ path: run, bridge: mode })
    let added = 0
    for (const chunk of chunks) {
      const road = graph.add(chunk.path, { id: nextId(phase, year), builtYear: year, phase, role: chunk.bridge ? 'bridge' : role, reason, width, kind: role === 'highway' && input.arterial ? 'arterial' : 'local', constructionCost: route.cost * (chunk.path.length / route.points.length), ...(chunk.bridge ? { bridge: true } : {}), preserveEndpoint: preserveEndpoint && chunk === chunks.at(-1) }, requireConnection)
      if (road) added++
      else if (requireConnection && !graph.nearest(chunk.path.at(-1)!, .2)) break
    }
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
    const shore = input.areas.find(area => area.id === 'sea') ?? input.areas.find(area => area.id === 'river')
    if (shore) {
      const nearest = shore.polygon.map((p, i) => projectOnRoadSegment(input.center, p, shore.polygon[(i + 1) % shore.polygon.length]!).point).sort((a, b) => distance(a, input.center) - distance(b, input.center))[0]!
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
    const river = input.terrainModel?.rivers?.find(river => river.id === 'river')
    let tangent = { x: .12, y: 1 }, best = Infinity
    if (river) for (let i = 1; i < river.points.length; i++) { const a = river.points[i - 1]!, b = river.points[i]!, d = distance(projectOnRoadSegment(hub, a, b).point, hub); if (d < best) { best = d; const n = distance(a, b) || 1; tangent = { x: (b.x - a.x) / n, y: (b.y - a.y) / n } } }
    terminals = [boundary(tangent), boundary({ x: -tangent.x, y: -tangent.y })].filter((p): p is Point => p !== null)
    foundingReason = '湯場と谷の上流・下流集落を結ぶ谷沿いの往来'
  } else if (input.type === 'port') {
    terminals = [terminals[0]!, terminals[1]!]
    foundingReason = '船着場の荷揚げ場と内陸市場・生産地を結ぶ輸送路'
  } else if (input.type === 'newtown') {
    terminals = [boundary({ x: .12, y: -1 }), boundary({ x: -.12, y: 1 })].filter((p): p is Point => p !== null)
    foundingReason = '鉄道開業前の農村を通る旧道と耕作地への往来'
  }
  terminals = terminals.filter(Boolean)
  const foundingWidth = input.type === 'onsen' ? 7 : input.type === 'post' ? 9 : input.type === 'temple' ? 10 : input.type === 'newtown' ? 7.5 : input.arterial ? 13 : 9
  let foundingCost = 0
  for (const [i, terminal] of terminals.entries()) {
    const attachment = graph.nearest(terminal, Infinity)
    const start = i === 0 ? hub : attachment?.point ?? hub
    const route = planner.plan(start, terminal, { role: input.arterial ? 'highway' : 'collector', width: foundingWidth, allowBridge: true, maxNodes: 20000 })
    if (route) { foundingCost += route.cost; addProject(route, 'regional', 1650, input.arterial ? 'highway' : 'collector', foundingReason, foundingWidth, i !== 0) }
  }
  // Field routes have a purpose: reach cultivable lowland and reconnect to a second older route when economical.
  for (const angle of [2.35, -.6, 1.12]) {
    const target = dryPoint({ x: hub.x + Math.cos(angle) * 850, y: hub.y + Math.sin(angle) * 850 }, 160)
    if (!target) continue
    const near = graph.nearest(target, 800)
    if (!near || near.distance < 95) continue
    const route = planner.plan(near.point, target, { role: 'farm', width: 4, maxNodes: 3500 })
    if (route) addProject(route, 'regional', 1650, 'farm', '既存集落から耕作地へ通う農道', 4)
  }
  growthLog.push({ phase: 'regional', year: 1650, roadsAdded: graph.roads.length, reason: '成立以前の街道・渡河・耕作地へのアクセス', households: 100, unmetHouseholds: 0, constructionCost: foundingCost })
  if (!graph.roads.length) return { roads: [], centers, growthLog, developmentCells: cells, demandSchedule, blocks: [] }
  const inheritedCorridor = graph.roads.filter(road => road.role !== 'farm')
  const corridorDistances = new Map<string, number>()
  if (input.type === 'post' || input.type === 'onsen') for (const cell of cells) {
    let d = Infinity
    for (const road of inheritedCorridor) for (let i = 1; i < road.points.length; i++) d = Math.min(d, distance(projectOnRoadSegment(cell.point, road.points[i - 1]!, road.points[i]!).point, cell.point))
    corridorDistances.set(cell.id, d)
  }

  let allocated = 0, budget = 0, previousTarget = 100, lastProjectYear = 1650
  const activatedStations = new Set<number>(), plannedDistricts: { center: Point; year: number; angle: number; completed: number }[] = []
  const existing = (year: number) => {
    const active = centers.filter(center => center.activeYear <= year)
    const marketPrice = 1 + .75 * Math.log1p(Math.max(0, scenarioDemandAtYear({ density, type: input.type }, year).households - 100) / 250)
    const functions = active.map(center => ({ center, time: graph.accessibilityFrom(center.point) }))
    for (const cell of cells) {
      const near = graph.nearest(cell.point, 160)
      cell.roadDistance = near?.distance ?? Infinity
      let access = 0
      for (const item of functions) {
        const minutes = item.time(cell.point) * (year < 1900 ? 2.7 : year < 1950 ? 1.5 : 1)
        const local = distance(cell.point, item.center.point)
        // Network benefit must agree with local market reach; a highway does not urbanize every roadside.
        access += item.center.weight * Math.exp(-minutes / (item.center.kind === 'suburb' ? 5 : 7)) * Math.exp(-local / (item.center.catchment * (year < 1900 ? .95 : 1.25)))
      }
      if (year < 1900 && (input.type === 'post' || input.type === 'onsen')) access *= .35 + .65 * Math.exp(-(corridorDistances.get(cell.id) ?? 0) / (input.type === 'post' ? 95 : 130))
      cell.accessibility = access
      const retention = cell.ownerResistance * (year < 1950 ? .30 : .22)
      cell.landValue = access * cell.suitability * marketPrice - retention
      if (cell.roadDistance < 41 && cell.servicedYear === undefined) cell.servicedYear = year
    }
  }
  const occupy = (target: number, year: number) => {
    const candidates = cells.filter(cell => cell.roadDistance < 42 && cell.households < cell.capacity && cell.landValue > (year < 1900 ? .045 : .025)).sort((a, b) => b.landValue - a.landValue || a.id.localeCompare(b.id))
    for (const cell of candidates) {
      if (allocated >= target) break
      const n = Math.min(cell.capacity - cell.households, target - allocated)
      cell.households += n; allocated += n; if (n && cell.builtYear === undefined) cell.builtYear = year
    }
  }
  const yearPhase = (year: number) => year < 1900 ? 'oldtown' : year < 1955 ? 'railway' : 'suburban'
  type Candidate = { route: PlannedRoute; value: number; cost: number; role: RoadRole; width: number; reason: string; served: (DevelopmentCell & { roadDistance: number; suitability: number })[] }
  const routeCache = new Map<string, PlannedRoute | null>()
  const rejectedProjects = new Set<PlannedRoute>()
  const cachedRoute = (a: Point, b: Point, role: RoadRole, width: number, through?: Point) => {
    const k = [a.x.toFixed(1), a.y.toFixed(1), b.x.toFixed(1), b.y.toFixed(1), role, through?.x.toFixed(1), through?.y.toFixed(1)].join(':')
    if (routeCache.has(k)) return routeCache.get(k)!
    const route = planner.plan(a, b, { role, width, ...(through ? { through } : {}), maxNodes: 2400 })
    routeCache.set(k, route); return route
  }

  for (let year = 1700; year <= endYear; year += 5) {
    if (year % 25 === 0 || year === endYear) input.onProgress?.(year)
    const target = scenarioDemandAtYear({ density, type: input.type }, year), phase = yearPhase(year)
    demandSchedule.push({ year, ...target })
    const before = graph.roads.length, random = randomFrom(`${input.seed}:projects:${year}`)
    let expenditure = 0
    if (year >= 1900 && input.railway && density > 0) for (const [i, station] of input.stationPoints.entries()) {
      if (activatedStations.has(i)) continue
      const near = graph.nearest(station, 1800)
      if (!near) continue
      const forecourt = near.distance <= 24, width = forecourt ? 3.5 : 10, role = forecourt ? 'access' : 'collector'
      const route = forecourt ? planner.validate([near.point, station], width) ? planner.cost([near.point, station], role) : null : planner.plan(near.point, station, { role, width, allowBridge: true, maxNodes: 9000 })
      if (graph.ensureJunction(station) || (route && addProject(route, 'railway', year, role, '鉄道開業に伴う駅前広場・街路への接続', width, true, true))) {
        centers.push({ point: station, kind: 'station', weight: input.type === 'newtown' ? 1.5 : 1.04, activeYear: year, catchment: 470 })
        activatedStations.add(i); expenditure += route?.cost ?? 0
      }
    }
    if (input.type === 'port' && year === 1750 && density > 0) centers.push({ point: wharf ?? hub, kind: 'industrial', weight: .65, activeYear: year, catchment: 440 })
    existing(year); occupy(target.households, year)
    const unmet = Math.max(0, target.households - allocated)
    // Taxes and development contributions fund projects; no demand means no scheduled expansion.
    budget += density ? Math.max(0, target.households - previousTarget) * 15 + allocated * .022 : 0
    previousTarget = target.households
    if (year >= 1955 && unmet > 90 && plannedDistricts.length < (input.type === 'newtown' ? 3 : 2) && year - lastProjectYear >= 10) {
      const stationCenters = centers.filter(c => c.kind === 'station')
      const occupiedCenter = (input.type === 'newtown' ? stationCenters[plannedDistricts.length % Math.max(1, stationCenters.length)] : null)?.point ?? centers.filter(c => c.kind === 'station' || c.kind === 'historic')[0]!.point
      const site = cells.filter(c => c.households === 0 && c.suitability > .76 && c.roadDistance > 60 && c.roadDistance < 350 && distance(c.point, occupiedCenter) > (input.type === 'newtown' ? 280 : 700) && distance(c.point, occupiedCenter) < (input.type === 'newtown' ? 1100 : 1600) && plannedDistricts.every(d => distance(d.center, c.point) > 700) && (input.type !== 'newtown' || [-1, 1].every(dx => [-1, 1].every(dy => { const corner = { x: c.point.x + dx * 330, y: c.point.y + dy * 330 }; return planner.suitable(corner, 12) && !input.areas.some(a => a.kind === 'forest' && inside(corner, a.polygon)) })))).sort((a, b) => (b.accessibility * .6 + b.suitability - b.ownerResistance) - (a.accessibility * .6 + a.suitability - a.ownerResistance))[0]
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
      const route = cachedRoute(near.point, b, 'lane', 6.5)
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
    if (unmet > 0 && density > 0) {
      let projects = 0
      const remainingCells = cells.filter(c => c.households < c.capacity && c.roadDistance >= 43).length
      // Each success services new land; each geometric failure is permanently
      // rejected. This finite safety bound is derived from remaining alternatives,
      // rather than imposing a fixed road construction quota on the economy.
      while (budget > 95 && allocated < target.households && projects < remainingCells * 3) {
        // Valuable, currently unserved land is considered; all other land remains farmland/open space.
        const rankedOpportunities = cells.filter(c => c.households < c.capacity && c.roadDistance >= 43 && c.roadDistance < 380 && c.landValue > .025 && (input.type !== 'newtown' || year < 1955 || plannedDistricts.every(d => { const x = c.point.x - d.center.x, y = c.point.y - d.center.y, u = x * Math.cos(d.angle) + y * Math.sin(d.angle), v = -x * Math.sin(d.angle) + y * Math.cos(d.angle); return Math.abs(u) > 360 || Math.abs(v) > 360 })))
          .map(c => ({ cell: c, score: c.landValue * (c.capacity - c.households) / (35 + c.roadDistance) * (.9 + random() * .2) }))
          .sort((a, b) => b.score - a.score || a.cell.id.localeCompare(b.cell.id))
        const opportunities: typeof rankedOpportunities = []
        for (const candidate of rankedOpportunities) { if (opportunities.every(other => distance(candidate.cell.point, other.cell.point) > 100)) opportunities.push(candidate); if (opportunities.length === 8) break }
        let best: Candidate | null = null
        for (const opportunity of opportunities) {
          const cell = opportunity.cell, anchors = graph.projections(cell.point, 430, 12)
          if (!anchors.length) continue
          const first = anchors[0]!, ax = first.point.x - cell.point.x, ay = first.point.y - cell.point.y
          const opposite = anchors.filter(a => distance(a.point, first.point) > 90 && ((a.point.x - cell.point.x) * ax + (a.point.y - cell.point.y) * ay) / ((distance(a.point, cell.point) || 1) * (distance(first.point, cell.point) || 1)) < -.20)
            .sort((a, b) => distance(a.point, cell.point) - distance(b.point, cell.point))[0]
          const alternatives: { route: PlannedRoute | null; role: RoadRole; width: number }[] = []
          if (opposite) { const role: RoadRole = 'lane', width = year < 1900 ? 5.7 : 6.3; alternatives.push({ route: cachedRoute(first.point, opposite.point, role, width, cell.point), role, width }) }
          const extend = Math.min(80, Math.max(0, 150 - first.distance)), d = distance(first.point, cell.point)
          const beyond = { x: cell.point.x + (cell.point.x - first.point.x) / d * extend, y: cell.point.y + (cell.point.y - first.point.y) / d * extend }
          const endpoint = planner.suitable(beyond, 4.6) ? beyond : cell.point
          alternatives.push({ route: cachedRoute(first.point, endpoint, 'access', 4.6), role: 'access', width: 4.6 })
          for (const { route, role, width } of alternatives) {
          if (!route || rejectedProjects.has(route) || route.length > 720 || route.cost > budget || route.length < 35) continue
          const minX = Math.min(...route.points.map(p => p.x)) - 40, maxX = Math.max(...route.points.map(p => p.x)) + 40, minY = Math.min(...route.points.map(p => p.y)) - 40, maxY = Math.max(...route.points.map(p => p.y)) + 40
          const segments = route.points.slice(1).map((b, i) => ({ a: route.points[i]!, b }))
          const served = cells.filter(c => {
            const p = c.point
            if (c.households >= c.capacity || c.landValue <= .025 || c.roadDistance <= 41 || p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) return false
            return segments.some(s => p.x >= Math.min(s.a.x, s.b.x) - 40 && p.x <= Math.max(s.a.x, s.b.x) + 40 && p.y >= Math.min(s.a.y, s.b.y) - 40 && p.y <= Math.max(s.a.y, s.b.y) + 40 && distance(projectOnRoadSegment(p, s.a, s.b).point, p) < 40)
          })
          const capacity = Math.min(target.households - allocated, served.reduce((sum, c) => sum + c.capacity - c.households, 0))
          let travelBenefit = 0
          if (opposite && role !== 'access') {
            const impedance = year < 1900 ? 2.7 : year < 1950 ? 1.5 : 1
            const oldTime = graph.travelTime(first.point, opposite.point) * impedance, newTime = route.length / roadTravelSpeed({ role }) * impedance
            const catchmentHouseholds = cells.filter(c => c.households > 0 && distance(c.point, cell.point) < 220).reduce((sum, c) => sum + c.households, 0)
            // Trips made by existing residents also justify a link. Access-only
            // cul-de-sacs receive no artificial network benefit from a future loop.
            travelBenefit = Math.max(0, oldTime - newTime) * Math.min(160, catchmentHouseholds + allocated * .02) * 12
          }
          const benefit = capacity * (year < 1900 ? 28 : 36) + travelBenefit
          const value = benefit - route.cost
          if (value <= 0 || capacity < 3) continue
          if (!best || value / route.cost > best.value / best.cost) best = { route, value, cost: route.cost, role, width, served, reason: opposite && role !== 'access' ? `宅地需要への接道と既存道路間の迂回短縮（追加供給${Math.round(capacity)}世帯相当）` : `未充足住宅需要に対応する接道（追加供給${Math.round(capacity)}世帯相当）` }
          }
        }
        if (!best) break
        const added = addProject(best.route, phase, year, best.role, best.reason, best.width)
        if (!added) { rejectedProjects.add(best.route); projects++; continue }
        budget -= best.cost; expenditure += best.cost; projects++
        // Market can immediately occupy newly serviced land, without rebuilding older roads or houses.
        for (const cell of best.served) { cell.roadDistance = graph.nearest(cell.point, 100)?.distance ?? Infinity; if (cell.roadDistance < 42 && cell.servicedYear === undefined) cell.servicedYear = year }
        occupy(target.households, year)
      }
    }
    growthLog.push({ phase, year, roadsAdded: graph.roads.length - before, reason: graph.roads.length > before ? '既存宅地の供給を利用した後、予算と開発便益を満たす交通事業を実施' : '既存供給で需要を充足、または新設事業が採算・地形条件を満たさない', households: target.households, unmetHouseholds: Math.max(0, target.households - allocated), constructionCost: expenditure })
  }
  const finalTarget = demandSchedule.at(-1) ?? { households: 100, jobs: 36 }
  for (const cell of cells) cell.jobs = Math.round(cell.households * finalTarget.jobs / finalTarget.households)
  return { roads: graph.roads, centers, growthLog, developmentCells: cells, demandSchedule, blocks: extractStreetBlocks(graph.roads) }
}

