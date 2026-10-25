import type { Point, Railway, Road } from './types'
import type { PolygonRegion } from './geometry'
import { corridorPolygon, distance, pointInRegion, polygonArea, polygonOverlapsRegion, seededRandom } from './geometry'
import type { LayoutFirstZone } from './layout-first-types'
import { PlanarRoadGraph, extractStreetBlocks, projectOnRoadSegment, roadLength } from './road-graph'
import type { RoadProjection, RoadRole, SimulatedRoad } from './road-graph'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute, PlanningEnvironment } from './road-planner'
import { RegionalRoadPlanner } from './regional-road-planner'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'
import { RailwayRoadConstraints } from './railway-road-constraints'
import { alignmentDiagnostics, tangentAlignment } from './road-alignment'
import { adoptLayoutInfillZones, layoutStreetFaceCenter, splitLayoutStreetFace } from './layout-first-street-blocks'

export interface LayoutAccessTarget { id: string; point: Point; builtYear: number }
export interface LayoutRoadDiagnostics {
  attempted: number; accepted: number; rejected: number; boundaryConnections: number
  bridges: number; streetLength: number; unservedZoneIds: string[]; unservedAccessIds: string[]
  selectedCenter?: Point
  boundaryAttempts?: { start: Point; portal: Point; route: boolean; finiteCost: boolean; reservations: boolean; railWidth: boolean; cost?: number; length?: number; milliseconds?: number; phase?: 'mesh-exit' }[]
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

/** Late exits depart from the surveyed public network nearest the requested
 * crop edge, including modern neighbourhood streets absent from the old spine. */
export function layoutNearEdgeExitAnchors(roads: readonly Road[], side: 'west' | 'east' | 'north' | 'south', width: number, height: number, count = 3) {
  const depth = (point: Point) => side === 'west' ? point.x : side === 'east' ? width - point.x : side === 'north' ? point.y : height - point.y
  const candidates = roads.filter(road => !road.controlledAccess && road.role !== 'expressway' && road.role !== 'ramp' && (road.level ?? 0) === 0 && !road.bridge && road.width >= 6.8)
    .flatMap(road => road.points.filter(point => point.x >= 8 && point.y >= 8 && point.x <= width - 8 && point.y <= height - 8).map(point => ({ point, road })))
    .sort((a, b) => depth(a.point) - depth(b.point) || a.road.id.localeCompare(b.road.id))
  const selected: typeof candidates = []
  for (const candidate of candidates) {
    if (selected.some(other => distance(other.point, candidate.point) < 300)) continue
    selected.push(candidate)
    if (selected.length >= count) break
  }
  return selected
}

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
  let zones = input.zones ? [...input.zones] : [{ id: 'layout-center', center, radius: fallbackRadius, kind: 'residential' as const, builtYear: 1920, density, maximumFloors: 3, polygon: [{ x: center.x - fallbackRadius, y: center.y - fallbackRadius }, { x: center.x + fallbackRadius, y: center.y - fallbackRadius }, { x: center.x + fallbackRadius, y: center.y + fallbackRadius }, { x: center.x - fallbackRadius, y: center.y + fallbackRadius }] }]
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
    const added = graph.add(route.points, { id: `layout-road-${++serial}`, kind: (boundary || role === 'highway') && input.arterial !== false ? 'arterial' : 'local', width: roadWidth, role, builtYear: year, phase: boundary ? 'regional-connections' : 'spatial-layout', reason, constructionCost: route.cost, ...(role === 'access' ? { preserveEndpoint: true } : {}), ...(route.bridgeLength > 0 ? { bridge: true } : {}), ...(boundary ? { boundaryContinuation: true } : {}) }, graph.roads.length > 0)
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

  const active: { zone: LayoutFirstZone; hub: Point }[] = []
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
    active.push({ zone, hub: connected.point })
  }

  // One continuous citywide corridor frame crosses planning territories.
  // Rows/columns have coherent bearings and spacing; centres and stations
  // attach to this frame rather than seeding diagonals through every face.
  const random = seededRandom(`${input.seed}:citywide-corridors`)
  const coverage = zones.reduce((sum, zone) => sum + polygonArea(zone.polygon), 0)
  const corridorSpacing = Math.max(300, Math.min(430, Math.sqrt(coverage / Math.max(1, zones.length)) / 3.2))
  const corridorAngle = zones.find(zone => zone.kind === 'historic')?.angle ?? backboneAngle
  const cos = Math.cos(corridorAngle), sin = Math.sin(corridorAngle)
  const local = (p: Point) => ({ x: (p.x - center.x) * cos + (p.y - center.y) * sin, y: -(p.x - center.x) * sin + (p.y - center.y) * cos })
  const world = (u: number, v: number): Point => ({ x: center.x + cos * u - sin * v, y: center.y + sin * u + cos * v })
  const closestZone = (point: Point) => zones.filter(zone => pointInRegion(point, zone)).sort((a, b) => distance(a.center, point) / a.radius - distance(b.center, point) / b.radius)[0]
    ?? zones.slice().sort((a, b) => distance(a.center, point) - distance(b.center, point))[0]
  type CorridorSite = { point: Point; year: number; row: number; column: number }
  type CorridorEdge = { a: string; b: string; major: boolean; order: number }
  const sites = new Map<string, CorridorSite>(), edges: CorridorEdge[] = []
  const corners = zones.flatMap(zone => zone.polygon.map(local))
  const mainRow = (row: number) => row % 6 === 0
  const mainColumn = (column: number) => column % 7 === 0
  const connectCorridor = (from: Point, to: Point, year: number, major = false, attachment = false) => {
    const role: RoadRole = major && input.arterial !== false ? 'highway' : 'collector', roadWidth = major && input.arterial !== false ? 14 : 8.5
    const maximumGrade = role === 'highway' ? .09 : .13
    const reason = attachment ? '地区の中心から共通の市域幹線への接続' : major ? '市域を連続して通り抜ける広幅員の都市幹線' : '市域を連続して結ぶ生活幹線'
    check(); diagnostics.attempted++
    const openingYear = Math.max(year, graph.nearest(from, .15)?.road.builtYear ?? year)
    if (planner.validate([from, to], roadWidth) && avoidsReservations([from, to], roadWidth) && planner.railwayWidthAllows([from, to], .01, roadWidth, role) && (!environment.terrain || surveyedRoadGradeAllowed({ points: [from, to] }, maximumGrade, environment.terrain.elevation))) return accept(planner.cost([from, to], role), role, roadWidth, openingYear, reason)
    diagnostics.attempted--
    return survey(from, to, role, roadWidth, openingYear, reason, false, 500)
  }
  if (corners.length) {
    const minColumn = Math.floor(Math.min(...corners.map(p => p.x)) / corridorSpacing) - 1, maxColumn = Math.ceil(Math.max(...corners.map(p => p.x)) / corridorSpacing) + 1
    const minRow = Math.floor(Math.min(...corners.map(p => p.y)) / corridorSpacing) - 1, maxRow = Math.ceil(Math.max(...corners.map(p => p.y)) / corridorSpacing) + 1
    const coordinates = (low: number, high: number) => {
      const values = new Map<number, number>([[0, 0]])
      for (const sign of [-1, 1]) {
        let position = 0
        for (let n = 1; n <= Math.max(Math.abs(low), Math.abs(high)); n++) { position += corridorSpacing * (.94 + random() * .12); values.set(sign * n, sign * position) }
      }
      return values
    }
    const us = coordinates(minColumn, maxColumn), vs = coordinates(minRow, maxRow)
    // A whole row/column shares its small offset. Independent node jitter was
    // the source of the previous triangular puzzle-shard street fabric.
    const rowOffsets = new Map(Array.from({ length: maxRow - minRow + 1 }, (_, i) => { const row = minRow + i; return [row, row === 0 ? 0 : (random() - .5) * corridorSpacing * .045] }))
    const columnOffsets = new Map(Array.from({ length: maxColumn - minColumn + 1 }, (_, i) => { const column = minColumn + i; return [column, column === 0 ? 0 : (random() - .5) * corridorSpacing * .045] }))
    const nearUrbanEnvelope = (point: Point) => zones.some(zone => pointInRegion(point, zone) || zone.polygon.some((a, i) => distance(point, projectOnRoadSegment(point, a, zone.polygon[(i + 1) % zone.polygon.length]!).point) <= corridorSpacing * .72))
    for (let row = minRow; row <= maxRow; row++) for (let column = minColumn; column <= maxColumn; column++) {
      const point = world(us.get(column)! + rowOffsets.get(row)!, vs.get(row)! + columnOffsets.get(column)!)
      if (point.x < 18 || point.y < 18 || point.x > width - 18 || point.y > height - 18 || !nearUrbanEnvelope(point)) continue
      const surveyed = site(point, 48, mainRow(row) || mainColumn(column) ? 14 : 8.5)
      if (!surveyed || !nearUrbanEnvelope(surveyed)) continue
      sites.set(`${column}:${row}`, { point: surveyed, year: closestZone(surveyed)?.builtYear ?? 1920, row, column })
    }
    for (const [key, node] of sites) for (const [column, row, major] of [[node.column + 1, node.row, mainRow(node.row)], [node.column, node.row + 1, mainColumn(node.column)]] as const) {
      const other = `${column}:${row}`
      if (sites.has(other)) edges.push({ a: key, b: other, major, order: Math.abs(node.column) + Math.abs(node.row) })
    }
  }
  edges.sort((a, b) => Number(b.major) - Number(a.major) || a.order - b.order || a.a.localeCompare(b.a) || a.b.localeCompare(b.b))
  const unfinished = new Set(edges), connectedSites = new Set<string>()
  for (const [key, node] of sites) if (graph.nearest(node.point, 2)) connectedSites.add(key)
  // Hubs are public-street attachments, never extra mesh vertices. This also
  // lets an already surveyed opposite-bank bridgehead seed its local frame.
  for (const { zone, hub } of active) {
    const candidates = [...sites.entries()].sort((a, b) => distance(hub, a[1].point) - distance(hub, b[1].point)).slice(0, 3)
    for (const [key, node] of candidates) {
      if (connectedSites.has(key)) break
      const start = graph.nearest(hub, 2)?.point
      if (!start) break
      if (distance(start, node.point) < 2 || connectCorridor(start, node.point, Math.max(zone.builtYear, node.year), false, true)) { connectedSites.add(key); break }
    }
  }
  // This changes construction order only. Four grid neighbours define the
  // complete spatial proposal first; accepted closing edges form real faces.
  for (let pass = 0; pass <= sites.size && unfinished.size; pass++) {
    let progress = false
    for (const edge of [...unfinished]) {
      const aConnected = connectedSites.has(edge.a), bConnected = connectedSites.has(edge.b)
      if (!aConnected && !bConnected) continue
      const a = sites.get(aConnected ? edge.a : edge.b)!, b = sites.get(aConnected ? edge.b : edge.a)!
      const start = graph.nearest(a.point, 2)?.point, end = graph.nearest(b.point, 2)?.point ?? b.point
      if (!start) continue
      unfinished.delete(edge)
      if (distance(start, end) < 12) { connectedSites.add(edge.a); connectedSites.add(edge.b); progress = true; continue }
      const road = connectCorridor(start, end, Math.max(a.year, b.year), edge.major)
      if (road) { a.point = start; b.point = end; connectedSites.add(edge.a); connectedSites.add(edge.b); progress = true }
    }
    if (!progress) break
  }

  // The first regional surveys knew only the old centre/bridgeheads. Once
  // the citywide mesh exists, use its real edgeward pavement as the departure
  // for still-missing outside connections, without a multi-kilometre restart
  // from the town centre. Every continuation is surveyed in surrounding land.
  if (regional) for (const side of ['west', 'east', 'north', 'south'] as const) {
    const outside = (point: Point) => side === 'west' ? point.x < 0 : side === 'east' ? point.x > width : side === 'north' ? point.y < 0 : point.y > height
    if (graph.roads.some(road => road.boundaryContinuation && road.points.some(outside))) continue
    const role: RoadRole = input.arterial === false ? 'collector' : 'highway', roadWidth = input.arterial === false ? 9 : 12
    let connected = false
    for (const anchor of layoutNearEdgeExitAnchors(graph.roads, side, width, height, 3)) {
      const edge = side === 'west' ? { x: 0, y: anchor.point.y } : side === 'east' ? { x: width, y: anchor.point.y } : side === 'north' ? { x: anchor.point.x, y: 0 } : { x: anchor.point.x, y: height }
      for (const portal of regional.boundaryPortals(anchor.point, { width: roadWidth, preferred: edge, maxCandidates: 2 })) {
        check(); diagnostics.attempted++
        const started = performance.now(), route = regional.plan(anchor.point, portal, { role, width: roadWidth, allowBridge: false, maximumGrade: role === 'highway' ? .09 : .13, maxNodes: Math.min(4200, Math.max(1200, Math.ceil(distance(anchor.point, portal) / 1000) * 1000)) })
        diagnostics.boundaryAttempts?.push({ start: anchor.point, portal, route: !!route, finiteCost: !!route && Number.isFinite(route.cost), reservations: !!route && avoidsReservations(route.points, roadWidth), railWidth: !!route && planner.railwayWidthAllows(route.points, .01, roadWidth, role), ...(route ? { cost: route.cost, length: route.length } : {}), milliseconds: performance.now() - started, phase: 'mesh-exit' })
        if (accept(route, role, roadWidth, Math.max(1975, anchor.road.builtYear ?? 1975), '市街地の外縁から実際の周辺地形へ続く幹線', true)) { connected = true; break }
      }
      if (connected) break
    }
  }

  const coarseFaces = extractStreetBlocks(graph.roads)
  zones = adoptLayoutInfillZones(coarseFaces, zones, { settlement: input.settlement, density, corridorSpacing,
    canBuild: point => landAvailable(point) && !planner.waterAt(point) && (environment.terrain?.slope(point) ?? 0) <= .13,
    excludedRegions: [...(input.reservedRegions ?? []), ...environment.areas.filter(area => area.kind === 'water')] })

  // Subdivide the faces of accepted pavement, rather than drawing a second
  // theoretical parcel grid. Every new local street has TWO real perimeter
  // junctions. Failed surveys leave the original face intact, never a stub.
  const pendingFaces = coarseFaces.map(polygon => ({ polygon, depth: 0 }))
  for (let cursor = 0; cursor < pendingFaces.length; cursor++) {
    check()
    const { polygon, depth } = pendingFaces[cursor]!
    if (depth >= 12) continue
    const middle = layoutStreetFaceCenter(polygon)
    const zone = closestZone(middle)
    if (!zone || !zones.some(candidate => pointInRegion(middle, candidate))) continue
    const spacing = zone.kind === 'historic' ? 70 : zone.kind === 'industrial' ? 175 : zone.kind === 'rural' ? 150 : 108
    const angle = zone.angle ?? corridorAngle
    for (let attempt = 0; attempt < 4; attempt++) {
      const split = splitLayoutStreetFace(polygon, { spacing, angle, jitter: zone.kind === 'historic' ? .30 : .045, seed: `${input.seed}:face:${cursor}:${attempt}` })
      if (!split) break
      const from = graph.nearest(split.points[0], .08), to = graph.nearest(split.points[1], .08)
      if (!from || !to) continue
      const year = Math.max(zone.builtYear, from.road.builtYear, to.road.builtYear)
      const added = survey(from.point, to.point, 'lane', zone.kind === 'historic' ? 5.2 : zone.kind === 'industrial' ? 7 : 6, year, '実在する周囲の道路を結んで街区を分割する生活道路', false, 0)
      if (!added) continue
      // Survey can insert extra junctions, but it cannot move the accepted
      // straight chord. Its exact two child faces remain the next briefs.
      pendingFaces.push(...split.polygons.map(child => ({ polygon: child, depth: depth + 1 })))
      break
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
