import type { CityConfig, Point, Railway, Road } from './types'
import type { PolygonRegion } from './geometry'
import type { TerrainModel } from './terrain'
import type { ContinuousCityDemand } from './continuous-city-types'
import { boundsOf, corridorPolygon, distance, overlaps, pathPointAt, polygonOverlapsRegion, seededRandom } from './geometry'
import { PlanarRoadGraph, roadLength } from './road-graph'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute } from './road-planner'
import { alignmentDiagnostics, resampleAlignment } from './road-alignment'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'
import { regionQuery } from './region-query'

export interface ContinuousCityRuralInput {
  config: CityConfig
  width: number
  height: number
  terrain: Pick<TerrainModel, 'areas' | 'elevation' | 'slope' | 'waterAt'> & Partial<Pick<TerrainModel, 'wetness' | 'cultivable'>>
  demand: ContinuousCityDemand
  roads: readonly Road[]
  railways: readonly Railway[]
  reserves: readonly PolygonRegion[]
}
export interface ContinuousRuralDiagnostics {
  seeds: number; attempts: number; accepted: number; length: number; maximumNetworkDistance: number
  unavailable?: string
  projects: { id: string; parentRoadId: string; root: Point; from: Point; to: Point; builtYear: number; length: number; networkDistance: number }[]
}
interface Frontier { point: Point; root: Point; parentRoadId: string; year: number; travelled: number; heading: number; generation: number }
const turn = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x)
const width = 4, maximumReach = 1200, maximumGrade = .10

/** Real agricultural access, independent of urban street subdivision. Sparse
 * branches grow from existing rural public frontage; a field-demand grid is
 * never drawn as roads and urban missing supply cannot become a farm fallback. */
export function planContinuousCityRuralAccess(input: ContinuousCityRuralInput): { roads: Road[]; diagnostics: ContinuousRuralDiagnostics } {
  const diagnostics: ContinuousRuralDiagnostics = { seeds: 0, attempts: 0, accepted: 0, length: 0, maximumNetworkDistance: 0, projects: [] }
  const publicRoads = input.roads.filter(r => !r.controlledAccess && r.role !== 'expressway' && r.role !== 'ramp' && (r.level ?? 0) === 0 && r.width >= 4 && r.points.length >= 2)
  if (!publicRoads.length) return { roads: [], diagnostics: { ...diagnostics, unavailable: '接続元の公道がありません。' } }
  const railwayMasks = input.railways.filter(r => r.mode !== 'subway').flatMap(r => r.points.slice(1).flatMap((b, i) => distance(r.points[i]!, b) > .01 ? [{ polygon: corridorPolygon(r.points[i]!, b, 7) }] : []))
  const obstacles = [...input.reserves, ...railwayMasks].map(region => ({ region, bounds: boundsOf(region.polygon) })), reserved = regionQuery(obstacles.map(o => o.region))
  const rural = (p: Point) => p.x >= width && p.y >= width && p.x <= input.width - width && p.y <= input.height - width && input.demand.at(p) <= 0
  const cultivable = (p: Point) => rural(p) && !reserved(p) && !input.terrain.waterAt(p) && input.terrain.slope(p) <= .08 && (input.terrain.cultivable?.(p) ?? true)
  const planner = new RoadPlanner({ width: input.width, height: input.height, core: null, areas: input.terrain.areas, terrain: { ...input.terrain, bridgeSites: [] }, exactLandCost: true, landCost: p => rural(p) && !reserved(p) ? 0 : Infinity })
  planner.setRailwayCorridors([...input.railways])
  let graph = new PlanarRoadGraph()
  for (const road of publicRoads) graph.add(road.points, { ...road, builtYear: road.builtYear ?? 1650, role: road.role ?? 'lane', phase: 'continuous-rural-existing', reason: road.reason ?? '接続元の公道', constructionCost: 0 }, false)
  planner.setRailwayRoadNetwork(graph.roads)
  const physical = (route: PlannedRoute) => {
    if (!Number.isFinite(route.cost) || route.bridgeLength > 0 || route.surveyedBridgeSpans?.length || alignmentDiagnostics(route.points).minimumRadius < 15 - 1e-6 || !planner.validate(route.points, width, false) || !planner.railwayWidthAllows(route.points, .01, width, 'farm')) return false
    const points = resampleAlignment(route.points, 4)
    if (!surveyedRoadGradeAllowed({ points }, maximumGrade, input.terrain.elevation)) return false
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1]!, b = route.points[i]!, strip = corridorPolygon(a, b, width / 2 + .4), bounds = boundsOf(strip)
      if (obstacles.some(o => overlaps(bounds, o.bounds) && polygonOverlapsRegion(strip, o.region))) return false
      const heading = turn(a, b), count = Math.max(1, Math.ceil(distance(a, b) / 4))
      for (let n = 0; n <= count; n++) for (const side of [-1, 0, 1]) {
        const p = { x: a.x + (b.x - a.x) * n / count - Math.sin(heading) * width / 2 * side, y: a.y + (b.y - a.y) * n / count + Math.cos(heading) * width / 2 * side }
        if (!rural(p) || input.terrain.waterAt(p) || input.terrain.slope(p) > .13) return false
      }
    }
    return true
  }
  const random = seededRandom(`${input.config.seed}:rural-access`), maxRoads = Math.min(64, Math.max(4, Math.ceil(input.width * input.height / 1800000))), maxAttempts = maxRoads * 8
  const frontier: Frontier[] = [], anchors: Point[] = []
  const ordered = [...graph.roads].sort((a, b) => Number(b.role === 'farm') - Number(a.role === 'farm') || b.width - a.width || a.id.localeCompare(b.id))
  for (const road of ordered) {
    const length = roadLength(road.points), count = Math.max(1, Math.ceil(length / (450 + random() * 160)))
    for (let i = 0; i < count; i++) {
      const t = (i + .5) / count, point = pathPointAt(road.points, t)
      if (!cultivable(point) || anchors.some(p => distance(p, point) < 400)) continue
      const a = pathPointAt(road.points, Math.max(0, t - 50 / Math.max(1, length))), b = pathPointAt(road.points, Math.min(1, t + 50 / Math.max(1, length))), bearing = turn(a, b)
      anchors.push(point)
      for (const side of [-1, 1]) frontier.push({ point, root: point, parentRoadId: road.id, year: road.builtYear, travelled: 0, heading: bearing + side * Math.PI / 2, generation: 0 })
      if (anchors.length >= maxRoads * 2) break
    }
    if (anchors.length >= maxRoads * 2) break
  }
  diagnostics.seeds = anchors.length
  const acquired = new Set<string>(), occupiedIds = new Set(input.roads.map(r => r.id))
  let serial = 0
  for (let cursor = 0; cursor < frontier.length && acquired.size < maxRoads && diagnostics.attempts < maxAttempts; cursor++) {
    const node = frontier[cursor]!, remaining = maximumReach - node.travelled
    if (remaining < 300) continue
    const reach = Math.min(remaining, 400 + random() * 250)
    const candidates = [0, -.35, .35, -.65, .65].map(offset => {
      const heading = node.heading + offset, point = { x: node.point.x + Math.cos(heading) * reach, y: node.point.y + Math.sin(heading) * reach }
      const score = [0, -.6, .6].reduce((n, side) => n + Number(cultivable({ x: point.x - Math.sin(heading) * side * 180, y: point.y + Math.cos(heading) * side * 180 })), 0)
      return { point, heading, score }
    }).filter(c => c.score >= 2 && cultivable(c.point) && !graph.nearest(c.point, 230)).sort((a, b) => b.score - a.score || Math.abs(a.heading - node.heading) - Math.abs(b.heading - node.heading))
    for (const candidate of candidates) {
      if (++diagnostics.attempts > maxAttempts) break
      const route = planner.plan(node.point, candidate.point, { role: 'farm', width, allowBridge: false, maximumGrade, maxNodes: 650 })
      if (!route || route.length > remaining + 1e-7 || route.length > distance(node.point, candidate.point) * 1.55 || !physical(route) || graph.hasAcuteMajorCrossing(route.points)) continue
      let id: string
      do { id = `continuous-farm-${++serial}` } while (occupiedIds.has(id))
      const metadata = { id, width, kind: 'local' as const, role: 'farm' as const, builtYear: node.year, phase: 'continuous-rural-access', reason: '実公道から乾燥農地区へ続く農業用接道', constructionCost: route.cost }
      const staged = graph.fork(), road = staged.add(route.points, metadata, true)
      if (!road || !physical({ ...route, points: road.points }) || !graph.nearest(road.points[0]!, 1e-7)) continue
      const length = roadLength(road.points), travelled = node.travelled + length
      if (travelled > maximumReach + 1e-7) continue
      graph = staged; acquired.add(id); occupiedIds.add(id); planner.setRailwayRoadNetwork(graph.roads)
      diagnostics.accepted++; diagnostics.length += length; diagnostics.maximumNetworkDistance = Math.max(diagnostics.maximumNetworkDistance, travelled)
      const end = road.points.at(-1)!
      diagnostics.projects.push({ id, parentRoadId: node.parentRoadId, root: node.root, from: road.points[0]!, to: end, builtYear: road.builtYear, length, networkDistance: travelled })
      if (node.generation < 2) {
        const successors: Frontier[] = []
        const nextHeading = turn(pathPointAt(road.points, .8), end)
        successors.push({ point: end, root: node.root, parentRoadId: id, year: road.builtYear, travelled, heading: nextHeading + (random() - .5) * .22, generation: node.generation + 1 })
        if (remaining - length * .55 > 350) successors.push({ point: pathPointAt(road.points, .55), root: node.root, parentRoadId: id, year: road.builtYear, travelled: node.travelled + length * .55, heading: nextHeading + (random() < .5 ? -1 : 1) * Math.PI / 2, generation: node.generation + 1 })
        frontier.splice(cursor + 1, 0, ...successors)
      }
      break
    }
  }
  return { roads: graph.roads.filter(r => acquired.has(r.id)).map(r => ({ ...r, points: r.points.map(p => ({ ...p })) })), diagnostics }
}
