import type { CityConfig, Point, Railway, Road } from './types'
import type { PolygonRegion } from './geometry'
import type { TerrainModel } from './terrain'
import type { ContinuousCityDemand } from './continuous-city-types'
import { boundsOf, corridorPolygon, distance, overlaps, pathPointAt, polygonOverlapsRegion, seededRandom } from './geometry'
import { MinHeap, PlanarRoadGraph, roadLength } from './road-graph'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute } from './road-planner'
import { alignmentDiagnostics, resampleAlignment } from './road-alignment'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'
import { regionQuery } from './region-query'
import { certifyLayoutAccess } from './layout-first-access'

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
  projects: { id: string; parentRoadId: string; root: Point; from: Point; to: Point; builtYear: number; length: number; networkDistance: number; workingField: PolygonRegion }[]
}
interface Frontier { point: Point; root: Point; parentRoadId: string; year: number; travelled: number; heading: number; generation: number }
const turn = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x)
const width = 4, maximumReach = 1200, maximumGrade = .10

/** A short acquired fringe approach is not an urban supply street. Measure
 * the final full-width route from its original public root, never resetting
 * the24m prefix on a bend or a descendant agricultural branch. */
export function continuousRuralFringeAllowed(input: { points: Point[]; root: Point; travelled: number; intensity(point: Point): number; oldPavement(point: Point): boolean; bounded(point: Point): boolean }) {
  const length = roadLength(input.points)
  if (!(length > 0)) return false
  let chainage = input.travelled, urbanLength = 0
  for (let i = 1; i < input.points.length; i++) {
    const a = input.points[i - 1]!, b = input.points[i]!, span = distance(a, b), heading = turn(a, b), count = Math.max(1, Math.ceil(span))
    for (let n = 0; n < count; n++) {
      let urban = false
      for (const sample of [n, n + .5, n + 1]) for (const side of [-1, 0, 1]) {
        const t = sample / count, point = { x: a.x + (b.x - a.x) * t - Math.sin(heading) * width / 2 * side, y: a.y + (b.y - a.y) * t + Math.cos(heading) * width / 2 * side }
        if (!input.bounded(point)) return false
        const intensity = input.intensity(point)
        if (intensity <= 0 || input.oldPavement(point)) continue
        if (!(intensity <= .25) || chainage + span * t > 24 + 1e-7 || distance(input.root, point) > 24 + 1e-7) return false
        urban = true
      }
      if (urban) urbanLength += span / count
    }
    chainage += span
  }
  return urbanLength <= length * .20 + 1e-7
}

/** Real agricultural access, independent of urban street subdivision. Sparse
 * branches grow from existing rural public frontage; a field-demand grid is
 * never drawn as roads and urban missing supply cannot become a farm fallback. */
export function planContinuousCityRuralAccess(input: ContinuousCityRuralInput): { roads: Road[]; diagnostics: ContinuousRuralDiagnostics } {
  const diagnostics: ContinuousRuralDiagnostics = { seeds: 0, attempts: 0, accepted: 0, length: 0, maximumNetworkDistance: 0, projects: [] }
  const publicRoads = input.roads.filter(r => !r.controlledAccess && r.role !== 'expressway' && r.role !== 'ramp' && (r.level ?? 0) === 0 && r.width >= 4 && r.points.length >= 2)
  if (!publicRoads.length) return { roads: [], diagnostics: { ...diagnostics, unavailable: '接続元の公道がありません。' } }
  const publicGrounds = publicRoads.flatMap(road => road.points.slice(1).flatMap((b, i) => distance(road.points[i]!, b) > .01 ? [{ polygon: corridorPolygon(road.points[i]!, b, road.width / 2 + .01) }] : []))
  const railwayMasks = input.railways.filter(r => r.mode !== 'subway').flatMap(r => r.points.slice(1).flatMap((b, i) => distance(r.points[i]!, b) > .01 ? [{ polygon: corridorPolygon(r.points[i]!, b, 7) }] : []))
  const obstacles = [...input.reserves, ...railwayMasks].map(region => ({ region, bounds: boundsOf(region.polygon) })), reserved = regionQuery(obstacles.map(o => o.region))
  const fieldObstacles = [...obstacles, ...[...publicGrounds, ...input.terrain.areas.filter(area => area.kind === 'water')].map(region => ({ region, bounds: boundsOf(region.polygon) }))]
  const bounded = (p: Point) => p.x >= width && p.y >= width && p.x <= input.width - width && p.y <= input.height - width
  const rural = (p: Point) => bounded(p) && input.demand.at(p) <= 0
  // A rural connection can begin on the actual pavement of an urban-edge
  // street. This exception acquires no additional urban land and cannot be
  // used to turn an unserved urban district into agricultural access.
  const publicPavement = regionQuery(publicGrounds)
  const permitted = (p: Point) => bounded(p) && (rural(p) || publicPavement(p))
  const thinFringe = (p: Point, root?: Point) => !!root && bounded(p) && distance(root, p) <= 24 && input.demand.at(p) > 0 && input.demand.at(p) <= .25
  const cultivable = (p: Point) => rural(p) && !reserved(p) && !input.terrain.waterAt(p) && input.terrain.slope(p) <= .08 && (input.terrain.cultivable?.(p) ?? true)
  const workingField = (end: Point, heading: number, currentPavement: readonly PolygonRegion[]): PolygonRegion | null => {
    for (const side of [-1, 1]) {
      const at = (x: number, y: number) => ({ x: end.x + Math.cos(heading) * x - Math.sin(heading) * y * side, y: end.y + Math.sin(heading) * x + Math.cos(heading) * y * side })
      const polygon = [at(-36, 3), at(-4, 3), at(-4, 35), at(-36, 35)], bounds = boundsOf(polygon)
      if (fieldObstacles.some(obstacle => overlaps(bounds, obstacle.bounds) && polygonOverlapsRegion(polygon, obstacle.region))) continue
      if (currentPavement.some(region => polygonOverlapsRegion(polygon, region))) continue
      let valid = true
      for (let x = -36; x <= -4 && valid; x += 4) for (let y = 3; y <= 35; y += 4) if (!cultivable(at(x, y))) { valid = false; break }
      if (valid) return { polygon }
    }
    return null
  }
  const makePlanner = (root?: Point) => {
    const planner = new RoadPlanner({ width: input.width, height: input.height, core: null, areas: input.terrain.areas, terrain: { ...input.terrain, bridgeSites: [] }, exactLandCost: true, landCost: p => (permitted(p) || thinFringe(p, root)) && !reserved(p) ? 0 : Infinity })
    planner.setRailwayCorridors([...input.railways])
    return planner
  }
  let planner = makePlanner()
  let graph = new PlanarRoadGraph()
  for (const road of publicRoads) graph.add(road.points, { ...road, builtYear: road.builtYear ?? 1650, role: road.role ?? 'lane', phase: 'continuous-rural-existing', reason: road.reason ?? '接続元の公道', constructionCost: 0 }, false)
  planner.setRailwayRoadNetwork(graph.roads)
  const key = (p: Point) => `${Math.round(p.x * 20)}:${Math.round(p.y * 20)}`
  const adjacency = new Map<string, { to: string; year: number }[]>(), reached = new Map<string, number>(), queue = new MinHeap<string>()
  const improve = (node: string, year: number) => { if (year < (reached.get(node) ?? Infinity)) { reached.set(node, year); queue.push(node, year) } }
  for (const road of graph.roads) {
    for (let i = 1; i < road.points.length; i++) {
      const a = key(road.points[i - 1]!), b = key(road.points[i]!)
      const from = adjacency.get(a) ?? [], to = adjacency.get(b) ?? []
      from.push({ to: b, year: road.builtYear }); to.push({ to: a, year: road.builtYear }); adjacency.set(a, from); adjacency.set(b, to)
    }
    if (road.boundaryContinuation) for (const p of [road.points[0]!, road.points.at(-1)!]) if (p.x < 0 || p.y < 0 || p.x > input.width || p.y > input.height) improve(key(p), road.builtYear)
  }
  while (queue.size) {
    const item = queue.pop()!
    if (item.priority !== reached.get(item.value)) continue
    for (const edge of adjacency.get(item.value) ?? []) improve(edge.to, Math.max(item.priority, edge.year))
  }
  const opening = new Map(graph.roads.map(road => [road.id, Math.max(road.builtYear, Math.min(...road.points.map(p => reached.get(key(p)) ?? Infinity)))]))
  if (![...opening.values()].some(Number.isFinite)) return { roads: [], diagnostics: { ...diagnostics, unavailable: '区域外へ続く公道との接続がありません。' } }
  const physical = (route: PlannedRoute, node: Frontier) => {
    if (!continuousRuralFringeAllowed({ points: route.points, root: node.root, travelled: node.travelled, intensity: input.demand.at, oldPavement: publicPavement, bounded })) return false
    if (!Number.isFinite(route.cost) || route.bridgeLength > 0 || route.surveyedBridgeSpans?.length || alignmentDiagnostics(route.points).minimumRadius < 15 - 1e-6 || !planner.validate(route.points, width, false) || !planner.railwayWidthAllows(route.points, .01, width, 'farm')) return false
    const points = resampleAlignment(route.points, 4)
    if (!surveyedRoadGradeAllowed({ points }, maximumGrade, input.terrain.elevation)) return false
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1]!, b = route.points[i]!, strip = corridorPolygon(a, b, width / 2 + .4), bounds = boundsOf(strip)
      if (obstacles.some(o => overlaps(bounds, o.bounds) && polygonOverlapsRegion(strip, o.region))) return false
      const heading = turn(a, b), count = Math.max(1, Math.ceil(distance(a, b) / 4))
      for (let n = 0; n <= count; n++) for (const side of [-1, 0, 1]) {
        const p = { x: a.x + (b.x - a.x) * n / count - Math.sin(heading) * width / 2 * side, y: a.y + (b.y - a.y) * n / count + Math.cos(heading) * width / 2 * side }
        if (!bounded(p) || input.terrain.waterAt(p) || input.terrain.slope(p) > .13) return false
      }
    }
    return true
  }
  const random = seededRandom(`${input.config.seed}:rural-access`), maxRoads = Math.min(64, Math.max(4, Math.ceil(input.width * input.height / 1800000))), maxAttempts = maxRoads * 8
  const depthAlong = (point: Point, heading: number, limit: number, root = point, travelled = 0) => {
    let depth = 0
    for (let d = 8; d <= limit; d += 8) {
      const p = { x: point.x + Math.cos(heading) * d, y: point.y + Math.sin(heading) * d }
      if (!cultivable(p) && !((publicPavement(p) && permitted(p) || travelled + d <= 24 && thinFringe(p, root)) && !reserved(p) && !input.terrain.waterAt(p) && input.terrain.slope(p) <= .08)) break
      depth = d
    }
    return depth
  }
  const frontier: Frontier[] = [], anchors: Point[] = []
  const ordered = [...graph.roads].sort((a, b) => Number(b.role === 'farm') - Number(a.role === 'farm') || b.width - a.width || a.id.localeCompare(b.id))
  for (const road of ordered) {
    const year = opening.get(road.id) ?? Infinity
    if (!Number.isFinite(year) || year > 2025) continue
    const length = roadLength(road.points), count = Math.max(1, Math.ceil(length / (90 + random() * 30)))
    for (let i = 0; i < count; i++) {
      const t = (i + .5) / count, point = pathPointAt(road.points, t)
      if (!bounded(point) || reserved(point) || input.terrain.waterAt(point) || input.terrain.slope(point) > .08) continue
      const a = pathPointAt(road.points, Math.max(0, t - 50 / Math.max(1, length))), b = pathPointAt(road.points, Math.min(1, t + 50 / Math.max(1, length))), bearing = turn(a, b)
      const directions = [-1, 1].map(side => ({ heading: bearing + side * Math.PI / 2, depth: depthAlong(point, bearing + side * Math.PI / 2, 660) })).filter(direction => direction.depth >= 96)
      if (!directions.length || anchors.some(p => distance(p, point) < Math.min(260, Math.max(85, Math.max(...directions.map(direction => direction.depth)) * .55)))) continue
      anchors.push(point)
      for (const direction of directions.sort((a, b) => b.depth - a.depth)) frontier.push({ point, root: point, parentRoadId: road.id, year, travelled: 0, heading: direction.heading, generation: 0 })
      if (anchors.length >= maxRoads * 2) break
    }
    if (anchors.length >= maxRoads * 2) break
  }
  diagnostics.seeds = anchors.length
  const acquired = new Set<string>(), occupiedIds = new Set(input.roads.map(r => r.id))
  let serial = 0
  for (let cursor = 0; cursor < frontier.length && acquired.size < maxRoads && diagnostics.attempts < maxAttempts; cursor++) {
    const node = frontier[cursor]!, remaining = maximumReach - node.travelled
    if (remaining < 80) continue
    // Dry-component labels belong to a fixed land-cost field. Reusing one
    // planner while changing the root mask would retain stale connectivity.
    planner = makePlanner(node.travelled < 24 ? node.root : undefined)
    planner.setRailwayRoadNetwork(graph.roads)
    const desired = 400 + random() * 250
    const candidates = [0, -.35, .35, -.65, .65].map(offset => {
      const heading = node.heading + offset, depth = depthAlong(node.point, heading, Math.min(660, remaining + 12), node.root, node.travelled), reach = Math.min(remaining, depth - 8, depth < 420 ? 190 : desired)
      const point = { x: node.point.x + Math.cos(heading) * reach, y: node.point.y + Math.sin(heading) * reach }, shoulder = Math.min(60, reach * .28)
      const score = [0, -1, 1].reduce((n, side) => n + Number(cultivable({ x: point.x - Math.sin(heading) * side * shoulder, y: point.y + Math.cos(heading) * side * shoulder })), 0)
      return { point, heading, score, reach, maximumLength: depth < 420 ? 200 : remaining }
    }).filter(c => c.reach >= 80 && c.score >= 2 && cultivable(c.point) && !graph.nearest(c.point, Math.min(230, Math.max(45, c.reach * .48)))).sort((a, b) => b.score - a.score || Math.abs(a.heading - node.heading) - Math.abs(b.heading - node.heading))
    for (const candidate of candidates) {
      if (++diagnostics.attempts > maxAttempts) break
      const route = planner.plan(node.point, candidate.point, { role: 'farm', width, allowBridge: false, maximumGrade, maxNodes: 650 })
      if (!route || route.length > Math.min(remaining, candidate.maximumLength) + 1e-7 || route.length > distance(node.point, candidate.point) * 1.55 || !physical(route, node) || graph.hasAcuteMajorCrossing(route.points)) continue
      let id: string
      do { id = `continuous-farm-${++serial}` } while (occupiedIds.has(id))
      const metadata = { id, width, kind: 'local' as const, role: 'farm' as const, builtYear: node.year, phase: 'continuous-rural-access', reason: '実公道から乾燥農地区へ続く農業用接道', constructionCost: route.cost }
      const staged = graph.fork(), road = staged.add(route.points, metadata, true)
      if (!road || !physical({ ...route, points: road.points }, node) || !graph.nearest(road.points[0]!, 1e-7)) continue
      if (certifyLayoutAccess({ width: input.width, height: input.height, roads: staged.roads, targets: [{ id, point: road.points.at(-1)!, builtYear: node.year }] }).unserved.length) continue
      const length = roadLength(road.points), travelled = node.travelled + length
      if (travelled > maximumReach + 1e-7 || length > candidate.maximumLength + 1e-7) continue
      const paving = road.points.slice(1).map((b, i) => ({ polygon: corridorPolygon(road.points[i]!, b, road.width / 2 + .4) }))
      const end = road.points.at(-1)!, nextHeading = turn(pathPointAt(road.points, .8), end), field = workingField(end, nextHeading, paving)
      // An endpoint in an isolated dry pixel is insufficient: the final road
      // must directly serve a genuine32×32m workable holding beside its end.
      if (!field) continue
      // Later access branches cannot consume the working ground which made
      // this agricultural project useful in the first place.
      obstacles.push({ region: field, bounds: boundsOf(field.polygon) })
      fieldObstacles.push(...paving.map(region => ({ region, bounds: boundsOf(region.polygon) })))
      graph = staged; acquired.add(id); occupiedIds.add(id); planner.setRailwayRoadNetwork(graph.roads)
      diagnostics.accepted++; diagnostics.length += length; diagnostics.maximumNetworkDistance = Math.max(diagnostics.maximumNetworkDistance, travelled)
      diagnostics.projects.push({ id, parentRoadId: node.parentRoadId, root: node.root, from: road.points[0]!, to: end, builtYear: road.builtYear, length, networkDistance: travelled, workingField: field })
      if (node.generation < 2) {
        const successors: Frontier[] = []
        successors.push({ point: end, root: node.root, parentRoadId: id, year: road.builtYear, travelled, heading: nextHeading + (random() - .5) * .22, generation: node.generation + 1 })
        if (remaining - length * .55 > 350) successors.push({ point: pathPointAt(road.points, .55), root: node.root, parentRoadId: id, year: road.builtYear, travelled: node.travelled + length * .55, heading: nextHeading + (random() < .5 ? -1 : 1) * Math.PI / 2, generation: node.generation + 1 })
        frontier.splice(cursor + 1, 0, ...successors)
      }
      break
    }
  }
  return { roads: graph.roads.filter(r => acquired.has(r.id)).map(r => ({ ...r, points: r.points.map(p => ({ ...p })) })), diagnostics }
}
