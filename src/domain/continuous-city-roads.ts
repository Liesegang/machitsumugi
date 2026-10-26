import type { Point, Road } from './types'
import type { ContinuousCityRoadInput, ContinuousCityAccessTarget, ContinuousCityBlock } from './continuous-city-types'
import type { PlannedRoute, PlanningEnvironment, SurveyedBridgeSpan } from './road-planner'
import { RoadPlanner, roadConstructionFactor } from './road-planner'
import { routeAcrossBridges } from './bridge-routing'
import { RegionalRoadPlanner } from './regional-road-planner'
import { PlanarRoadGraph, extractStreetBlocks, roadLength, projectOnRoadSegment } from './road-graph'
import type { RoadRole, RoadProjection, SimulatedRoad } from './road-graph'
import { boundsOf, corridorPolygon, distance, distanceToSegment, overlaps, pointInPolygon, polygonArea, polygonOverlapsRegion, seededRandom } from './geometry'
import { alignmentDiagnostics, resampleAlignment } from './road-alignment'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'
import { regionQuery } from './region-query'
import { planModernTransport } from './modern-transport'
import { layoutMainCivilGuides, surveyLayoutMainCivilCrossings } from './layout-first-main-civil-bridges'

type CityRoad = Road & { surveyedBridgeSpans?: SurveyedBridgeSpan[] }
export interface ContinuousRoadDiagnostics {
  attempted: number; accepted: number; rejected: number; streetLength: number; boundaryConnections: number
  coarseFaces: number; blocks: number; demandSamples: number; framedDemandSamples: number; demandCoverage: number
  unservedAccessIds: string[]; accessAttempts: { id: string; from: Point; endHeading?: number; found: boolean }[]
  modern: { requested: string[]; completed: string[]; unavailable: { kind: string; reason: string }[] }
  bridgeSpans: (SurveyedBridgeSpan & { roadId: string })[]
  trunkSurveys: { stage: string; milliseconds: number; from?: Point; to?: Point; candidates?: number; found?: boolean }[]
  phaseMilliseconds: Record<string, number>
  sharedExpansion: { anchors: number; rungs: number; links: number; routeFailures: number; bridgeSurveys: number }
  largeFaceDetours: { faces: number; attempted: number; accepted: number; parentAreas: number[] }
}
interface Cut { points: Point[]; polygons: Point[][] }
const EPS = 1e-7
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const heading = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x)
/** Long straight cuts need a measured profile between their endpoints too. */
export function continuousCityRoadGradeAllowed(route: Pick<PlannedRoute, 'points' | 'surveyedBridgeSpans'>, maximumGrade: number, terrainElevation: (point: Point) => number) {
  return surveyedRoadGradeAllowed({ ...route, points: resampleAlignment(route.points, 5) }, maximumGrade, terrainElevation)
}
const centerOf = (polygon: readonly Point[]) => {
  let area = 0, x = 0, y = 0
  for (let i = 0; i < polygon.length; i++) { const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, cross = a.x * b.y - b.x * a.y; area += cross; x += (a.x + b.x) * cross; y += (a.y + b.y) * cross }
  return Math.abs(area) > EPS ? { x: x / (3 * area), y: y / (3 * area) } : polygon[0]!
}
const hit = (a: Point, b: Point, c: Point, d: Point) => {
  const x = b.x - a.x, y = b.y - a.y, u = d.x - c.x, v = d.y - c.y, det = x * v - y * u
  if (Math.abs(det) < 1e-10) return null
  const t = ((c.x - a.x) * v - (c.y - a.y) * u) / det, s = ((c.x - a.x) * y - (c.y - a.y) * x) / det
  return t >= -EPS && t <= 1 + EPS && s >= -EPS && s <= 1 + EPS ? { point: lerp(a, b, Math.max(0, Math.min(1, t))), t } : null
}

/** Geometric children are returned only for an interior, perimeter-to-perimeter
 * path. Physical acceptance is separate and must precede enqueuing children. */
export function partitionContinuousCityFace(polygon: readonly Point[], points: readonly Point[], minimumArea = 450): Point[][] | null {
  if (polygon.length < 3 || points.length < 2) return null
  const first = points[0]!, last = points.at(-1)!
  const edgeAt = (p: Point) => polygon.findIndex((a, i) => distanceToSegment(p, a, polygon[(i + 1) % polygon.length]!) < EPS)
  const start = edgeAt(first), end = edgeAt(last)
  if (start < 0 || end < 0 || start === end || distance(first, last) < 10) return null
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!
    if (distance(a, b) < .01) return null
    for (let j = 0; j < polygon.length; j++) { const crossing = hit(a, b, polygon[j]!, polygon[(j + 1) % polygon.length]!); if (crossing && !(i === 1 && distance(crossing.point, first) < EPS) && !(i === points.length - 1 && distance(crossing.point, last) < EPS)) return null }
    for (let j = 1; j < i - 1; j++) if (hit(a, b, points[j - 1]!, points[j]!)) return null
    const samples = Math.max(2, Math.ceil(distance(a, b) / 12))
    for (let n = 1; n < samples; n++) if (!pointInPolygon(lerp(a, b, n / samples), [...polygon])) return null
  }
  const walk = (from: number, to: number, a: Point, b: Point) => {
    const ring = [a]
    for (let n = 1; n <= polygon.length; n++) { const index = (from + n) % polygon.length; if (distance(ring.at(-1)!, polygon[index]!) > EPS) ring.push(polygon[index]!); if (index === to) break }
    if (distance(ring.at(-1)!, b) > EPS) ring.push(b)
    return ring
  }
  const children = [[...walk(start, end, first, last), ...points.slice(1, -1).reverse()], [...walk(end, start, last, first), ...points.slice(1, -1)]]
  if (children.some(child => polygonArea(child) < minimumArea) || Math.abs(children.reduce((sum, child) => sum + polygonArea(child), 0) - polygonArea([...polygon])) > Math.max(.02, polygonArea([...polygon]) * 1e-8)) return null
  return children
}

function lineCuts(polygon: readonly Point[], normal: number, fractions: readonly number[]): Cut[] {
  const nx = Math.cos(normal), ny = Math.sin(normal), values = polygon.map(p => p.x * nx + p.y * ny), low = Math.min(...values), high = Math.max(...values), result: Cut[] = []
  for (const fraction of fractions) {
    const offset = low + (high - low) * fraction, intersections: { point: Point; along: number }[] = []
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, da = a.x * nx + a.y * ny - offset, db = b.x * nx + b.y * ny - offset
      if (da * db > 0 || Math.abs(da - db) < 1e-10) continue
      const point = lerp(a, b, da / (da - db))
      if (!intersections.some(other => distance(other.point, point) < EPS)) intersections.push({ point, along: -point.x * ny + point.y * nx })
    }
    intersections.sort((a, b) => a.along - b.along)
    const candidates: Cut[] = []
    for (let i = 1; i < intersections.length; i++) {
      const points = [intersections[i - 1]!.point, intersections[i]!.point]
      if (!pointInPolygon(lerp(points[0]!, points[1]!, .5), [...polygon])) continue
      const polygons = partitionContinuousCityFace(polygon, points)
      if (polygons) candidates.push({ points, polygons })
    }
    candidates.sort((a, b) => Math.min(...b.polygons.map(polygonArea)) - Math.min(...a.polygons.map(polygonArea)))
    if (candidates[0]) result.push(candidates[0])
  }
  return result
}

class ContinuousRoadDesign {
  readonly graph = new PlanarRoadGraph()
  readonly planner: RoadPlanner
  readonly regional: RegionalRoadPlanner | null
  readonly diagnostics: ContinuousRoadDiagnostics = { attempted: 0, accepted: 0, rejected: 0, streetLength: 0, boundaryConnections: 0, coarseFaces: 0, blocks: 0, demandSamples: 0, framedDemandSamples: 0, demandCoverage: 0, unservedAccessIds: [], accessAttempts: [], modern: { requested: [], completed: [], unavailable: [] }, bridgeSpans: [], trunkSurveys: [], phaseMilliseconds: {}, sharedExpansion: { anchors: 0, rungs: 0, links: 0, routeFailures: 0, bridgeSurveys: 0 }, largeFaceDetours: { faces: 0, attempted: 0, accepted: 0, parentAreas: [] } }
  readonly environment: PlanningEnvironment
  private serial = 0
  readonly input: ContinuousCityRoadInput
  private reserves: { region: ContinuousCityRoadInput['reservedRegions'][number]; bounds: ReturnType<typeof boundsOf> }[]
  constructor(input: ContinuousCityRoadInput) {
    this.input = input
    const reserved = regionQuery(input.reservedRegions), base = input.environment
    // Demand controls development, not engineering path cost. In particular its
    // distance/shoreline sampler must not run inside every road-search edge.
    this.environment = { ...base, exactLandCost: true, landCost: p => reserved(p) ? Infinity : base.landCost?.(p) ?? 0 }
    this.reserves = input.reservedRegions.map(region => ({ region, bounds: boundsOf(region.polygon) }))
    this.planner = new RoadPlanner(this.environment)
    this.regional = base.terrain?.continuationTerrain ? new RegionalRoadPlanner(this.environment) : null
    this.planner.setRailwayCorridors(input.railways); this.regional?.setRailwayCorridors(input.railways)
    this.serial = Math.max(0, ...(input.initialRoads ?? []).map(road => Number(/^continuous-road-(\d+)$/.exec(road.id)?.[1] ?? 0)))
    for (const road of input.initialRoads ?? []) {
      const added = this.graph.add(road.points, { ...road, builtYear: road.builtYear ?? 1650, role: road.role ?? 'lane', phase: 'continuous-acquired', reason: road.reason ?? '今回取得した道路と施設通路', constructionCost: 0, preserveEndpoint: road.role === 'access' }, false)
      if (added) Object.assign(added, { surveyedBridgeSpans: (road as CityRoad).surveyedBridgeSpans })
    }
    this.syncRail()
  }
  private syncRail() { this.planner.setRailwayRoadNetwork(this.graph.roads); this.regional?.setRailwayRoadNetwork(this.graph.roads) }
  private elevation = (p: Point) => {
    const { width, height, terrain } = this.environment
    return p.x < 0 || p.y < 0 || p.x > width || p.y > height ? terrain?.continuationTerrain?.elevation(p) ?? terrain?.elevation(p) ?? 0 : terrain?.elevation(p) ?? 0
  }
  private rowAllows(points: readonly Point[], width: number) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!, strip = corridorPolygon(a, b, width / 2 + .75), bounds = boundsOf(strip)
      if (this.reserves.some(item => overlaps(bounds, item.bounds) && polygonOverlapsRegion(strip, item.region))) return false
      const h = heading(a, b), samples = Math.max(1, Math.ceil(distance(a, b) / 5))
      for (let n = 0; n <= samples; n++) for (const side of [-1, 0, 1]) { const p = lerp(a, b, n / samples); if (!Number.isFinite(this.environment.landCost?.({ x: p.x - Math.sin(h) * width / 2 * side, y: p.y + Math.cos(h) * width / 2 * side }) ?? 0)) return false }
    }
    return true
  }
  private canonical(route: PlannedRoute, preserveEnd = false): Point[] | null {
    const path = route.points.map(p => ({ ...p }))
    for (const i of preserveEnd ? [0] : [0, path.length - 1]) { const near = this.graph.nearest(path[i]!, EPS); if (near) path[i] = near.point }
    const points: Point[] = [path[0]!]
    for (let i = 1; i < path.length; i++) {
      for (const crossing of this.graph.crossings(path[i - 1]!, path[i]!)) {
        const old = crossing.road.points
        const segment = old.findIndex((a, j) => j + 1 < old.length && distanceToSegment(crossing.point, a, old[j + 1]!) < EPS)
        if (!crossing.road.bridge && segment >= 0 && !surveyedRoadGradeAllowed({ points: [old[segment]!, crossing.point, old[segment + 1]!] }, crossing.road.role === 'highway' ? .09 : .13, this.elevation)) return null
        if (distance(points.at(-1)!, crossing.point) > EPS) points.push(crossing.point)
      }
      if (distance(points.at(-1)!, path[i]!) > EPS) points.push(path[i]!)
    }
    return points.length >= 2 ? points : null
  }
  private valid(route: PlannedRoute, width: number, role: RoadRole, regional = false) {
    if (!Number.isFinite(route.cost) || !this.rowAllows(route.points, width) || !this.planner.railwayWidthAllows(route.points, .01, width, role)) return false
    if (route.bridgeLength > 0 && !route.surveyedBridgeSpans?.length) return false
    const minimum = role === 'expressway' ? 240 : role === 'ramp' ? 60 : role === 'highway' ? 85 : role === 'collector' ? 50 : role === 'lane' ? 15 : 0
    const grade = role === 'expressway' ? .07 : role === 'ramp' ? .10 : role === 'highway' ? .09 : .13
    return alignmentDiagnostics(route.points).minimumRadius >= minimum - 1e-6 && (regional && this.regional ? this.regional.validate(route.points, width, route.bridgeLength > 0) : this.planner.validate(route.points, width, route.bridgeLength > 0)) && continuousCityRoadGradeAllowed(route, grade, this.elevation)
  }
  private accept(route: PlannedRoute | null, width: number, role: RoadRole, year: number, reason: string, outside = false, requireConnection = true) {
    this.diagnostics.attempted++
    if (!route) { this.diagnostics.rejected++; return null }
    const points = this.canonical(route, role === 'access')
    if (!points || !this.valid({ ...route, points }, width, role, outside)) { this.diagnostics.rejected++; return null }
    const added = this.graph.add(points, { id: `continuous-road-${++this.serial}`, builtYear: year, role, width, kind: outside && role === 'highway' ? 'arterial' : 'local', phase: outside ? 'continuous-regional-trunk' : 'continuous-urban-fabric', reason, constructionCost: route.cost, ...(outside ? { boundaryContinuation: true, throughRouteId: `continuous-trunk-${this.serial}` } : {}), ...(route.bridgeLength > 0 ? { bridge: true } : {}), ...(role === 'access' ? { preserveEndpoint: true } : {}) }, requireConnection)
    if (!added) { this.diagnostics.rejected++; return null }
    Object.assign(added, { surveyedBridgeSpans: route.surveyedBridgeSpans })
    this.diagnostics.accepted++; this.diagnostics.streetLength += roadLength(added.points)
    for (const span of route.surveyedBridgeSpans ?? []) this.diagnostics.bridgeSpans.push({ ...span, roadId: added.id })
    if (this.input.railways.some(railway => railway.points.slice(1).some((b, i) => route.points.slice(1).some((d, j) => hit(railway.points[i]!, b, route.points[j]!, d))))) this.syncRail()
    return added
  }
  private publicProjections(point: Point, year: number, count = 16): RoadProjection[] {
    const hits: RoadProjection[] = []
    for (const road of this.graph.roads) {
      if (road.builtYear > year || road.width < 4.6 || road.controlledAccess || (road.level ?? 0) !== 0) continue
      for (let i = 1; i < road.points.length; i++) { const a = road.points[i - 1]!, b = road.points[i]!, projection = projectOnRoadSegment(point, a, b); hits.push({ ...projection, point: projection.point, distance: distance(point, projection.point), road, a, b }) }
    }
    hits.sort((a, b) => a.distance - b.distance)
    const result: RoadProjection[] = []
    for (const candidate of hits) { if (!this.planner.suitable(candidate.point, 5) || result.some(other => distance(other.point, candidate.point) < 100)) continue; result.push(candidate); if (result.length >= count) break }
    return result
  }
  trunks() {
    if (!this.regional) return
    const { width, height } = this.environment, center = this.input.center
    let started = performance.now()
    this.input.onProgress?.('実地形で区域外の幹線接続口を測量中…')
    const sides = [{ x: 0, y: center.y }, { x: width, y: center.y }, { x: center.x, y: 0 }, { x: center.x, y: height }]
    const portals = sides.map(preferred => this.regional!.boundaryPortals(center, { width: 12, preferred, maxCandidates: 1 })[0])
    this.diagnostics.trunkSurveys.push({ stage: 'regional-portals', milliseconds: performance.now() - started, candidates: portals.filter(Boolean).length })
    const pairs = [[0, 1], [2, 3], [0, 2], [1, 2], [0, 3], [1, 3]].flatMap(([a, b]) => portals[a!] && portals[b!] ? [{ a: portals[a!]!, b: portals[b!]! }] : [])
    let main: SimulatedRoad | null = null
    for (const pair of pairs) {
      if (distance(pair.a, pair.b) < Math.min(width, height) * .6) continue
      // Civil bridge alternatives come from the actual road bearing; they are
      // engineering surveys, not an inherited city alignment or district map.
      let planner = this.regional
      const terrain = this.environment.terrain
      if (terrain?.channelAt) {
        started = performance.now()
        this.input.onProgress?.('幹線の進行方向に合わせた実河川の橋を測量中…')
        const extra = surveyLayoutMainCivilCrossings({ guides: layoutMainCivilGuides(pair.a, pair.b), width: 12, waterRegions: this.environment.areas.filter(area => area.kind === 'water'), terrain, rowAllows: (points, roadWidth) => this.rowAllows(points, roadWidth), railwayAllows: (points, roadWidth) => this.planner.railwayWidthAllows(points, .01, roadWidth, 'highway'), bridgeAllows: (points, roadWidth) => this.regional!.validate(points, roadWidth, true), maximumCandidates: 20 })
        this.diagnostics.trunkSurveys.push({ stage: 'civil-crossings', milliseconds: performance.now() - started, from: pair.a, to: pair.b, candidates: extra.length })
        if (extra.length) { planner = new RegionalRoadPlanner({ ...this.environment, terrain: { ...terrain, bridgeCandidates: [...(terrain.bridgeCandidates ?? []), ...extra] } }); planner.setRailwayCorridors(this.input.railways) }
      }
      started = performance.now()
      this.input.onProgress?.('区域外から区域外へ続く幹線の全線形を測量中…')
      const route = planner.plan(pair.a, pair.b, { role: 'highway', width: 12, allowBridge: true, alignment: 'planned', maximumGrade: .09, maxNodes: 8000, maxNodesPerKm: 1400, avoidRepeatedRiverCrossings: true })
      this.diagnostics.trunkSurveys.push({ stage: 'main-alignment', milliseconds: performance.now() - started, from: pair.a, to: pair.b, found: !!route })
      if (route && route.length <= distance(pair.a, pair.b) * 1.65) main = this.accept(route, 12, 'highway', 1650, '市域の外から外へ連続する広域幹線', true, false)
      if (main) break
    }
    if (!main) return
    for (const portal of portals) {
      if (!portal || main.points.some(point => distance(point, portal) < 100)) continue
      const anchor = this.publicProjections(center, 1650, 1)[0]
      if (!anchor) continue
      started = performance.now()
      this.input.onProgress?.('区域外の集散道路を幹線へ接続中…')
      const route = this.regional.plan(portal, anchor.point, { role: 'collector', width: 9, allowBridge: true, maximumGrade: .13, maxNodes: 3200 })
      this.diagnostics.trunkSurveys.push({ stage: 'regional-branch', milliseconds: performance.now() - started, from: portal, to: anchor.point, found: !!route })
      this.accept(route, 9, 'collector', 1650, '広域幹線へ接続して区域外へ続く集散道路', true, false)
    }
  }
  /** Each short connection is independent. A wet failed link cannot veto all
   * the other dry district boundaries in a many-kilometre enclosing loop. */
  private sharedCollector(from: Point, to: Point, year: number, reason: string) {
    const width = 8.5, role = 'collector' as const, direct = this.planner.cost([from, to], role)
    if (this.valid(direct, width, role)) return this.accept(direct, width, role, year, reason)
    const points = resampleAlignment([from, to], 12)
    if (points.some(point => this.environment.terrain?.seaAt?.(point))) return null
    let route: PlannedRoute | null = null
    if (points.some(point => this.planner.waterAt(point))) {
      const bounds = boundsOf([from, to]), margin = 220, inRange = (point: Point) => point.x >= bounds.minX - margin && point.x <= bounds.maxX + margin && point.y >= bounds.minY - margin && point.y <= bounds.maxY + margin
      const terrain = this.environment.terrain
      const civil = terrain?.channelAt ? surveyLayoutMainCivilCrossings({ guides: [[from, to]], width, waterRegions: this.environment.areas.filter(area => area.kind === 'water'), terrain, rowAllows: (path, pavement) => this.rowAllows(path, pavement), railwayAllows: (path, pavement) => this.planner.railwayWidthAllows(path, .01, pavement, role), bridgeAllows: (path, pavement) => this.planner.validate(path, pavement, true), maximumCandidates: 8, maximumWetLength: 180 }) : []
      this.diagnostics.sharedExpansion.bridgeSurveys++
      const candidates = [...civil, ...(terrain?.bridgeCandidates ?? []).filter(candidate => inRange(candidate.bankA) && inRange(candidate.bankB))]
      const pairs = candidates.filter(candidate => this.planner.suitable(candidate.bankA, width) && this.planner.suitable(candidate.bankB, width) && this.rowAllows([candidate.bankA, candidate.bankB], width) && this.planner.validate([candidate.bankA, candidate.bankB], width, true)).map(candidate => ({ a: candidate.bankA, b: candidate.bankB, riverId: candidate.riverId, candidateId: candidate.id }))
      if (pairs.length) route = routeAcrossBridges({ start: from, goal: to, pairs, role, width, lowerBound: (a, b) => distance(a, b) * roadConstructionFactor(role), cost: path => this.planner.cost(path, role, true), dry: (a, b, startHeading, endHeading) => this.planner.plan(a, b, { role, width, alignment: 'planned', allowBridge: false, maximumGrade: .13, maxNodes: 650, startHeading, endHeading }) })
    } else route = this.planner.plan(from, to, { role, width, allowBridge: false, alignment: 'planned', maximumGrade: .13, maxNodes: 650 })
    if (!route || route.length > distance(from, to) * 1.7) { this.diagnostics.sharedExpansion.routeFailures++; return null }
    return this.accept(route, width, role, year, reason)
  }
  private fieldSamples() {
    const { width, height } = this.environment, step = Math.max(120, Math.sqrt(width * height / 1600)), result: Point[] = []
    for (let y = step / 2; y < height; y += step) for (let x = step / 2; x < width; x += step) { const point = { x, y }; if (this.input.demand.at(point) > 0 && !this.planner.waterAt(point) && (this.environment.terrain?.slope(point) ?? 0) <= .13 && Number.isFinite(this.environment.landCost?.(point) ?? 0)) result.push(point) }
    return result
  }
  private frame(samples: Point[]) {
    if (!samples.length) return
    const main = this.graph.roads.filter(road => road.width >= 9 && road.boundaryContinuation).sort((a, b) => roadLength(b.points) - roadLength(a.points))[0]
    if (!main) return
    const axis = heading(main.points[0]!, main.points.at(-1)!), nx = -Math.sin(axis), ny = Math.cos(axis), ux = Math.cos(axis), uy = Math.sin(axis), length = roadLength(main.points)
    const at = (chainage: number) => { let remaining = chainage; for (let i = 1; i < main.points.length; i++) { const a = main.points[i - 1]!, b = main.points[i]!, span = distance(a, b); if (remaining <= span) return lerp(a, b, remaining / span); remaining -= span } return main.points.at(-1)! }
    const suitable = (point: Point) => this.planner.suitable(point, 8.5) && (this.environment.terrain?.slope(point) ?? 0) <= .13
    const anchors: { point: Point; along: number }[] = []
    const addAnchor = (along: number) => { for (const offset of [0, -45, 45, -100, 100]) { const point = at(Math.max(0, Math.min(length, along + offset))); if (!suitable(point) || anchors.some(anchor => distance(anchor.point, point) < 280)) continue; anchors.push({ point, along: along + offset }); return } }
    const stations = resampleAlignment(main.points, 30), first = stations.findIndex(suitable), last = stations.findLastIndex(suitable)
    if (first < 0 || last <= first) return
    const alongAt = (index: number) => roadLength(stations.slice(0, index + 1))
    addAnchor(alongAt(first)); addAnchor(alongAt(last))
    for (let along = alongAt(first) + 680; along < alongAt(last) - 280; along += 650 + 170 * (.5 + .5 * Math.sin(along / 2100))) addAnchor(along)
    anchors.sort((a, b) => a.along - b.along)
    this.diagnostics.sharedExpansion.anchors = anchors.length
    type Node = { point: Point; depth: number; year: number }
    type Rung = { base: Point; side: number; nodes: Node[]; links: SimulatedRoad[]; limit: number; stopped: boolean; step: number }
    const sampleReach = Math.max(120, Math.sqrt(this.environment.width * this.environment.height / 1600)) * .65
    const rungs: Rung[] = anchors.flatMap((anchor, index) => [-1, 1].map(side => {
      const relevant = samples.filter(point => Math.abs((point.x - anchor.point.x) * ux + (point.y - anchor.point.y) * uy) < 700)
      const limit = Math.max(0, ...relevant.map(point => ((point.x - anchor.point.x) * nx + (point.y - anchor.point.y) * ny) * side)) + sampleReach
      return { base: anchor.point, side, nodes: [{ point: anchor.point, depth: 0, year: main.builtYear }], links: [], limit, stopped: false, step: 350 + index % 3 * 38 }
    }))
    const maximumBands = Math.ceil(Math.hypot(this.environment.width, this.environment.height) / 300) + 1
    for (let band = 1; band <= maximumBands; band++) {
      let advanced = false
      for (const rung of rungs) {
        if (rung.stopped) continue
        const previous = rung.nodes.at(-1)!, remaining = rung.limit - previous.depth
        if (remaining < 60) { rung.stopped = true; continue }
        let added = false
        for (const scale of [1, .7, .4]) {
          const depth = previous.depth + Math.min(remaining, rung.step * scale)
          const candidates = [0, -45, 45, -100, 100].map(offset => ({ x: rung.base.x + nx * rung.side * depth + ux * offset, y: rung.base.y + ny * rung.side * depth + uy * offset }))
          const point = candidates.find(point => suitable(point) && this.input.demand.at(point) > 0)
          if (!point || distance(point, previous.point) < 55) continue
          const year = Math.max(previous.year, this.input.demand.openingAt(point)), road = this.sharedCollector(previous.point, point, year, '幹線から連続需要へ段階的に伸びる共有集散道路')
          if (!road) continue
          rung.nodes.push({ point, depth, year: road.builtYear }); rung.links.push(road); this.diagnostics.sharedExpansion.rungs++; advanced = true; added = true; break
        }
        if (!added) rung.stopped = true
      }
      for (const side of [-1, 1]) {
        const frontier = rungs.filter(rung => rung.side === side && rung.nodes.length > 1 && rung.nodes.at(-1)!.depth >= (band - 1) * 340 + 80)
        for (let i = 1; i < frontier.length; i++) {
          const a = frontier[i - 1]!, b = frontier[i]!
          if (distance(a.base, b.base) > 1900) continue
          const endA = a.nodes.at(-1)!, endB = b.nodes.at(-1)!, common = Math.min(endA.depth, endB.depth)
          const contact = (rung: Rung, depth: number): Node | null => {
            for (const road of rung.links) for (let j = 1; j < road.points.length; j++) {
              const p = road.points[j - 1]!, q = road.points[j]!, dp = ((p.x - rung.base.x) * nx + (p.y - rung.base.y) * ny) * rung.side, dq = ((q.x - rung.base.x) * nx + (q.y - rung.base.y) * ny) * rung.side
              if (Math.abs(dp - dq) < EPS || depth < Math.min(dp, dq) - EPS || depth > Math.max(dp, dq) + EPS) continue
              const point = lerp(p, q, (depth - dp) / (dq - dp))
              if (suitable(point)) return { point, depth, year: road.builtYear }
            }
            return null
          }
          for (const offset of [0, -90, -170]) {
            const from = offset === 0 ? endA : contact(a, common + offset), to = offset === 0 ? endB : contact(b, common + offset)
            if (!from || !to || common + offset < 90) continue
            const road = this.sharedCollector(from.point, to.point, Math.max(from.year, to.year), '隣り合う実集散道路を結び市街地の共有大街区を閉じる道路')
            if (road) { this.diagnostics.sharedExpansion.links++; break }
          }
        }
      }
      if (!advanced) break
    }
  }
  private gate(target: ContinuousCityAccessTarget) {
    const candidates = this.publicProjections(target.point, target.builtYear, 24)
    if (candidates.some(hit => hit.distance < EPS)) return true
    const sectors = new Set<number>(), selected: RoadProjection[] = []
    for (const candidate of candidates) { const sector = Math.floor((heading(target.point, candidate.point) + Math.PI) / (Math.PI / 4)); if (sectors.has(sector)) continue; sectors.add(sector); selected.push(candidate); if (selected.length === 4) break }
    for (const mouth of [false, true]) {
      if (mouth && target.endHeading === undefined) continue
      for (const anchor of selected) {
        const route = this.planner.plan(anchor.point, target.point, { role: 'access', width: 6.5, allowBridge: true, alignment: 'planned', maximumGrade: .13, maxNodes: 1800, ...(mouth ? { endHeading: target.endHeading } : {}) })
        this.diagnostics.accessAttempts.push({ id: target.id, from: anchor.point, ...(mouth ? { endHeading: target.endHeading } : {}), found: !!route })
        if (this.accept(route, 5, 'access', target.builtYear, '取得済みの施設・駅入口と同時代の公道を結ぶ道路')) return true
      }
    }
    return false
  }
  private modern() {
    const { config } = this.input, { width, height } = this.environment
    for (const kind of ['bypass', 'expressway'] as const) {
      if (!config[kind]) continue
      this.diagnostics.modern.requested.push(kind)
      const year = kind === 'bypass' ? 1975 : 1985, datedGraph = new PlanarRoadGraph()
      for (const road of this.graph.roads) if (road.builtYear <= year) datedGraph.add(road.points, road, false)
      const project = this.regional && planModernTransport({ graph: datedGraph, planner: this.planner, regionalPlanner: this.regional, width, height, year, households: Math.round(this.input.demand.metrics.selectedUrbanArea / 650), jobs: Math.round(this.input.demand.metrics.selectedUrbanArea / 1100), funds: (width + height) * 60, kind, planningLimits: { maxPairs: 1, maxAnchors: 2, maxDeltas: 1, maxNodes: 1800 } })
      if (!project || !this.valid(project.mainline, project.width, project.role, true) || project.accesses.some(access => !this.valid(access.route, access.width, access.role))) { this.diagnostics.modern.unavailable.push({ kind, reason: '有限の実線形・工費・接続・保護幅検査を満たす広域計画がありません。' }); continue }
      const metadata = { builtYear: year, kind: 'arterial' as const, phase: 'continuous-modern-transport', reason: kind === 'bypass' ? '広域バイパス' : '区域外へ続く高速道路と実接続のランプ', constructionCost: project.cost }
      const added = this.graph.addBatch([{ points: project.mainline.points, metadata: { ...metadata, id: `continuous-${kind}`, width: project.width, role: project.role, level: kind === 'expressway' ? 1 : 0, controlledAccess: kind === 'expressway', boundaryContinuation: true, bridge: project.mainline.bridgeLength > 0 }, requireConnection: false }, ...project.accesses.map((access, i) => ({ points: access.route.points, metadata: { ...metadata, id: `continuous-${kind}-access-${i}`, width: access.width, role: access.role, level: access.level, controlledAccess: access.controlledAccess, preserveEndpoint: true } }))])
      if (added) {
        for (const [i, road] of added.entries()) {
          const route = i === 0 ? project.mainline : project.accesses[i - 1]!.route
          Object.assign(road, { surveyedBridgeSpans: route.surveyedBridgeSpans })
          for (const span of route.surveyedBridgeSpans ?? []) this.diagnostics.bridgeSpans.push({ ...span, roadId: road.id })
        }
        this.diagnostics.modern.completed.push(kind); this.syncRail()
      } else this.diagnostics.modern.unavailable.push({ kind, reason: '本線と取付道路を一体として接続できません。' })
    }
  }
  private bearing(polygon: Point[]) {
    const groups = new Map<string, { x: number; y: number; length: number }>()
    for (let i = 0; i < polygon.length; i++) { const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, road = this.graph.nearest(lerp(a, b, .5), .1)?.road; if (!road) continue; const length = distance(a, b), h = heading(a, b), group = groups.get(road.id) ?? { x: 0, y: 0, length: 0 }; group.x += Math.cos(h * 2) * length; group.y += Math.sin(h * 2) * length; group.length += length; groups.set(road.id, group) }
    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0]
    return best ? Math.atan2(best.y, best.x) / 2 : 0
  }
  private barrierCuts(polygon: Point[], width: number): Cut[] {
    const bounds = boundsOf(polygon), center = centerOf(polygon), barriers = [...this.input.railways.filter(railway => railway.mode !== 'subway').map(railway => railway.points), ...(this.environment.terrain?.rivers ?? []).map(river => river.points)]
    const nearby = barriers.flatMap(points => points.slice(1).map((b, i) => ({ a: points[i]!, b, distance: distanceToSegment(center, points[i]!, b) }))).filter(segment => overlaps(bounds, boundsOf([segment.a, segment.b]))).sort((a, b) => a.distance - b.distance)
    const segment = nearby[0]
    if (!segment) return []
    const direction = heading(segment.a, segment.b), normal = direction + Math.PI / 2, nx = Math.cos(normal), ny = Math.sin(normal), values = polygon.map(point => point.x * nx + point.y * ny), lo = Math.min(...values), hi = Math.max(...values), middle = (segment.a.x + segment.b.x) / 2 * nx + (segment.a.y + segment.b.y) / 2 * ny
    const bank = this.environment.terrain?.channelAt?.(lerp(segment.a, segment.b, .5))?.width ?? 0
    return lineCuts(polygon, normal, [1, -1, 1.6, -1.6].map(side => (middle + side * (bank / 2 + Math.max(48, width * 4)) - lo) / (hi - lo)).filter(fraction => fraction > .08 && fraction < .92))
  }
  private detourCut(polygon: Point[], candidates: Cut[], width: number, role: 'collector' | 'lane', opening: number) {
    const ranked = [...candidates].sort((a, b) => Math.min(...b.polygons.map(polygonArea)) - Math.min(...a.polygons.map(polygonArea))), first = ranked[0]
    if (!first) return null
    this.diagnostics.largeFaceDetours.faces++
    const angle = heading(first.points[0]!, first.points.at(-1)!), second = ranked.slice(1).find(candidate => Math.abs(Math.sin(heading(candidate.points[0]!, candidate.points.at(-1)!) - angle)) > .7) ?? ranked[1]
    // A narrow allowance at the existing perimeter accommodates its pavement
    // shoulders. The returned centreline must still lie exactly inside the
    // parent and partition it before any graph mutation occurs.
    const parentAllows = (point: Point) => pointInPolygon(point, polygon) || polygon.some((a, i) => distanceToSegment(point, a, polygon[(i + 1) % polygon.length]!) <= width + 2)
    const planner = new RoadPlanner({ ...this.environment, exactLandCost: true, landCost: point => parentAllows(point) ? this.environment.landCost?.(point) ?? 0 : Infinity })
    planner.setRailwayCorridors(this.input.railways); planner.setRailwayRoadNetwork(this.graph.roads)
    for (const candidate of [first, second].filter((cut): cut is Cut => !!cut)) {
      const from = this.graph.nearest(candidate.points[0]!, EPS), to = this.graph.nearest(candidate.points.at(-1)!, EPS)
      if (!from || !to || from.road.controlledAccess || to.road.controlledAccess) continue
      this.diagnostics.largeFaceDetours.attempted++
      const route = planner.plan(from.point, to.point, { role, width, alignment: 'planned', allowBridge: false, maximumGrade: .13, maxNodes: 650 })
      if (!route || route.length > distance(from.point, to.point) * 1.8) continue
      const points = this.canonical(route), children = points && partitionContinuousCityFace(polygon, points)
      if (!points || !children || !this.valid({ ...route, points }, width, role)) continue
      const road = this.accept({ ...route, points }, width, role, Math.max(opening, from.road.builtYear, to.road.builtYear), '保護敷地・水域・鉄道を避けて実大街区の中を結ぶ生活街路')
      if (!road) continue
      const actualChildren = partitionContinuousCityFace(polygon, road.points)
      if (!actualChildren) throw new Error('Accepted large-face detour does not partition its physical parent')
      this.diagnostics.largeFaceDetours.accepted++; this.diagnostics.largeFaceDetours.parentAreas.push(polygonArea(polygon))
      return actualChildren
    }
    return null
  }
  build() {
    if (!this.graph.roads.some(road => road.width >= 8)) this.trunks()
    let started = performance.now()
    for (const target of this.input.accessTargets ?? []) if (!this.gate(target)) this.diagnostics.unservedAccessIds.push(target.id)
    this.diagnostics.phaseMilliseconds.openingAccess = performance.now() - started
    started = performance.now()
    const samples = this.fieldSamples()
    this.diagnostics.phaseMilliseconds.fieldSamples = performance.now() - started
    this.input.onProgress?.('連続需要全体を囲む共有の集散道路を測量中…')
    started = performance.now(); this.frame(samples)
    this.diagnostics.phaseMilliseconds.frame = performance.now() - started
    this.input.onProgress?.('広域バイパス・高速道路の実線形と接続を検査中…')
    started = performance.now(); this.modern()
    this.diagnostics.phaseMilliseconds.modern = performance.now() - started
    started = performance.now()
    const coarse = extractStreetBlocks(this.graph.roads)
    this.diagnostics.coarseFaces = coarse.length
    this.diagnostics.demandSamples = samples.length
    this.diagnostics.framedDemandSamples = samples.filter(point => coarse.some(polygon => pointInPolygon(point, polygon) || polygon.some((a, i) => distanceToSegment(point, a, polygon[(i + 1) % polygon.length]!) < EPS))).length
    this.diagnostics.demandCoverage = samples.length ? this.diagnostics.framedDemandSamples / samples.length : 0
    const queue = coarse.map(polygon => ({ polygon, depth: 0, bearing: this.bearing(polygon), barrier: { sides: 0 } }))
    this.diagnostics.phaseMilliseconds.coarseFaces = performance.now() - started
    this.input.onProgress?.('共有の実道路面を大街区から生活街区へ細分中…')
    started = performance.now()
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { polygon, depth, bearing, barrier } = queue[cursor]!, bounds = boundsOf(polygon), center = centerOf(polygon)
      if (depth >= 20 || polygonArea(polygon) < 1200) continue
      let intensity = this.input.demand.at(center)
      for (const fx of [.2, .5, .8]) for (const fy of [.2, .5, .8]) { const point = { x: bounds.minX + (bounds.maxX - bounds.minX) * fx, y: bounds.minY + (bounds.maxY - bounds.minY) * fy }; if (pointInPolygon(point, polygon)) intensity = Math.max(intensity, this.input.demand.at(point)) }
      if (intensity <= 0) continue
      const large = polygonArea(polygon) > 300000, short = large ? 450 : 35 + (1 - intensity) * 25, long = large ? 650 : 85 + (1 - intensity) * 55
      const c = Math.cos(bearing), s = Math.sin(bearing), u = polygon.map(p => p.x * c + p.y * s), v = polygon.map(p => -p.x * s + p.y * c), du = Math.max(...u) - Math.min(...u), dv = Math.max(...v) - Math.min(...v)
      if (du <= long * 1.35 && dv <= short * 1.35) continue
      const random = seededRandom(`${this.input.config.seed}:continuous-face:${center.x.toFixed(1)}:${center.y.toFixed(1)}:${depth}`), normal = du / long > dv / short ? bearing : bearing + Math.PI / 2, fraction = .44 + random() * .12
      const width = large ? 8.5 : intensity > .75 ? 5.2 : 5.8, candidates = [...lineCuts(polygon, normal, [fraction, .32, .68]), ...lineCuts(polygon, normal + Math.PI / 2, [.47, .61])]
      if (barrier.sides < 2 && polygonArea(polygon) > 40000) candidates.push(...this.barrierCuts(polygon, width))
      let divided = false
      for (const [index, candidate] of candidates.entries()) {
        const from = this.graph.nearest(candidate.points[0]!, EPS), to = this.graph.nearest(candidate.points.at(-1)!, EPS)
        if (!from || !to || from.road.controlledAccess || to.road.controlledAccess) continue
        const year = Math.max(from.road.builtYear, to.road.builtYear, this.input.demand.openingAt(center)), role = large ? 'collector' : 'lane'
        const route = this.planner.cost(candidate.points, role)
        const added = this.accept(route, width, role, year, large ? '連続市街地を分ける共有の大街区境界' : '実公道の間をずらして結ぶ生活街路')
        if (!added) continue
        const children = partitionContinuousCityFace(polygon, added.points)
        if (!children) throw new Error('Accepted continuous street does not partition its physical parent')
        if (index >= 5) barrier.sides++
        queue.push(...children.map(child => ({ polygon: child, depth: depth + 1, bearing: large ? this.bearing(child) : bearing, barrier })))
        divided = true
        break
      }
      if (!divided && polygonArea(polygon) > 100000) {
        const children = this.detourCut(polygon, candidates, width, large ? 'collector' : 'lane', this.input.demand.openingAt(center))
        if (children) queue.push(...children.map(child => ({ polygon: child, depth: depth + 1, bearing: this.bearing(child), barrier })))
      }
    }
    this.diagnostics.phaseMilliseconds.subdivision = performance.now() - started
    const retry = new Set(this.diagnostics.unservedAccessIds)
    this.diagnostics.unservedAccessIds = []
    for (const target of this.input.accessTargets ?? []) if (retry.has(target.id) && !this.gate(target)) this.diagnostics.unservedAccessIds.push(target.id)
    return this.result()
  }
  result() {
    const sides = new Set<string>(), { width, height } = this.environment
    for (const road of this.graph.roads) if (road.boundaryContinuation) for (const point of [road.points[0]!, road.points.at(-1)!]) { if (point.x < 0) sides.add('west'); if (point.x > width) sides.add('east'); if (point.y < 0) sides.add('north'); if (point.y > height) sides.add('south') }
    this.diagnostics.boundaryConnections = sides.size
    const blocks: ContinuousCityBlock[] = extractStreetBlocks(this.graph.roads).map((polygon, i) => ({ id: `continuous-block-${i}`, polygon }))
    this.diagnostics.blocks = blocks.length
    return { roads: this.graph.roads as CityRoad[], blocks, diagnostics: this.diagnostics }
  }
}

export function surveyContinuousCityTrunks(input: ContinuousCityRoadInput) { const design = new ContinuousRoadDesign({ ...input, initialRoads: [] }); design.trunks(); const { roads, diagnostics } = design.result(); return { roads, diagnostics } }
export function buildContinuousCityRoads(input: ContinuousCityRoadInput) { return new ContinuousRoadDesign(input).build() }
