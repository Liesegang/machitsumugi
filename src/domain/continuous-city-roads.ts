import type { Point, Road } from './types'
import type { ContinuousCityRoadInput, ContinuousCityAccessTarget, ContinuousCityBlock } from './continuous-city-types'
import type { PlannedRoute, PlanningEnvironment, SurveyedBridgeSpan } from './road-planner'
import { RoadPlanner, roadConstructionFactor } from './road-planner'
import { routeAcrossBridges } from './bridge-routing'
import { RegionalRoadPlanner } from './regional-road-planner'
import { RailwayRoadConstraints } from './railway-road-constraints'
import { MinHeap, PlanarRoadGraph, extractStreetBlocks, roadLength, projectOnRoadSegment } from './road-graph'
import type { RoadRole, RoadProjection, SimulatedRoad } from './road-graph'
import { boundsOf, corridorPolygon, distance, distanceToSegment, intersectRegions, overlaps, pointInPolygon, pointInRegion, polygonArea, polygonOverlapsRegion, regionArea, subtractRegions } from './geometry'
import type { PolygonRegion } from './geometry'
import { alignmentDiagnostics, resampleAlignment } from './road-alignment'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'
import { regionQuery } from './region-query'
import { planModernTransport } from './modern-transport'
import { layoutMainCivilGuides, surveyLayoutMainCivilCrossings } from './layout-first-main-civil-bridges'

type CityRoad = Road & { surveyedBridgeSpans?: SurveyedBridgeSpan[] }
export interface ContinuousRoadDiagnostics {
  attempted: number; accepted: number; rejected: number; streetLength: number; boundaryConnections: number
  coarseFaces: number; blocks: number; demandSamples: number; framedDemandSamples: number; demandCoverage: number
  coarseDemandCoverage?: number
  collectorReachability?: { samples: number; servedBefore: number; servedAfter: number; attempted: number; streets: number; maximumDryDistance: number }
  unservedAccessIds: string[]; accessAttempts: { id: string; from: Point; endHeading?: number; found: boolean }[]
  modern: { requested: string[]; completed: string[]; unavailable: { kind: string; reason: string }[] }
  bridgeSpans: (SurveyedBridgeSpan & { roadId: string })[]
  trunkSurveys: { stage: string; milliseconds: number; from?: Point; to?: Point; candidates?: number; found?: boolean }[]
  phaseMilliseconds: Record<string, number>
  sharedExpansion: { anchors: number; rungs: number; links: number; routeFailures: number; bridgeSurveys: number }
  largeFaceDetours: { faces: number; attempted: number; accepted: number; parentAreas: number[] }
  districtStreets: { spines: number; reorientations: number; serviceLoops: number; loopDryArea: number; uncoveredRestarts: number }
  normalizationRejectedCuts: number
  partitionRejections: { reason: string; polygon: Point[]; proposedPath: Point[]; canonicalPath: Point[]; normalizedPath: Point[]; reusedRoadId?: string }[]
  localNetwork?: { cellSize: number; dryCells: number; servedBefore: number; servedAfter: number; attempted: number; streets: number; connectedEnds: number; deadEnds: number; revivedCells: number; gainedAreaEstimate: number; unservedAreaEstimate: number }
}
const EPS = 1e-7
/** Diagnostic only. Expanded boxes retain the original strict boundary
 * tolerance; the final ray cast and segment-distance arithmetic are unchanged. */
export function continuousCityFaceCoverageQuery(polygons: readonly Point[][]): (point: Point) => boolean {
  const bins = new Map<string, { polygon: Point[]; minX: number; minY: number; maxX: number; maxY: number }[]>(), size = 250
  for (const polygon of polygons) {
    if (!polygon.length) continue
    const bounds = boundsOf(polygon), indexed = { polygon, minX: bounds.minX - EPS, minY: bounds.minY - EPS, maxX: bounds.maxX + EPS, maxY: bounds.maxY + EPS }
    for (let x = Math.floor(indexed.minX / size); x <= Math.floor(indexed.maxX / size); x++) for (let y = Math.floor(indexed.minY / size); y <= Math.floor(indexed.maxY / size); y++) {
      const key = `${x}:${y}`, list = bins.get(key) ?? []; list.push(indexed); bins.set(key, list)
    }
  }
  return point => (bins.get(`${Math.floor(point.x / size)}:${Math.floor(point.y / size)}`) ?? []).some(face => point.x >= face.minX && point.x <= face.maxX && point.y >= face.minY && point.y <= face.maxY && (pointInPolygon(point, face.polygon) || face.polygon.some((a, i) => distanceToSegment(point, a, face.polygon[(i + 1) % face.polygon.length]!) < EPS)))
}
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const heading = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x)
const angleDifference = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b))
function roundedStreet(points: Point[], reach = 65, fraction = .28): Point[] {
  const result = [points[0]!]
  for (let i = 1; i < points.length - 1; i++) {
    const before = points[i - 1]!, corner = points[i]!, after = points[i + 1]!, setback = Math.min(reach, distance(before, corner) * fraction, distance(corner, after) * fraction)
    const a = lerp(corner, before, setback / distance(corner, before)), b = lerp(corner, after, setback / distance(corner, after))
    result.push(a)
    for (let n = 1, count = Math.max(12, Math.ceil(setback / 3)); n <= count; n++) { const t = n / count; result.push({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * corner.x + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * corner.y + t * t * b.y }) }
  }
  result.push(points.at(-1)!); return result
}
function pointAlong(points: readonly Point[], chainage: number): Point {
  let remaining = Math.max(0, chainage)
  for (let i = 1; i < points.length; i++) { const a = points[i - 1]!, b = points[i]!, length = distance(a, b); if (remaining <= length) return lerp(a, b, remaining / length); remaining -= length }
  return points.at(-1)!
}
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
  if (start < 0 || end < 0 || distance(first, last) < 10) return null
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
    if (from === to) {
      const origin = polygon[from]!, tip = polygon[(from + 1) % polygon.length]!, dx = tip.x - origin.x, dy = tip.y - origin.y
      if ((b.x - a.x) * dx + (b.y - a.y) * dy > 0) return [a, b]
    }
    for (let n = 1; n <= polygon.length; n++) { const index = (from + n) % polygon.length; if (distance(ring.at(-1)!, polygon[index]!) > EPS) ring.push(polygon[index]!); if (index === to) break }
    if (distance(ring.at(-1)!, b) > EPS) ring.push(b)
    return ring
  }
  const children = [[...walk(start, end, first, last), ...points.slice(1, -1).reverse()], [...walk(end, start, last, first), ...points.slice(1, -1)]]
  if (children.some(child => polygonArea(child) < minimumArea) || Math.abs(children.reduce((sum, child) => sum + polygonArea(child), 0) - polygonArea([...polygon])) > Math.max(.02, polygonArea([...polygon]) * 1e-8)) return null
  return children
}


class ContinuousRoadDesign {
  graph = new PlanarRoadGraph()
  readonly planner: RoadPlanner
  readonly regional: RegionalRoadPlanner | null
  readonly diagnostics: ContinuousRoadDiagnostics = { attempted: 0, accepted: 0, rejected: 0, streetLength: 0, boundaryConnections: 0, coarseFaces: 0, blocks: 0, demandSamples: 0, framedDemandSamples: 0, demandCoverage: 0, unservedAccessIds: [], accessAttempts: [], modern: { requested: [], completed: [], unavailable: [] }, bridgeSpans: [], trunkSurveys: [], phaseMilliseconds: {}, sharedExpansion: { anchors: 0, rungs: 0, links: 0, routeFailures: 0, bridgeSurveys: 0 }, largeFaceDetours: { faces: 0, attempted: 0, accepted: 0, parentAreas: [] }, districtStreets: { spines: 0, reorientations: 0, serviceLoops: 0, loopDryArea: 0, uncoveredRestarts: 0 }, normalizationRejectedCuts: 0, partitionRejections: [] }
  readonly environment: PlanningEnvironment
  private serial = 0
  private siteApproaches = new Map<string, SimulatedRoad>()
  private frontageObstacles: { region: PolygonRegion; bounds: ReturnType<typeof boundsOf> }[]
  private surfaceRail: RailwayRoadConstraints
  private railCells = new Map<string, { a: Point; b: Point }[]>()
  readonly input: ContinuousCityRoadInput
  private reserves: { region: ContinuousCityRoadInput['reservedRegions'][number]; bounds: ReturnType<typeof boundsOf> }[]
  constructor(input: ContinuousCityRoadInput, materialized = false) {
    this.input = input
    const reserved = regionQuery(input.reservedRegions), base = input.environment
    // Demand controls development, not engineering path cost. In particular its
    // distance/shoreline sampler must not run inside every road-search edge.
    this.environment = { ...base, exactLandCost: true, landCost: p => reserved(p) ? Infinity : base.landCost?.(p) ?? 0 }
    this.reserves = input.reservedRegions.map(region => ({ region, bounds: boundsOf(region.polygon) }))
    this.frontageObstacles = [...input.reservedRegions, ...base.areas.filter(area => area.kind === 'water')].map(region => ({ region, bounds: boundsOf(region.polygon) }))
    this.surfaceRail = new RailwayRoadConstraints(input.railways)
    for (const railway of input.railways) if (railway.mode !== 'subway') for (let i = 1; i < railway.points.length; i++) {
      const a = railway.points[i - 1]!, b = railway.points[i]!
      for (let x = Math.floor((Math.min(a.x, b.x) - 7) / 100); x <= Math.floor((Math.max(a.x, b.x) + 7) / 100); x++) for (let y = Math.floor((Math.min(a.y, b.y) - 7) / 100); y <= Math.floor((Math.max(a.y, b.y) + 7) / 100); y++) { const key = `${x}:${y}`, list = this.railCells.get(key) ?? []; list.push({ a, b }); this.railCells.set(key, list) }
    }
    this.planner = new RoadPlanner(this.environment)
    this.regional = base.terrain?.continuationTerrain ? new RegionalRoadPlanner(this.environment) : null
    this.planner.setRailwayCorridors(input.railways); this.regional?.setRailwayCorridors(input.railways)
    this.serial = Math.max(0, ...(input.initialRoads ?? []).map(road => Number(/^continuous-road-(\d+)$/.exec(road.id)?.[1] ?? 0)))
    if (materialized) {
      this.graph.roads.push(...(input.initialRoads ?? []).map(road => ({ ...road, points: road.points.map(point => ({ ...point })), builtYear: road.builtYear ?? 1650, role: road.role ?? 'lane', phase: 'continuous-saved-survey', reason: road.reason ?? '記録済みの実測道路', constructionCost: 0 })))
      this.graph = this.graph.fork()
    } else for (const road of input.initialRoads ?? []) {
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
  private accept(route: PlannedRoute | null, width: number, role: RoadRole, year: number, reason: string, outside = false, requireConnection = true, parent?: Point[], serviceGuard?: (points: Point[]) => boolean) {
    this.diagnostics.attempted++
    if (!route) { this.diagnostics.rejected++; return null }
    const points = this.canonical(route, role === 'access')
    if (!points || !this.valid({ ...route, points }, width, role, outside)) { this.diagnostics.rejected++; return null }
    const nextId = this.serial + 1
    const added = this.graph.add(points, { id: `continuous-road-${nextId}`, builtYear: year, role, width, kind: outside && (role === 'highway' || width >= 10) ? 'arterial' : 'local', phase: outside ? 'continuous-regional-trunk' : 'continuous-urban-fabric', reason, constructionCost: route.cost, ...(outside ? { boundaryContinuation: true, throughRouteId: `continuous-trunk-${nextId}` } : {}), ...(route.bridgeLength > 0 ? { bridge: true } : {}), ...(role === 'access' ? { preserveEndpoint: true } : {}) }, requireConnection, candidate => {
      const normalized = candidate.points.map(point => ({ ...point }))
      if (parent && !partitionContinuousCityFace(parent, normalized)) {
        this.diagnostics.normalizationRejectedCuts++
        if (this.diagnostics.partitionRejections.length < 3) this.diagnostics.partitionRejections.push({ reason: candidate.reusedRoadId ? 'reused-road-does-not-partition-parent' : 'normalized-road-does-not-partition-parent', polygon: parent.map(point => ({ ...point })), proposedPath: route.points.map(point => ({ ...point })), canonicalPath: points.map(point => ({ ...point })), normalizedPath: normalized, ...(candidate.reusedRoadId ? { reusedRoadId: candidate.reusedRoadId } : {}) })
        return false
      }
      const unchanged = points.length === normalized.length && points.every((point, i) => distance(point, normalized[i]!) < 1e-10)
      return (!serviceGuard || serviceGuard(normalized)) && (unchanged || this.valid({ ...route, points: normalized }, width, role, outside))
    })
    if (!added) { this.diagnostics.rejected++; return null }
    if (added.id === `continuous-road-${nextId}`) this.serial = nextId
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
      for (const width of [11, 9]) {
        const route = this.regional.plan(portal, anchor.point, { role: 'collector', width, allowBridge: true, maximumGrade: .13, maxNodes: 3200 })
        this.diagnostics.trunkSurveys.push({ stage: 'regional-branch', milliseconds: performance.now() - started, from: portal, to: anchor.point, found: !!route })
        if (this.accept(route, width, 'collector', 1650, '異なる区域外方向と都心を結ぶ地域幹線', true, false)) break
      }
    }
  }
  /** Each short connection is independent. A wet failed link cannot veto all
   * the other dry district boundaries in a many-kilometre enclosing loop. */
  private sharedCollector(from: Point, to: Point, year: number, reason: string, width = 6.6) {
    const role = 'collector' as const, direct = this.planner.cost([from, to], role)
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
  /** A sparse collector frontier supplies the dry hinterland of real regional
   * streets. Closed faces are an observation, never a reason to draw a loop. */
  private growCollectors(samples: Point[]) {
    type Segment = { road: SimulatedRoad; a: Point; b: Point }
    type Cell = { point: Point; target: number; distance: number; dryDistance: number; served: boolean; attempts: number; totalAttempts: number; revivals: number; version: number }
    const segments: Segment[] = [], segmentBins = new Map<string, Segment[]>(), indexed = new Set<string>(), cells: Cell[] = [], cellBins = new Map<string, number[]>(), queue = new MinHeap<{ index: number; version: number }>()
    const addRoad = (road: SimulatedRoad) => {
      if (indexed.has(road.id) || road.width < 6.5 || road.controlledAccess || (road.level ?? 0) !== 0) return false
      indexed.add(road.id)
      for (let i = 1; i < road.points.length; i++) {
        const segment = { road, a: road.points[i - 1]!, b: road.points[i]! }; segments.push(segment)
        for (let x = Math.floor(Math.min(segment.a.x, segment.b.x) / 250); x <= Math.floor(Math.max(segment.a.x, segment.b.x) / 250); x++) for (let y = Math.floor(Math.min(segment.a.y, segment.b.y) / 250); y <= Math.floor(Math.max(segment.a.y, segment.b.y) / 250); y++) { const key = `${x}:${y}`, list = segmentBins.get(key) ?? []; list.push(segment); segmentBins.set(key, list) }
      }
      return true
    }
    for (const road of this.graph.roads) addRoad(road)
    const anchors = (point: Point) => {
      let selected: { point: Point; road: SimulatedRoad; distance: number; clear: boolean }[] = []
      for (const radius of [550, 1600, Infinity]) {
        const nearby = new Set<Segment>()
        if (Number.isFinite(radius)) for (let x = Math.floor((point.x - radius) / 250); x <= Math.floor((point.x + radius) / 250); x++) for (let y = Math.floor((point.y - radius) / 250); y <= Math.floor((point.y + radius) / 250); y++) for (const segment of segmentBins.get(`${x}:${y}`) ?? []) nearby.add(segment)
        else for (const segment of segments) nearby.add(segment)
        const hits = [...nearby].map(segment => { const contact = projectOnRoadSegment(point, segment.a, segment.b).point; return { point: contact, road: segment.road, distance: distance(point, contact) } }).sort((a, b) => a.distance - b.distance)
        selected = []
        for (const hit of hits) { if (hit.distance > radius || selected.some(other => distance(other.point, hit.point) < 90)) continue; selected.push({ ...hit, clear: this.dryAccessClear(point, hit.point) }); if (selected.length === 12) break }
        if (selected.some(hit => hit.clear) || !Number.isFinite(radius)) break
      }
      return selected.sort((a, b) => a.distance * (a.clear ? 1 : 2.5) - b.distance * (b.clear ? 1 : 2.5))
    }
    const enqueue = (index: number) => { const cell = cells[index]!; if (!cell.served && cell.attempts < 2 && cell.totalAttempts < 6) queue.push({ index, version: cell.version }, cell.distance) }
    for (const point of samples) {
      const hits = anchors(point), target = 420 + (1 - this.input.demand.at(point)) * 80, near = hits[0], index = cells.length
      const dryDistance = Math.min(...hits.filter(hit => hit.clear).map(hit => hit.distance))
      cells.push({ point, target, distance: Number.isFinite(dryDistance) ? dryDistance : near?.distance ?? Infinity, dryDistance, served: dryDistance <= target, attempts: 0, totalAttempts: 0, revivals: 0, version: 0 })
      const key = `${Math.floor(point.x / 250)}:${Math.floor(point.y / 250)}`, list = cellBins.get(key) ?? []; list.push(index); cellBins.set(key, list); enqueue(index)
    }
    const metrics = { samples: cells.length, servedBefore: cells.filter(cell => cell.served).length, servedAfter: 0, attempted: 0, streets: 0, maximumDryDistance: 0 }
    const nearbyCells = (points: Point[], radius: number) => {
      const found = new Set<number>()
      for (let i = 1; i < points.length; i++) { const a = points[i - 1]!, b = points[i]!; for (let x = Math.floor((Math.min(a.x, b.x) - radius) / 250); x <= Math.floor((Math.max(a.x, b.x) + radius) / 250); x++) for (let y = Math.floor((Math.min(a.y, b.y) - radius) / 250); y <= Math.floor((Math.max(a.y, b.y) + radius) / 250); y++) for (const index of cellBins.get(`${x}:${y}`) ?? []) found.add(index) }
      return [...found]
    }
    while (queue.size) {
      const item = queue.pop()!.value, cell = cells[item.index]!
      if (cell.served || item.version !== cell.version || cell.attempts >= 2 || cell.totalAttempts >= 6) continue
      cell.attempts++; cell.totalAttempts++; metrics.attempted++
      const cluster = nearbyCells([cell.point, { x: cell.point.x + 1, y: cell.point.y }], 320).map(index => cells[index]!).filter(other => !other.served && distance(other.point, cell.point) < 320), goal = cluster.length ? cluster.reduce((sum, other) => ({ x: sum.x + other.point.x / cluster.length, y: sum.y + other.point.y / cluster.length }), { x: 0, y: 0 }) : cell.point
      const desired = this.planner.suitable(goal, 6.6) && this.input.demand.at(goal) > 0 ? goal : cell.point
      let accepted = false
      for (const anchor of anchors(desired).slice(0, 3)) {
        const direction = heading(anchor.point, desired), reach = Math.min(650, Math.max(350, anchor.distance))
        for (const fraction of [1, .75, .5]) {
          const end = { x: anchor.point.x + Math.cos(direction) * reach * fraction, y: anchor.point.y + Math.sin(direction) * reach * fraction }
          if (!this.planner.suitable(end, 6.6) || this.input.demand.at(end) <= 0) continue
          const year = Math.max(anchor.road.builtYear, this.input.demand.openingAt(end)), road = this.sharedCollector(anchor.point, end, year, '幹線から乾地の集散路到達不足へ伸びる地区道路')
          if (!road || !addRoad(road)) continue
          metrics.streets++; this.diagnostics.districtStreets.uncoveredRestarts++; accepted = true
          for (const index of nearbyCells(road.points, 700)) {
            const other = cells[index]!
            if (other.served) continue
            let depth = Infinity, contact = road.points[0]!
            for (let i = 1; i < road.points.length; i++) { const projected = projectOnRoadSegment(other.point, road.points[i - 1]!, road.points[i]!).point, d = distance(other.point, projected); if (d < depth) { depth = d; contact = projected } }
            const clear = depth <= 700 && this.dryAccessClear(other.point, contact), improved = depth + 50 < other.distance || clear && depth + 50 < other.dryDistance
            if (clear && depth < other.dryDistance) other.dryDistance = depth
            if (depth <= other.target && clear) { other.served = true; other.distance = depth; continue }
            if (improved) {
              if (other.attempts >= 2 && other.revivals < 2 && other.totalAttempts < 6) { other.attempts = 0; other.revivals++ }
              other.distance = Math.min(other.distance, depth); other.version++; enqueue(index)
            }
          }
          break
        }
        if (accepted) break
      }
      if (!cell.served && cell.attempts < 2 && cell.totalAttempts < 6) { cell.version++; enqueue(item.index) }
    }
    metrics.servedAfter = cells.filter(cell => cell.served).length
    for (const cell of cells) if (cell.served) metrics.maximumDryDistance = Math.max(metrics.maximumDryDistance, cell.dryDistance)
    this.diagnostics.collectorReachability = metrics
  }
  private gate(target: ContinuousCityAccessTarget) {
    const candidates = this.publicProjections(target.point, target.builtYear, 24)
    if (candidates.some(hit => hit.distance < EPS)) { this.graph.ensureJunction(target.point); return true }
    const sectors = new Set<number>(), selected: RoadProjection[] = []
    for (const candidate of candidates) { const sector = Math.floor((heading(target.point, candidate.point) + Math.PI) / (Math.PI / 4)); if (sectors.has(sector)) continue; sectors.add(sector); selected.push(candidate); if (selected.length === 4) break }
    for (const mouth of [false, true]) {
      if (mouth && target.endHeading === undefined) continue
      for (const anchor of selected) {
        const route = this.planner.plan(anchor.point, target.point, { role: 'access', width: 6.5, allowBridge: true, alignment: 'planned', maximumGrade: .13, maxNodes: 1800, ...(mouth ? { endHeading: target.endHeading } : {}) })
        this.diagnostics.accessAttempts.push({ id: target.id, from: anchor.point, ...(mouth ? { endHeading: target.endHeading } : {}), found: !!route })
        const added = this.accept(route, 5, 'access', target.builtYear, '取得済みの施設・駅入口と同時代の公道を結ぶ道路')
        if (added) { this.siteApproaches.set(target.id, added); return true }
      }
    }
    return false
  }
  private secondaryStreets() {
    const stations = [...this.siteApproaches].filter(([id, road]) => id.startsWith('station') && roadLength(road.points) > 170).map(([id, road]) => ({ id, point: pointAlong(road.points, roadLength(road.points) - 100), year: road.builtYear })).sort((a, b) => a.point.x - b.point.x)
    for (let i = 1; i < stations.length; i++) { const a = stations[i - 1]!, b = stations[i]!; if (distance(a.point, b.point) <= 3500) this.sharedCollector(a.point, b.point, Math.max(a.year, b.year), '取得済みの駅前市街地どうしを結ぶ二次幹線', 10.2) }
    const port = [...this.siteApproaches].find(([id, road]) => id.includes('port') && roadLength(road.points) > 170)
    if (port && stations.length) {
      const road = port[1], point = pointAlong(road.points, roadLength(road.points) - 100), station = [...stations].sort((a, b) => distance(a.point, point) - distance(b.point, point))[0]!
      this.sharedCollector(station.point, point, Math.max(road.builtYear, station.year), '実在する港の接道と駅前を結ぶ二次幹線', 10.2)
    }
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
  private dryComponents(polygon: Point[]): PolygonRegion[] {
    const bounds = boundsOf(polygon), excluded: PolygonRegion[] = [...this.input.reservedRegions, ...this.environment.areas.filter(area => area.kind === 'water')]
    for (const railway of this.input.railways) if (railway.mode !== 'subway') for (let i = 1; i < railway.points.length; i++) excluded.push({ polygon: corridorPolygon(railway.points[i - 1]!, railway.points[i]!, 7) })
    return subtractRegions({ polygon }, excluded.filter(region => overlaps(bounds, boundsOf(region.polygon)))).filter(region => regionArea(region) > 6000)
  }
  /** Water, running tracks and acquired grounds are holes, not streets. Each
   * dry component returns to two ACTUAL public perimeter contacts on its own
   * side. It need not make an impossible full-width river/railway chord. */
  private componentService(polygon: Point[], opening: number): Point[][] | null {
    const components = this.dryComponents(polygon).sort((a, b) => regionArea(b) - regionArea(a)), width = 6, role = 'lane' as const
    for (const component of components) {
      if (regionArea(component) < 18000) continue
      const contacts: { point: Point; normal: Point; year: number; run: number }[] = []
      let run = 0, lastAngle: number | undefined
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, length = distance(a, b), count = Math.max(1, Math.ceil(length / 55)), angle = heading(a, b)
        if (lastAngle !== undefined && Math.abs(angleDifference(angle, lastAngle)) > .12) run++
        lastAngle = angle
        for (let n = 0; n < count; n++) {
          const point = lerp(a, b, (n + .5) / count)
          if (contacts.some(contact => distance(contact.point, point) < 45)) continue
          const road = this.graph.nearest(point, EPS)?.road
          if (!road || road.controlledAccess || road.width < 4.6 || !this.planner.suitable(point, width)) continue
          const normal = [-1, 1].map(side => ({ x: -Math.sin(angle) * side, y: Math.cos(angle) * side })).find(normal => pointInRegion({ x: point.x + normal.x * 22, y: point.y + normal.y * 22 }, component))
          if (normal) contacts.push({ point, normal, year: road.builtYear, run })
        }
      }
      const ranked = contacts.flatMap((a, i) => contacts.slice(i + 1).flatMap(b => { const length = distance(a.point, b.point); return a.run === b.run && length >= 90 && length <= 850 && a.normal.x * b.normal.x + a.normal.y * b.normal.y > .8 ? [{ a, b, length }] : [] })).sort((a, b) => b.length - a.length), pairs: typeof ranked = []
      for (const pair of ranked) { if (pairs.some(other => other.a.run === pair.a.run)) continue; pairs.push(pair); if (pairs.length >= 10) break }
      const reach = (contact: typeof contacts[number]) => { let depth = 0; for (let step = 20; step <= 420; step += 20) { if (!pointInRegion({ x: contact.point.x + contact.normal.x * step, y: contact.point.y + contact.normal.y * step }, component)) break; depth = step } return Math.max(0, depth - 12) }
      for (const { a, b } of pairs) for (const depth of [Math.min(reach(a), reach(b)) * .82, Math.min(reach(a), reach(b)) * .55, Math.min(reach(a), reach(b)) * .32, 90]) {
        if (depth < 55) continue
        const corners = [a.point, { x: a.point.x + a.normal.x * depth, y: a.point.y + a.normal.y * depth }, { x: b.point.x + b.normal.x * depth, y: b.point.y + b.normal.y * depth }, b.point]
        if (corners.slice(1, -1).some(point => !pointInRegion(point, component))) continue
        const path = roundedStreet(corners, 90), canonical = this.canonical(this.planner.cost(path, role)), children = canonical && partitionContinuousCityFace(polygon, canonical)
        if (!canonical || !children) continue
        const enclosed = [...children].sort((a, b) => polygonArea(a) - polygonArea(b))[0]!, dryGain = intersectRegions({ polygon: enclosed }, component).reduce((sum, region) => sum + regionArea(region), 0)
        if (dryGain < 10000) continue
        const route = this.planner.cost(canonical, role)
        if (!this.valid(route, width, role)) continue
        const road = this.accept(route, width, role, Math.max(opening, a.year, b.year), '障害物で分かれた同じ乾地側の実公道へ戻る地区サービス街路', false, true, polygon)
        if (!road) continue
        const actual = partitionContinuousCityFace(polygon, road.points)
        if (!actual) throw new Error('Accepted dry-component street did not partition the actual parent')
        this.diagnostics.districtStreets.serviceLoops++; this.diagnostics.districtStreets.loopDryArea += dryGain
        return actual
      }
      if (regionArea(component) < 40000 || !pairs.length) continue
      const bounds = boundsOf(component.polygon), candidates: Point[] = [], step = Math.max(40, Math.sqrt(regionArea(component) / 160))
      const rings = [component.polygon, ...(component.holes ?? [])]
      for (let y = bounds.minY + step / 2; y < bounds.maxY; y += step) for (let x = bounds.minX + step / 2; x < bounds.maxX; x += step) { const point = { x, y }; if (pointInRegion(point, component) && this.planner.suitable(point, width) && rings.every(ring => ring.every((a, i) => distanceToSegment(point, a, ring[(i + 1) % ring.length]!) >= 45))) candidates.push(point) }
      const contains = (point: Point) => pointInRegion(point, component) || component.polygon.some((a, i) => distanceToSegment(point, a, component.polygon[(i + 1) % component.polygon.length]!) <= EPS)
      const planner = new RoadPlanner({ ...this.environment, exactLandCost: true, landCost: point => contains(point) || this.graph.nearest(point, width / 2 + 1) ? this.environment.landCost?.(point) ?? 0 : Infinity })
      planner.setRailwayCorridors(this.input.railways); planner.setRailwayRoadNetwork(this.graph.roads)
      const cornerPairs = contacts.flatMap((a, i) => contacts.slice(i + 1).flatMap(b => { const dot = a.normal.x * b.normal.x + a.normal.y * b.normal.y, length = distance(a.point, b.point); return a.run !== b.run && dot > -.15 && dot < .65 && length > 180 && length < 950 ? [{ a, b, length }] : [] })).sort((a, b) => b.length - a.length)
      const plannedPairs = [...cornerPairs.slice(0, 2), ...pairs.slice(0, 2)]
      for (const { a, b } of plannedPairs) {
        const middle = lerp(a.point, b.point, .5), target = [...candidates].filter(point => distance(point, middle) > 100 && distance(point, middle) < 650).sort((p, q) => distance(q, middle) - distance(p, middle))[0]
        if (!target) continue
        const bend = this.canonical(this.planner.cost(roundedStreet([a.point, target, b.point], 90), role)), bentChildren = bend && partitionContinuousCityFace(polygon, bend)
        if (bend && bentChildren && bend.every(contains)) {
          const enclosed = [...bentChildren].sort((a, b) => polygonArea(a) - polygonArea(b))[0]!, dryGain = intersectRegions({ polygon: enclosed }, component).reduce((sum, region) => sum + regionArea(region), 0), route = this.planner.cost(bend, role)
          if (dryGain >= 10000 && this.valid(route, width, role)) {
            const road = this.accept(route, width, role, Math.max(opening, a.year, b.year), '乾地成分の別frontageを内側の折れた街路で結ぶ地区接続', false, true, polygon)
            const actual = road && partitionContinuousCityFace(polygon, road.points)
            if (road && !actual) throw new Error('Committed bent component street lost its physical partition', { cause: { polygon, proposedPath: route.points, acceptedPath: road.points, diagnostics: this.diagnostics } })
            if (actual) { this.diagnostics.districtStreets.serviceLoops++; this.diagnostics.districtStreets.loopDryArea += dryGain; return actual }
          }
        }
        const incoming = heading(a.point, target), outgoing = heading(target, b.point), tangent = incoming + angleDifference(outgoing, incoming) / 2
        for (const delta of [0, -Math.PI / 6, Math.PI / 6]) {
          const shared = tangent + delta, first = planner.plan(a.point, target, { role, width, allowBridge: false, alignment: 'planned', endHeading: shared, maximumGrade: .13, maxNodes: 350 })
          if (!first) continue
          const last = planner.plan(target, b.point, { role, width, allowBridge: false, alignment: 'planned', startHeading: shared, maximumGrade: .13, maxNodes: 350 })
          if (!last) continue
          const route = this.planner.cost([...first.points, ...last.points.slice(1)], role), canonical = this.canonical(route), children = canonical && partitionContinuousCityFace(polygon, canonical)
          if (!canonical || !children || canonical.some(point => !contains(point))) continue
          const enclosed = [...children].sort((a, b) => polygonArea(a) - polygonArea(b))[0]!, dryGain = intersectRegions({ polygon: enclosed }, component).reduce((sum, region) => sum + regionArea(region), 0)
          if (dryGain < 10000 || !this.valid({ ...route, points: canonical }, width, role)) continue
          const road = this.accept({ ...route, points: canonical }, width, role, Math.max(opening, a.year, b.year), '穴を持つ同一乾地成分内を測量して実perimeterへ戻るサービス街路', false, true, polygon)
          if (!road) continue
          const actual = partitionContinuousCityFace(polygon, road.points)
          if (!actual) throw new Error('Accepted component return route lost its physical partition')
          this.diagnostics.districtStreets.serviceLoops++; this.diagnostics.districtStreets.loopDryArea += dryGain
          return actual
        }
      }
    }
    return null
  }
  private dryAccessClear(a: Point, b: Point) {
    if (distance(a, b) < .1) return true
    if (this.surfaceRail.crossings([a, b]).length) return false
    const strip = corridorPolygon(a, b, 1.25), bounds = boundsOf(strip)
    return !this.frontageObstacles.some(item => overlaps(bounds, item.bounds) && polygonOverlapsRegion(strip, item.region))
  }
  /** Streets grow from acquired public frontages toward actual access deficits.
   * The field chooses a project, never supplies a painted grid/gradient line.
   * Every accepted street supplies new dry cells; only its neighbours update. */
  private growLocalNetwork() {
    type Cell = { point: Point; intensity: number; target: number; distance: number; dryAnchor: number; served: boolean; attempts: number; totalAttempts: number; revivals: number; version: number }
    // 64m probes alias an entire 60–100m back garden between streets. At 32m
    // spacing a dense plot's 18–25m usable depth can influence a new project.
    const cellSize = 32, cells: Cell[] = [], bins = new Map<string, number[]>(), { width, height } = this.environment, queue = new MinHeap<{ index: number; version: number }>()
    const publicRoad = (road: Road) => road.width >= 4.6 && !road.controlledAccess && (road.level ?? 0) === 0 && road.role !== 'farm'
    const onRail = (point: Point) => (this.railCells.get(`${Math.floor(point.x / 100)}:${Math.floor(point.y / 100)}`) ?? []).some(segment => distanceToSegment(point, segment.a, segment.b) < 7)
    const usable = (point: Point) => this.input.demand.at(point) > 0 && !this.planner.waterAt(point) && !onRail(point) && Number.isFinite(this.environment.landCost?.(point) ?? 0) && (this.environment.terrain?.slope(point) ?? 0) <= .13
    const priority = (cell: Cell) => {
      const site = (this.input.accessTargets ?? []).some(site => site.builtYear <= this.input.demand.openingAt(cell.point) && distance(site.point, cell.point) < 700)
      const depth = Number.isFinite(cell.dryAnchor) ? cell.dryAnchor : cell.distance
      return -(Math.min(250, depth) / cell.target * (1 + cell.intensity * 1.5 + (site ? .8 : 0)) / (.7 + depth / 130))
    }
    const enqueue = (index: number) => { const cell = cells[index]!; if (!cell.served && cell.attempts < 3 && cell.totalAttempts < 9 && cell.distance <= 240) queue.push({ index, version: cell.version }, priority(cell)) }
    for (let y = cellSize / 2; y < height; y += cellSize) for (let x = cellSize / 2; x < width; x += cellSize) {
      const point = { x, y }
      if (!usable(point)) continue
      const intensity = this.input.demand.at(point), target = 20 + (1 - intensity) * 12
      let near = this.graph.nearest(point)
      if (near && !publicRoad(near.road)) near = this.graph.projections(point, 240, 12).find(hit => publicRoad(hit.road)) ?? null
      const depth = near?.distance ?? Infinity, clear = !!near && this.dryAccessClear(point, near.point), served = clear && depth <= target, index = cells.length
      cells.push({ point, intensity, target, distance: depth, dryAnchor: clear ? depth : Infinity, served, attempts: 0, totalAttempts: 0, revivals: 0, version: 0 })
      const key = `${Math.floor(x / 100)}:${Math.floor(y / 100)}`, list = bins.get(key) ?? []; list.push(index); bins.set(key, list)
      enqueue(index)
    }
    const metrics = { cellSize, dryCells: cells.length, servedBefore: cells.filter(cell => cell.served).length, servedAfter: 0, attempted: 0, streets: 0, connectedEnds: 0, deadEnds: 0, revivedCells: 0, gainedAreaEstimate: 0, unservedAreaEstimate: 0 }
    const nearby = (points: Point[], radius: number) => {
      const found = new Set<number>()
      for (let i = 1; i < points.length; i++) { const a = points[i - 1]!, b = points[i]!; for (let x = Math.floor((Math.min(a.x, b.x) - radius) / 100); x <= Math.floor((Math.max(a.x, b.x) + radius) / 100); x++) for (let y = Math.floor((Math.min(a.y, b.y) - radius) / 100); y <= Math.floor((Math.max(a.y, b.y) + radius) / 100); y++) for (const index of bins.get(`${x}:${y}`) ?? []) found.add(index) }
      return [...found]
    }
    const projection = (point: Point, points: Point[]) => { let answer = points[0]!, depth = Infinity; for (let i = 1; i < points.length; i++) { const candidate = projectOnRoadSegment(point, points[i - 1]!, points[i]!).point, d = distance(point, candidate); if (d < depth) { answer = candidate; depth = d } } return { point: answer, depth } }
    const gains = (points: Point[]) => nearby(points, 60).filter(index => { const cell = cells[index]!; if (cell.served) return false; const contact = projection(cell.point, points); return contact.depth <= cell.target && this.dryAccessClear(cell.point, contact.point) })
    const update = (points: Point[]) => {
      for (const index of nearby(points, 240)) {
        const cell = cells[index]!
        if (cell.served) continue
        const contact = projection(cell.point, points)
        const clear = contact.depth <= 240 && this.dryAccessClear(cell.point, contact.point), meaningful = contact.depth + 20 < cell.distance || clear && contact.depth + 20 < cell.dryAnchor
        if (meaningful && cell.attempts >= 3 && cell.revivals < 2 && cell.totalAttempts < 9) { cell.attempts = 0; cell.revivals++; metrics.revivedCells++; cell.version++ }
        if (clear && contact.depth < cell.dryAnchor) cell.dryAnchor = contact.depth
        if (contact.depth < cell.distance) { cell.distance = contact.depth; cell.version++ }
        if (contact.depth <= cell.target && clear) { cell.served = true; continue }
        enqueue(index)
      }
    }
    while (queue.size) {
      const item = queue.pop()!.value, cell = cells[item.index]!
      if (cell.served || cell.version !== item.version || cell.attempts >= 3 || cell.totalAttempts >= 9) continue
      cell.attempts++; cell.totalAttempts++; metrics.attempted++
      const neighbours = nearby([{ x: cell.point.x - 1, y: cell.point.y }, { x: cell.point.x + 1, y: cell.point.y }], 75).map(index => cells[index]!).filter(other => !other.served && distance(other.point, cell.point) < 75)
      const weight = neighbours.reduce((sum, other) => sum + 1 + other.intensity, 0), centroid = weight ? neighbours.reduce((sum, other) => ({ x: sum.x + other.point.x * (1 + other.intensity) / weight, y: sum.y + other.point.y * (1 + other.intensity) / weight }), { x: 0, y: 0 }) : cell.point, blended = lerp(cell.point, centroid, .3), goal = usable(blended) ? blended : cell.point
      const anchors = this.graph.projections(goal, 240, 12).filter(anchor => publicRoad(anchor.road))
      const options = anchors.flatMap(anchor => [anchor, ...[anchor.road.points[0]!, anchor.road.points.at(-1)!].filter(point => distance(point, goal) < 210 && distance(point, anchor.point) > 10).map(point => ({ ...anchor, point, distance: distance(point, goal) }))]).sort((a, b) => a.distance * (this.dryAccessClear(goal, a.point) ? 1 : 2.5) - b.distance * (this.dryAccessClear(goal, b.point) ? 1 : 2.5))
      const selected: typeof options = []
      for (const anchor of options) { if (selected.some(other => distance(other.point, anchor.point) < 35)) continue; selected.push(anchor); if (selected.length >= 3) break }
      let accepted = false
      for (const anchor of selected) {
        const direction = heading(anchor.point, goal), travel = Math.min(160, Math.max(50, anchor.distance + 10)), raw = { x: anchor.point.x + Math.cos(direction) * travel, y: anchor.point.y + Math.sin(direction) * travel }, end = usable(raw) ? raw : goal
        if (distance(anchor.point, end) < 20 || distance(anchor.point, end) > 180) continue
        const advancesTarget = (points: Point[]) => { const hit = projection(cell.point, points); return this.dryAccessClear(cell.point, hit.point) && (hit.depth <= cell.target || hit.depth + 25 < distance(cell.point, anchor.point)) }
        let contact = this.graph.projections(end, 80, 12).find(other => publicRoad(other.road) && distance(other.point, anchor.point) >= 60 && distance(other.point, anchor.point) <= 180 && (other.road !== anchor.road || distance(other.point, anchor.point) > 100)), target = contact?.point ?? end
        const startHeading = this.graph.junctionHeading(anchor.point, target)
        if (startHeading === null) continue
        const width = 4.8, role = 'lane' as const
        let route: PlannedRoute | null = this.planner.cost([anchor.point, target], role)
        const directPhysical = this.valid(route, width, role)
        if (Math.abs(angleDifference(heading(anchor.point, target), startHeading)) > .35) {
          const straightEnd = { x: anchor.point.x + Math.cos(startHeading) * travel, y: anchor.point.y + Math.sin(startHeading) * travel }, straightContact = this.graph.projections(straightEnd, 55, 8).find(other => publicRoad(other.road) && distance(other.point, anchor.point) >= 60 && Math.abs(angleDifference(heading(anchor.point, other.point), startHeading)) < .35), straightTarget = straightContact?.point ?? straightEnd, straight = this.planner.cost([anchor.point, straightTarget], role)
          if (usable(straightTarget) && this.valid(straight, width, role) && advancesTarget(straight.points) && gains(straight.points).length) { route = straight; target = straightTarget; contact = straightContact }
          else {
            if (Math.abs(angleDifference(heading(anchor.point, target), startHeading)) > Math.PI * .6) continue
            const lead = Math.min(60, distance(anchor.point, target) * .5), corner = { x: anchor.point.x + Math.cos(startHeading) * lead, y: anchor.point.y + Math.sin(startHeading) * lead }, elbow = this.planner.cost(roundedStreet([anchor.point, corner, target], 40, .45), role)
            route = this.valid(elbow, width, role) ? elbow : !directPhysical ? this.planner.plan(anchor.point, target, { role, width, startHeading, allowBridge: false, alignment: 'planned', maximumGrade: .13, maxNodes: 300 }) : null
          }
        } else if (!directPhysical) {
          route = this.planner.plan(anchor.point, target, { role, width, startHeading, allowBridge: false, alignment: 'planned', maximumGrade: .13, maxNodes: 300 })
        }
        if (!route || route.length > 180 || !advancesTarget(route.points) || !gains(route.points).length) continue
        let actualGain: number[] = []
        const year = Math.max(anchor.road.builtYear, contact?.road.builtYear ?? 0, this.input.demand.openingAt(goal))
        const road = this.accept(route, width, role, year, contact ? '実公道の不足する接道奥行を短いT字接続で補う生活街路' : '未接道の乾地需要へ実frontageから伸びる短い生活街路', false, true, undefined, points => { actualGain = gains(points); return advancesTarget(points) && actualGain.length * cellSize * cellSize >= Math.max(cellSize * cellSize * .75, roadLength(points) * 12) })
        if (!road) continue
        metrics.streets++; if (contact) metrics.connectedEnds++; else metrics.deadEnds++
        metrics.gainedAreaEstimate += actualGain.length * cellSize * cellSize; update(road.points); accepted = true; break
      }
      if (!accepted && cell.attempts < 3 && cell.totalAttempts < 9) { cell.version++; enqueue(item.index) }
    }
    metrics.servedAfter = cells.filter(cell => cell.served).length; metrics.unservedAreaEstimate = (metrics.dryCells - metrics.servedAfter) * cellSize * cellSize
    this.diagnostics.localNetwork = metrics
  }
  build(localOnly = false) {
    if (!localOnly && !this.graph.roads.some(road => road.width >= 8)) this.trunks()
    let started = performance.now()
    if (!localOnly) { for (const target of this.input.accessTargets ?? []) if (!this.gate(target)) this.diagnostics.unservedAccessIds.push(target.id); this.secondaryStreets() }
    this.diagnostics.phaseMilliseconds.openingAccess = performance.now() - started
    const samples = this.fieldSamples()
    started = performance.now()
    if (!localOnly) { this.input.onProgress?.('広域幹線から乾地の集散路到達不足へ地区道を延伸中…'); this.growCollectors(samples); this.modern() }
    this.diagnostics.phaseMilliseconds.frame = performance.now() - started
    const coarse = extractStreetBlocks(this.graph.roads)
    this.diagnostics.coarseFaces = coarse.length; this.diagnostics.demandSamples = samples.length
    this.diagnostics.framedDemandSamples = samples.filter(continuousCityFaceCoverageQuery(coarse)).length
    this.diagnostics.demandCoverage = samples.length ? this.diagnostics.framedDemandSamples / samples.length : 0
    this.diagnostics.coarseDemandCoverage = this.diagnostics.demandCoverage
    // A few actual dry-component return streets supply large enclosed voids;
    // no child-face queue follows them and their shape is never a tiling rule.
    for (const polygon of coarse) if (polygonArea(polygon) > 250000 && samples.some(point => pointInPolygon(point, polygon) && !this.graph.nearest(point, 180))) this.componentService(polygon, this.input.demand.openingAt(centerOf(polygon)))
    this.input.onProgress?.('実frontageから未接道の乾地へ短い生活街路を一本ずつ測量中…')
    started = performance.now(); this.growLocalNetwork(); this.diagnostics.phaseMilliseconds.localNetwork = performance.now() - started
    const retry = new Set(this.diagnostics.unservedAccessIds); this.diagnostics.unservedAccessIds = []
    for (const target of this.input.accessTargets ?? []) if (retry.has(target.id) && !this.gate(target)) this.diagnostics.unservedAccessIds.push(target.id)
    return this.result()
  }
  result() {
    const sides = new Set<string>(), { width, height } = this.environment
    for (const road of this.graph.roads) if (road.boundaryContinuation) for (const point of [road.points[0]!, road.points.at(-1)!]) { if (point.x < 0) sides.add('west'); if (point.x > width) sides.add('east'); if (point.y < 0) sides.add('north'); if (point.y > height) sides.add('south') }
    this.diagnostics.boundaryConnections = sides.size
    // Physical traffic islands are still faces. Land decides separately if a
    // domain has enough buildable area/frontage to support a private parcel.
    const blocks: ContinuousCityBlock[] = extractStreetBlocks(this.graph.roads, .001).map((polygon, i) => ({ id: `continuous-block-${i}`, polygon }))
    this.diagnostics.blocks = blocks.length
    // Local T connections can close additional ownership domains. Report the
    // final materialized network separately from the pre-local coarse frame.
    const samples = this.fieldSamples()
    this.diagnostics.demandSamples = samples.length
    this.diagnostics.framedDemandSamples = samples.filter(continuousCityFaceCoverageQuery(blocks.map(block => block.polygon))).length
    this.diagnostics.demandCoverage = samples.length ? this.diagnostics.framedDemandSamples / samples.length : 0
    return { roads: this.graph.roads as CityRoad[], blocks, diagnostics: this.diagnostics }
  }
}

export function surveyContinuousCityTrunks(input: ContinuousCityRoadInput) { const design = new ContinuousRoadDesign({ ...input, initialRoads: [] }); design.trunks(); const { roads, diagnostics } = design.result(); return { roads, diagnostics } }
export function buildContinuousCityRoads(input: ContinuousCityRoadInput) { return new ContinuousRoadDesign(input).build() }
/** Local survey over already materialized roads from this generation. Also
 * allows a recorded failed face to be reproduced without rerunning terrain,
 * external main-road search, railway acquisition or the rest of the city. */
export function subdivideContinuousCityRoads(input: ContinuousCityRoadInput) { return new ContinuousRoadDesign(input, true).build(true) }
