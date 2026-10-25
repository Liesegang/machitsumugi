import type { Point, Railway, Road } from './types'
import type { PolygonRegion } from './geometry'
import { corridorPolygon, distance, pointInRegion, polygonOverlapsRegion, seededRandom } from './geometry'
import type { LayoutFirstZone } from './layout-first-types'
import { PlanarRoadGraph, extractStreetBlocks, projectOnRoadSegment, roadLength } from './road-graph'
import type { RoadProjection, RoadRole, SimulatedRoad } from './road-graph'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute, PlanningEnvironment } from './road-planner'
import { RegionalRoadPlanner } from './regional-road-planner'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'
import { RailwayRoadConstraints } from './railway-road-constraints'
import { alignmentDiagnostics, tangentAlignment } from './road-alignment'

export interface LayoutAccessTarget { id: string; point: Point; builtYear: number }
export interface LayoutRoadDiagnostics {
  attempted: number; accepted: number; rejected: number; boundaryConnections: number
  bridges: number; streetLength: number; unservedZoneIds: string[]; unservedAccessIds: string[]
  selectedCenter?: Point
  boundaryAttempts?: { start: Point; portal: Point; route: boolean; finiteCost: boolean; reservations: boolean; railWidth: boolean; cost?: number; length?: number; milliseconds?: number }[]
  accessAttempts?: { id: string; start: Point; target: Point; route: boolean; reservations: boolean; railWidth: boolean }[]
}
export interface LayoutRoadInput {
  environment: PlanningEnvironment; seed: string; center: Point
  settlement?: 'village' | 'rural-town' | 'regional-city' | 'metropolis'
  density?: number; arterial?: boolean; zones?: LayoutFirstZone[]; railways?: Railway[]
  reservedRegions?: PolygonRegion[]; accessTargets?: LayoutAccessTarget[]; signal?: AbortSignal
}
export interface LayoutRoadResult {
  roads: SimulatedRoad[]; graph: PlanarRoadGraph; blocks: Point[][]
  center: Point; zones: LayoutFirstZone[]; diagnostics: LayoutRoadDiagnostics
  bridgeSpans: { roadId: string; bankA: Point; bankB: Point }[]
}

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const heading = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x)
const regionBounds = (region: PolygonRegion) => ({ minX: Math.min(...region.polygon.map(p => p.x)), maxX: Math.max(...region.polygon.map(p => p.x)), minY: Math.min(...region.polygon.map(p => p.y)), maxY: Math.max(...region.polygon.map(p => p.y)) })

/** A spatial road design, independent of population, capital and yearly growth.
 * Only accepted, full-width surveyed pavement is returned. District frames are
 * local land-readjustment briefs, never the underlying terrain sampling grid. */
export function buildLayoutFirstRoads(input: LayoutRoadInput): LayoutRoadResult {
  const { environment, signal } = input, { width, height } = environment
  const planner = new RoadPlanner(environment), graph = new PlanarRoadGraph()
  const regional = environment.terrain?.continuationTerrain ? new RegionalRoadPlanner(environment) : null
  const railways = input.railways ?? []
  planner.setRailwayCorridors(railways); regional?.setRailwayCorridors(railways)
  const crossingSurvey = railways.some(railway => railway.mode !== 'subway') ? new RailwayRoadConstraints(railways) : null
  const reserved = (input.reservedRegions ?? []).map(region => ({ region, bounds: regionBounds(region) }))
  const diagnostics: LayoutRoadDiagnostics = { attempted: 0, accepted: 0, rejected: 0, boundaryConnections: 0, bridges: 0, streetLength: 0, unservedZoneIds: [], unservedAccessIds: [] }
  const bridgeSpans: LayoutRoadResult['bridgeSpans'] = []
  type DatedSegment = { a: Point; b: Point; road: SimulatedRoad }
  const datedSegments: DatedSegment[] = [], datedBins = new Map<string, DatedSegment[]>()
  let indexedRoads = 0
  const openProjections = (point: Point, radius: number, year: number, count = 12): RoadProjection[] => {
    // Filter dates BEFORE selecting nearest candidates. Taking twelve modern
    // roads and only then discarding them can conceal a valid older arterial.
    for (; indexedRoads < graph.roads.length; indexedRoads++) {
      const road = graph.roads[indexedRoads]!
      for (let i = 1; i < road.points.length; i++) {
        const segment = { a: road.points[i - 1]!, b: road.points[i]!, road }
        datedSegments.push(segment)
        for (let x = Math.floor(Math.min(segment.a.x, segment.b.x) / 100); x <= Math.floor(Math.max(segment.a.x, segment.b.x) / 100); x++) for (let y = Math.floor(Math.min(segment.a.y, segment.b.y) / 100); y <= Math.floor(Math.max(segment.a.y, segment.b.y) / 100); y++) {
          const key = `${x}:${y}`, bin = datedBins.get(key) ?? []; bin.push(segment); datedBins.set(key, bin)
        }
      }
    }
    let candidates: Iterable<DatedSegment> = datedSegments
    if (radius < 500) {
      const nearby = new Set<DatedSegment>()
      for (let x = Math.floor((point.x - radius) / 100); x <= Math.floor((point.x + radius) / 100); x++) for (let y = Math.floor((point.y - radius) / 100); y <= Math.floor((point.y + radius) / 100); y++) for (const segment of datedBins.get(`${x}:${y}`) ?? []) nearby.add(segment)
      candidates = nearby
    }
    const hits: RoadProjection[] = []
    for (const segment of candidates) {
      if (segment.road.builtYear > year) continue
      const projection = projectOnRoadSegment(point, segment.a, segment.b), d = distance(point, projection.point)
      if (d <= radius) hits.push({ ...segment, ...projection, distance: d })
    }
    hits.sort((a, b) => a.distance - b.distance)
    const selected: RoadProjection[] = []
    for (const hit of hits) {
      if (selected.some(other => distance(other.point, hit.point) < 65)) continue
      selected.push(hit)
      if (selected.length >= count) break
    }
    return selected
  }
  const openStreet = (point: Point, radius: number, year: number) => openProjections(point, radius, year, 1)[0]
  let serial = 0
  const check = () => { if (signal?.aborted) throw signal.reason ?? new DOMException('Generation cancelled', 'AbortError') }
  const landAvailable = (p: Point) => Number.isFinite(environment.landCost?.(p) ?? 0) && !reserved.some(r => pointInRegion(p, r.region))
  const siteClear = (point: Point, roadWidth: number, junction = false) => {
    if (!planner.suitable(point, roadWidth) || !landAvailable(point)) return false
    const railClearance = roadWidth / 2 + 10.5
    for (const railway of railways) if (railway.mode !== 'subway') for (let i = 1; i < railway.points.length; i++) if (distance(point, projectOnRoadSegment(point, railway.points[i - 1]!, railway.points[i]!).point) < railClearance) return false
    const clearance = roadWidth / 2 + (junction ? 90 : 1.25)
    for (const item of reserved) if (item.region.polygon.some((a, i) => distance(point, projectOnRoadSegment(point, a, item.region.polygon[(i + 1) % item.region.polygon.length]!).point) < clearance)) return false
    for (let side = 0; side < 8; side++) {
      const q = { x: point.x + Math.cos(side * Math.PI / 4) * clearance, y: point.y + Math.sin(side * Math.PI / 4) * clearance }
      if (!landAvailable(q) || planner.waterAt(q)) return false
    }
    return true
  }
  const site = (point: Point, radius = 150, roadWidth = 9, junction = false): Point | null => {
    if (siteClear(point, roadWidth, junction)) return { ...point }
    for (let r = 24; r <= radius; r += 24) for (let n = 0; n < 12; n++) {
      const p = { x: point.x + Math.cos(n * Math.PI / 6) * r, y: point.y + Math.sin(n * Math.PI / 6) * r }
      if (siteClear(p, roadWidth, junction)) return p
    }
    return null
  }
  const center = site(input.center, Math.min(width, height) * .35, input.arterial === false ? 9 : 12, true) ?? input.center
  diagnostics.selectedCenter = center; diagnostics.boundaryAttempts = []; diagnostics.accessAttempts = []
  const density = Math.max(0, Math.min(1, (input.density ?? 65) / 100))
  const fallbackRadius = Math.min(width, height) * (input.settlement === 'village' ? .13 : input.settlement === 'rural-town' ? .23 : .37)
  const zones = input.zones ?? [{ id: 'layout-center', center, radius: fallbackRadius, kind: 'residential' as const, builtYear: 1920, density, maximumFloors: 3, polygon: [{ x: center.x - fallbackRadius, y: center.y - fallbackRadius }, { x: center.x + fallbackRadius, y: center.y - fallbackRadius }, { x: center.x + fallbackRadius, y: center.y + fallbackRadius }, { x: center.x - fallbackRadius, y: center.y + fallbackRadius }] }]
  const avoidsReservations = (points: Point[], roadWidth: number) => {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!, half = roadWidth / 2 + .75
      if (distance(a, b) < 1e-8) continue
      const bounds = { minX: Math.min(a.x, b.x) - half, maxX: Math.max(a.x, b.x) + half, minY: Math.min(a.y, b.y) - half, maxY: Math.max(a.y, b.y) + half }
      for (const item of reserved) if (bounds.minX < item.bounds.maxX && bounds.maxX > item.bounds.minX && bounds.minY < item.bounds.maxY && bounds.maxY > item.bounds.minY && polygonOverlapsRegion(corridorPolygon(a, b, half), item.region)) return false
      // The exact hard land mask is sampled at both pavement edges. The
      // planner's coarser earthwork-cost cache is not an ownership survey.
      const angle = heading(a, b), count = Math.max(1, Math.ceil(distance(a, b) / 4))
      for (let j = 0; j <= count; j++) for (const side of [-1, 0, 1]) {
        const p = lerp(a, b, j / count), q = { x: p.x - Math.sin(angle) * roadWidth / 2 * side, y: p.y + Math.cos(angle) * roadWidth / 2 * side }
        if (!Number.isFinite(environment.landCost?.(q) ?? 0)) return false
      }
    }
    return true
  }
  const junctionProfileAllowed = (road: SimulatedRoad, point: Point) => {
    if (!environment.terrain || road.bridge || road.points.some(p => distance(p, point) < 1e-7)) return true
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!, projection = projectOnRoadSegment(point, a, b)
      if (projection.t <= 0 || projection.t >= 1 || distance(point, projection.point) > 1e-7) continue
      return surveyedRoadGradeAllowed({ points: [a, point, b] }, road.role === 'highway' ? .09 : .13, environment.terrain.elevation)
    }
    return true
  }
  const canonicalSurvey = (route: PlannedRoute, preserveEndpoint: boolean) => {
    const points = route.points.map(p => ({ ...p }))
    for (const i of [0, points.length - 1]) {
      if (i === points.length - 1 && preserveEndpoint) continue
      const near = graph.nearest(points[i]!, 1)
      if (near) points[i] = near.point
    }
    const canonical = [points[0]!]
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!
      for (const hit of graph.crossings(a, b)) {
        // Splitting an older sampled profile can reveal a steep short section
        // that its previous long chord concealed. Reject this new junction
        // before mutating either road, rather than discovering it after plots.
        if (!junctionProfileAllowed(hit.road, hit.point)) return null
        if (distance(canonical.at(-1)!, hit.point) > 1e-7) canonical.push(hit.point)
      }
      if (distance(canonical.at(-1)!, b) > (preserveEndpoint && i === points.length - 1 ? 1e-8 : .04)) canonical.push(b)
    }
    return canonical.length >= 2 ? canonical : null
  }
  const accept = (route: PlannedRoute | null, role: RoadRole, roadWidth: number, year: number, reason: string, boundary = false) => {
    if (!route || !Number.isFinite(route.cost)) { diagnostics.rejected++; return null }
    const points = canonicalSurvey(route, role === 'access')
    if (!points || !avoidsReservations(points, roadWidth) || !planner.railwayWidthAllows(points, .01, roadWidth, role) || environment.terrain && !surveyedRoadGradeAllowed({ ...route, points }, role === 'highway' ? .09 : .13, environment.terrain.elevation)) { diagnostics.rejected++; return null }
    const proposedPoints = route.points
    const moved = points.length !== proposedPoints.length || points.some((p, i) => distance(p, proposedPoints[i]!) > 1e-8)
    if (moved && !planner.validate(points, roadWidth, route.bridgeLength > 0)) { diagnostics.rejected++; return null }
    route = { ...route, points }
    const added = graph.add(route.points, { id: `layout-road-${++serial}`, kind: boundary && input.arterial !== false ? 'arterial' : 'local', width: roadWidth, role, builtYear: year, phase: boundary ? 'regional-connections' : 'spatial-layout', reason, constructionCost: route.cost, ...(role === 'access' ? { preserveEndpoint: true } : {}), ...(route.bridgeLength > 0 ? { bridge: true } : {}), ...(boundary ? { boundaryContinuation: true } : {}) }, graph.roads.length > 0)
    if (!added) { diagnostics.rejected++; return null }
    diagnostics.accepted++; diagnostics.streetLength += roadLength(added.points)
    for (const span of route.surveyedBridgeSpans ?? []) bridgeSpans.push({ roadId: added.id, bankA: span.bankA, bankB: span.bankB })
    if (route.bridgeLength > 0) diagnostics.bridges++
    if (boundary) diagnostics.boundaryConnections++
    // Only a new gate changes the crossing inventory. Rebuilding/translating
    // every old street after each unrelated lane made district layout quadratic.
    if (crossingSurvey?.crossings(added.points).length) { planner.setRailwayRoadNetwork(graph.roads); regional?.setRailwayRoadNetwork(graph.roads) }
    return added
  }
  let lastSurvey: { route: boolean; reservations: boolean; railWidth: boolean } | undefined
  const survey = (from: Point, to: Point, role: RoadRole, roadWidth: number, year: number, reason: string, allowBridge = false, maxNodes = 900) => {
    check(); diagnostics.attempted++
    // Search the same entire right of way that the final ownership check
    // certifies. A five-metre carriageway plus its two 0.75m shoulders must not
    // repeatedly choose a path that just clips a protected campus corner.
    const surveyWidth = roadWidth + (role === 'access' ? 1.5 : 0)
    const shortAccess = role === 'access' && distance(from, to) < 20 && distance(from, to) > 1e-7 && planner.validate([from, to], surveyWidth) && (!environment.terrain || surveyedRoadGradeAllowed({ points: [from, to] }, .13, environment.terrain.elevation))
    const localFrame = role === 'lane' || role === 'collector' && !allowBridge && distance(from, to) <= 200
    const straightFrame = localFrame && planner.validate([from, to], roadWidth) && (!environment.terrain || surveyedRoadGradeAllowed({ points: [from, to] }, .13, environment.terrain.elevation))
    // A failed local block edge is omitted, not rerouted around a mountain or
    // through an entire neighbouring district. Collectors/gates retain search.
    const route = shortAccess || straightFrame ? planner.cost([from, to], role) : role === 'lane' ? null : planner.plan(from, to, { role, width: surveyWidth, allowBridge, alignment: role === 'access' ? 'planned' : 'natural', maximumGrade: role === 'highway' ? .09 : .13, maxNodes: localFrame ? Math.min(maxNodes, 64) : maxNodes })
    if (role === 'access') lastSurvey = { route: !!route, reservations: !!route && avoidsReservations(route.points, roadWidth), railWidth: !!route && planner.railwayWidthAllows(route.points, .01, roadWidth, role) }
    // A later anchor cannot lend its physical connection to an earlier map.
    const anchorYear = openStreet(from, .15, year)?.road.builtYear ?? graph.nearest(from, .15)?.road.builtYear ?? year
    return accept(route, role, roadWidth, Math.max(year, anchorYear), reason)
  }

  // A real short old-town street lets the river-crossing programme begin even
  // when the first regional proposal needs several small bridge approaches.
  // It has no outside designation; only a later surveyed external route can
  // establish regional access for the town and its institutions.
  const backboneYear = Math.min(1650, ...zones.map(zone => zone.builtYear))
  const backboneAngle = zones[0]?.angle ?? (width > height ? .08 : Math.PI / 2 + .08)
  for (const length of [160, 100, 60]) {
    for (const offset of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
      const angle = backboneAngle + offset, end = { x: center.x + Math.cos(angle) * length, y: center.y + Math.sin(angle) * length }
      if (survey(center, end, 'collector', 9, backboneYear, '旧来の街道が通る地区内の区間', false, 100)) break
    }
    if (graph.roads.length) break
  }

  // Survey exits before selecting building frontage. Endpoints remain outside
  // the crop, so clipping cannot manufacture a dead-ended major road.
  if (regional) {
    const role: RoadRole = input.arterial === false ? 'collector' : 'highway', roadWidth = input.arterial === false ? 9 : 12
    const mainAngle = zones[0]?.angle ?? (width > height ? .08 : Math.PI / 2 + .08)
    const sides = Array.from({ length: 4 }, (_, side) => {
      const edge = side === 0 ? { x: 0, y: center.y } : side === 1 ? { x: center.x, y: 0 } : side === 2 ? { x: width, y: center.y } : { x: center.x, y: height }
      const direction = heading(center, edge), alignment = Math.abs(Math.cos(direction - mainAngle))
      return { edge, score: alignment * 1000 - distance(center, edge) * .02 }
    }).sort((a, b) => b.score - a.score)
    for (const { edge } of sides) {
      check()
      // Candidate checks see actual surrounding land; no edge-clamping or
      // arbitrary extension into the sea. At most two expensive searches/side.
      for (const portal of regional.boundaryPortals(center, { width: roadWidth, preferred: edge, maxCandidates: 2 })) {
        diagnostics.attempted++
        const start = graph.nearest(center, 120)?.point ?? center
        const started = performance.now()
        const route = regional.plan(start, portal, { role, width: roadWidth, allowBridge: false, maximumGrade: .09, maxNodes: Math.min(7200, Math.max(2400, Math.ceil(distance(start, portal) / 2000) * 1600)) })
        diagnostics.boundaryAttempts.push({ start, portal, route: !!route, finiteCost: !!route && Number.isFinite(route.cost), reservations: !!route && avoidsReservations(route.points, roadWidth), railWidth: !!route && planner.railwayWidthAllows(route.points, .01, roadWidth, role), ...(route ? { cost: route.cost, length: route.length } : {}), milliseconds: performance.now() - started })
        if (route && accept({ ...route, boundaryContinuation: true }, role, roadWidth, backboneYear, '周辺地域へ続く地形に沿った幹線', true)) break
        if (!route) diagnostics.rejected++
      }
      if (diagnostics.boundaryConnections >= (input.settlement === 'village' ? 2 : 4)) break
    }
  }

  // Establish actual bridgeheads in small, atomic projects. Asking one lazy
  // regional route to discover several tangent-constrained bridge approaches
  // at once can miss perfectly buildable river-bank corridors. The surveyed
  // pair remains the ONLY water crossing; both approaches use dry-ground rules.
  const adoptedPairs = new Set<object>()
  const pairs = (environment.terrain?.bridgeCandidates ?? []).slice().sort((a, b) => distance(a.point, center) - distance(b.point, center)).slice(0, 16)
  for (let pass = 0; pass < 2; pass++) for (const pair of pairs) {
    check()
    if (!graph.roads.length || adoptedPairs.has(pair) || bridgeSpans.some(span => distance(lerp(span.bankA, span.bankB, .5), pair.point) < 60)) continue
    let adopted = false
    for (const [entry, exit] of [[pair.bankA, pair.bankB], [pair.bankB, pair.bankA]] as [Point, Point][]) {
      if (adopted) break
      const bridgeWidth = 7, angle = heading(entry, exit), spans = [{ bankA: entry, bankB: exit }], deck = planner.cost([entry, exit], 'bridge', true)
      deck.surveyedBridgeSpans = spans
      if (!planner.validate([entry, exit], bridgeWidth, true) || !avoidsReservations([entry, exit], bridgeWidth) || !planner.railwayWidthAllows([entry, exit], .01, bridgeWidth, 'bridge') || environment.terrain && !surveyedRoadGradeAllowed(deck, .13, environment.terrain.elevation)) continue
      const anchors = openProjections(entry, Math.max(1600, Math.min(width, height) * .8), 1650, 3)
      for (const anchor of anchors) {
        diagnostics.attempted++
        let approach: PlannedRoute | null = null
        const startHeading = graph.junctionHeading(anchor.point, entry), length = distance(anchor.point, entry)
        // Solve the actual tangent join continuously before asking a lattice
        // search to hit a small bridge-entry window. Every candidate is still
        // surveyed for real width, local-road radius, grade, rail and ownership.
        if (startHeading !== null) for (const first of [.32, .55, .85]) {
          for (const last of [.32, .55, .85]) {
            const points = tangentAlignment(anchor.point, entry, startHeading, angle, length * first, length * last, 5), geometry = alignmentDiagnostics(points)
            if (geometry.minimumRadius < 15 || geometry.length > length * 2.5 || !planner.validate(points, bridgeWidth) || !avoidsReservations(points, bridgeWidth) || !planner.railwayWidthAllows(points, .01, bridgeWidth, 'lane') || environment.terrain && !surveyedRoadGradeAllowed({ points }, .13, environment.terrain.elevation)) continue
            approach = planner.cost(points, 'lane'); break
          }
          if (approach) break
        }
        approach ??= planner.plan(anchor.point, entry, { role: 'lane', width: bridgeWidth, allowBridge: false, endHeading: angle, maximumGrade: .13, maxNodes: 1200 })
        if (!approach || !avoidsReservations(approach.points, bridgeWidth) || !planner.railwayWidthAllows(approach.points, .01, bridgeWidth, 'lane')) { diagnostics.rejected++; continue }
        let runout: PlannedRoute | null = null
        for (const length of [70, 45, 28]) {
          const end = { x: exit.x + Math.cos(angle) * length, y: exit.y + Math.sin(angle) * length }
          if (!planner.validate([exit, end], bridgeWidth) || !avoidsReservations([exit, end], bridgeWidth) || !planner.railwayWidthAllows([exit, end], .01, bridgeWidth, 'lane') || environment.terrain && !surveyedRoadGradeAllowed({ points: [exit, end] }, .13, environment.terrain.elevation)) continue
          runout = planner.cost([exit, end], 'lane'); break
        }
        if (!runout) { diagnostics.rejected++; continue }
        const common = { builtYear: 1650, phase: 'surveyed-river-crossing', kind: 'local' as const, width: bridgeWidth, reason: '測量した両岸を結ぶ橋と取付道路', preserveEndpoint: true }
        const approachId = `layout-road-${++serial}`, deckId = `layout-road-${++serial}`, runoutId = `layout-road-${++serial}`
        const built = graph.addBatch([
          { points: approach.points, metadata: { ...common, id: approachId, role: 'lane', constructionCost: approach.cost } },
          { points: deck.points, metadata: { ...common, id: deckId, role: 'bridge', bridge: true, constructionCost: deck.cost } },
          { points: runout.points, metadata: { ...common, id: runoutId, role: 'lane', constructionCost: runout.cost } },
        ])
        if (!built) { diagnostics.rejected++; continue }
        diagnostics.accepted += built.length; diagnostics.bridges++; diagnostics.streetLength += built.reduce((sum, road) => sum + roadLength(road.points), 0)
        bridgeSpans.push({ roadId: deckId, bankA: entry, bankB: exit }); adoptedPairs.add(pair); adopted = true
        if (crossingSurvey && built.some(road => crossingSurvey.crossings(road.points).length)) { planner.setRailwayRoadNetwork(graph.roads); regional?.setRailwayRoadNetwork(graph.roads) }
        break
      }
    }
  }

  // A far-bank bridgehead is now real connected pavement. Regional extensions
  // depart there rather than repeatedly solving the whole multi-river journey.
  if (regional && graph.roads.length) for (const edge of [{ x: 0, y: center.y }, { x: width, y: center.y }, { x: center.x, y: 0 }, { x: center.x, y: height }]) {
    const onSide = graph.roads.some(road => road.boundaryContinuation && road.points.some(p => edge.x === 0 ? p.x < 0 : edge.x === width ? p.x > width : edge.y === 0 ? p.y < 0 : p.y > height))
    if (onSide) continue
    for (const portal of regional.boundaryPortals(center, { width: 12, preferred: edge, maxCandidates: 2 })) {
      const anchor = openProjections(portal, Math.max(width, height) * 2, 1650, 1)[0]
      if (!anchor) continue
      diagnostics.attempted++
      const started = performance.now()
      const route = regional.plan(anchor.point, portal, { role: 'highway', width: 12, allowBridge: false, maximumGrade: .09, maxNodes: Math.min(7200, Math.max(1600, Math.ceil(distance(anchor.point, portal) / 2000) * 1600)) })
      diagnostics.boundaryAttempts.push({ start: anchor.point, portal, route: !!route, finiteCost: !!route && Number.isFinite(route.cost), reservations: !!route && avoidsReservations(route.points, 12), railWidth: !!route && planner.railwayWidthAllows(route.points, .01, 12, 'highway'), ...(route ? { cost: route.cost, length: route.length } : {}), milliseconds: performance.now() - started })
      if (accept(route, 'highway', 12, 1650, '橋の対岸から周辺地域へ続く幹線', true)) break
    }
  }

  // Public institutional gates precede modern residential grids. Their roads
  // join an already open street at the institution's own opening date, rather
  // than borrowing a 1995 subdivision and backdating the new approach to1875.
  const accessTargets = (input.accessTargets ?? []).slice().sort((a, b) => a.builtYear - b.builtYear || a.id.localeCompare(b.id))
  const connectGate = (target: LayoutAccessTarget, finalPass = false) => {
    check()
    const onStreet = openStreet(target.point, 1e-7, target.builtYear)
    if (onStreet) {
      if (!junctionProfileAllowed(onStreet.road, onStreet.point)) return false
      graph.ensureJunction(onStreet.point); return true
    }
    let served = false
    const attemptedAnchors: Point[] = []
    for (const radius of finalPass ? [Math.max(1200, Math.min(width, height) * .85)] : [900, Math.max(1200, Math.min(width, height) * .85)]) {
      let starts = openProjections(target.point, radius, target.builtYear, finalPass ? 64 : 9)
      if (finalPass) {
        // Six nearest samples can all lie on the same side of a ravine. Try
        // the closest real, already-open approach in each bearing sector;
        // this is bounded candidate selection, not an unbounded search budget.
        const bearings = new Map<number, RoadProjection>()
        for (const start of starts) {
          const sector = Math.floor((heading(target.point, start.point) + Math.PI) / (Math.PI / 4))
          if (!bearings.has(sector)) bearings.set(sector, start)
        }
        starts = [...bearings.values()]
      }
      let attempts = 0
      for (const start of starts) {
        if (attemptedAnchors.some(point => distance(point, start.point) < 50)) continue
        attemptedAnchors.push(start.point)
        const road = survey(start.point, target.point, 'access', 5, target.builtYear, '施設の敷地入口への公道接続', true, radius === 900 ? 900 : 1600)
        diagnostics.accessAttempts?.push({ id: target.id, start: start.point, target: target.point, ...(lastSurvey ?? { route: false, reservations: false, railWidth: false }) })
        if (road) { served = true; break }
        if (++attempts >= (finalPass ? 8 : 3)) break
      }
      if (served) break
    }
    return served
  }
  for (const target of accessTargets) if (!connectGate(target)) diagnostics.unservedAccessIds.push(target.id)

  const active: { zone: LayoutFirstZone; hub: Point; angle: number }[] = []
  for (const zone of zones.slice().sort((a, b) => distance(a.center, center) - distance(b.center, center))) {
    check()
    // A reserved castle or campus may legitimately cover the district's brief
    // centre. Keep its older neighbourhood on actual public pavement within
    // the same district, instead of silently dropping the whole historic core.
    const existingHub = () => openProjections(zone.center, zone.radius, zone.builtYear, 32)
      .find(hit => pointInRegion(hit.point, zone) && siteClear(hit.point, 9))?.point
    let hub = site(zone.center, Math.min(180, zone.radius * .45)) ?? existingHub()
    if (!hub) { diagnostics.unservedZoneIds.push(zone.id); continue }
    let connected = openStreet(hub, 2, zone.builtYear)
    if (!graph.roads.length) {
      const to = site({ x: hub.x + Math.min(zone.radius * .7, 180), y: hub.y }, 70, 8)
      if (to) survey(hub, to, 'collector', 8, zone.builtYear, '地区の生活幹線')
      connected = openStreet(hub, 2, zone.builtYear)
    } else if (!connected) {
      const starts = openProjections(hub, Math.max(width, height), zone.builtYear, 3)
      for (const start of starts) {
        const road = survey(start.point, hub, 'collector', 9, zone.builtYear, '地区を幹線網へ結ぶ集散道路', true, 1400)
        if (road) { connected = openStreet(hub, 2, zone.builtYear); break }
      }
    }
    if (!connected) {
      const alternative = existingHub()
      if (alternative) { hub = alternative; connected = openStreet(hub, 1e-7, zone.builtYear) }
    }
    if (!connected) { diagnostics.unservedZoneIds.push(zone.id); continue }
    const roadAngle = heading(connected.a, connected.b)
    active.push({ zone, hub: connected.point, angle: zone.angle ?? roadAngle })
  }

  for (const { zone, hub, angle } of active) {
    check()
    const random = seededRandom(`${input.seed}:streets:${zone.id}`)
    const baseSpacing = zone.kind === 'industrial' ? 150 : zone.kind === 'rural' ? 155 : zone.kind === 'historic' ? 78 : zone.kind === 'apartment' ? 118 : 92
    const spacing = baseSpacing * (1 + Math.max(0, .8 - zone.density) * .35)
    const limit = Math.min(9, Math.max(2, Math.ceil(zone.radius / spacing)))
    const axis = () => {
      const positions = new Map<number, number>([[0, 0]])
      for (const side of [-1, 1]) { let at = 0; for (let i = 1; i <= limit; i++) { at += spacing * (.76 + random() * .5); positions.set(side * i, at * side) } }
      return positions
    }
    const us = axis(), vs = axis(), cos = Math.cos(angle), sin = Math.sin(angle)
    const nodes = new Map<string, { point: Point; i: number; j: number }>()
    const phaseA = random() * Math.PI * 2, phaseB = random() * Math.PI * 2
    for (let j = -limit; j <= limit; j++) for (let i = -limit; i <= limit; i++) {
      const rawU = us.get(i)!, rawV = vs.get(j)!
      const u = rawU + Math.sin(rawV / 290 + phaseA) * 12 - Math.sin(phaseA) * 12
      const v = rawV + Math.sin(rawU / 340 + phaseB) * 17 - Math.sin(phaseB) * 17
      let point = i === 0 && j === 0 ? hub : { x: hub.x + cos * u - sin * v, y: hub.y + sin * u + cos * v }
      if (Math.hypot(rawU, rawV) > zone.radius * 1.13 || !pointInRegion(point, zone) || !planner.suitable(point, 6) || !landAvailable(point)) continue
      // Close against actual older streets instead of running a separate
      // parallel alignment a few metres beside the existing pavement.
      const existing = openStreet(point, 18, zone.builtYear)
      if (existing) point = existing.point
      nodes.set(`${i}:${j}`, { point, i, j })
    }
    if (!nodes.has('0:0')) nodes.set('0:0', { point: hub, i: 0, j: 0 })
    const reached = new Set<string>(['0:0']), pending = new Set(nodes.keys()), links = new Set<string>()
    pending.delete('0:0')
    // A connected breadth-first construction creates the district skeleton;
    // the second pass closes its blocks using the SAME canonical endpoints.
    for (let pass = 0; pass < limit * 3 && pending.size; pass++) {
      let progress = false
      for (const key of [...pending]) {
        const node = nodes.get(key)!
        const neighbours = [[node.i - 1, node.j], [node.i + 1, node.j], [node.i, node.j - 1], [node.i, node.j + 1]]
          .map(([i, j]) => `${i}:${j}`).filter(other => reached.has(other))
        for (const other of neighbours) {
          const a = nodes.get(other)!, start = openStreet(a.point, 2, zone.builtYear)?.point ?? a.point
          const spine = !node.i && !a.i || !node.j && !a.j
          const role: RoadRole = spine ? 'collector' : 'lane', roadWidth = spine ? 8 : zone.kind === 'historic' ? 5.2 : 6
          const target = openStreet(node.point, 24, zone.builtYear)?.point ?? node.point
          const existingConnection = openStreet(target, 1e-6, zone.builtYear)
          if (existingConnection || survey(start, target, role, roadWidth, zone.builtYear, spine ? '地区を通り抜ける生活幹線' : '街区を区切る生活道路', false, 250)) {
            node.point = target; reached.add(key); pending.delete(key); links.add([key, other].sort().join('|')); progress = true; break
          }
        }
      }
      if (!progress) break
    }
    for (const key of reached) {
      const node = nodes.get(key)!
      for (const other of [`${node.i + 1}:${node.j}`, `${node.i}:${node.j + 1}`]) {
        if (!reached.has(other) || links.has([key, other].sort().join('|'))) continue
        const goal = nodes.get(other)!, start = openStreet(node.point, 2, zone.builtYear)?.point ?? node.point, to = openStreet(goal.point, 2, zone.builtYear)?.point ?? goal.point
        if (distance(start, to) < 22) continue
        survey(start, to, 'lane', zone.kind === 'historic' ? 5.2 : 6, zone.builtYear, '接続した生活道路で街区を閉じる', false, 160)
      }
    }
  }

  // A same-era town street can provide a better, shorter approach around a
  // protected compound than the initial regional spine. Retry only the gates
  // still unserved; the dated projection index still excludes every street
  // that opened after the institution, so this cannot backdate a modern grid.
  const retryIds = new Set(diagnostics.unservedAccessIds)
  diagnostics.unservedAccessIds = []
  for (const target of accessTargets) if (retryIds.has(target.id) && !connectGate(target, true)) diagnostics.unservedAccessIds.push(target.id)

  const roads = graph.roads
  // Final roads keep their actual opening phase. A weak spatial brief cannot
  // waive a longitudinal grade constraint at a later stage.
  if (environment.terrain) for (const road of roads) if (!road.bridge && !road.boundaryContinuation && !surveyedRoadGradeAllowed({ points: road.points }, road.role === 'highway' ? .09 : .13, environment.terrain.elevation)) throw new Error(`Layout road profile failed: ${road.id}`, { cause: { road, diagnostics } })
  return { roads, graph, blocks: extractStreetBlocks(roads), center, zones, diagnostics, bridgeSpans }
}

/** Ordinary public road length; controlled roads cannot create house frontage. */
export function layoutOrdinaryStreetLength(roads: readonly Road[]) {
  return roads.filter(road => !road.controlledAccess && road.role !== 'expressway' && road.role !== 'ramp').reduce((sum, road) => sum + roadLength(road.points), 0)
}
