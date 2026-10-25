import type { Point, Railway, Road } from './types'
import type { PolygonRegion } from './geometry'
import { corridorPolygon, distance, pointInRegion, polygonArea, polygonOverlapsRegion, rectangle } from './geometry'
import type { LayoutFirstZone } from './layout-first-types'
import { PlanarRoadGraph, extractStreetBlocks, projectOnRoadSegment, roadLength } from './road-graph'
import type { RoadProjection, RoadRole, SimulatedRoad } from './road-graph'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute, PlanningEnvironment } from './road-planner'
import { RegionalRoadPlanner } from './regional-road-planner'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'
import { RailwayRoadConstraints } from './railway-road-constraints'
import { alignmentDiagnostics, tangentAlignment } from './road-alignment'
import { adoptLayoutInfillZones, layoutStreetFaceCenter } from './layout-first-street-blocks'
import { planLayoutStreetFabricSplit } from './layout-first-street-fabric'
import { surveyLayoutMainCorridors } from './layout-first-main-corridors'
import { layoutFrontageLoop } from './layout-first-frontage-loops'
import { layoutNeighborhoodHasStreetFace, proposeLayoutNeighborhoodLinks } from './layout-first-neighborhood-links'
import type { LayoutNeighborhoodSite } from './layout-first-neighborhood-links'
import { createLayoutCoverageMask, measureLayoutCoverageGain } from './layout-first-coverage-blocks'
import type { LayoutCoverageAnchor } from './layout-first-coverage-blocks'
import { surveyLayoutCoverageAlignment } from './layout-first-coverage-survey'
import type { LayoutCoverageSurveyAttempt } from './layout-first-coverage-survey'
import { layoutCoverageHasPhysicalGain, runLayoutCoveragePass } from './layout-first-coverage-pass'

export interface LayoutAccessTarget { id: string; point: Point; builtYear: number }
export interface LayoutRoadDiagnostics {
  attempted: number; accepted: number; rejected: number; boundaryConnections: number
  bridges: number; streetLength: number; unservedZoneIds: string[]; unservedAccessIds: string[]
  selectedCenter?: Point
  boundaryAttempts?: { start: Point; portal: Point; route: boolean; finiteCost: boolean; reservations: boolean; railWidth: boolean; cost?: number; length?: number; milliseconds?: number; phase?: 'mesh-exit' }[]
  accessAttempts?: { id: string; start: Point; target: Point; route: boolean; reservations: boolean; railWidth: boolean }[]
  coverage?: { builtYear: number; phase?: 'before-fallback' | 'after-fallback'; before: number; after: number; enclosedGain: number; coveredGain: number; streetLength: number; attempted: number; accepted: number; routeFailures: number; guardFailures: number; unchangedFaces: number; proposalRounds?: number; surveyAttempts?: { from: Point; to: Point; through: Point; attempts: LayoutCoverageSurveyAttempt[]; rejectedInput?: string }[] }[]
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
  const accept = (route: PlannedRoute | null, role: RoadRole, roadWidth: number, year: number, reason: string, boundary = false, throughRouteId?: string) => {
    if (!route || !Number.isFinite(route.cost)) { diagnostics.rejected++; return null }
    const points = canonicalSurvey(route, role === 'access')
    if (!points || !avoidsReservations(points, roadWidth) || !planner.railwayWidthAllows(points, .01, roadWidth, role) || environment.terrain && !surveyedRoadGradeAllowed({ ...route, points }, role === 'highway' ? .09 : .13, environment.terrain.elevation)) { diagnostics.rejected++; return null }
    const proposedPoints = route.points
    const moved = points.length !== proposedPoints.length || points.some((p, i) => distance(p, proposedPoints[i]!) > 1e-8)
    if (moved && !(boundary && regional ? regional.validate(points, roadWidth, route.bridgeLength > 0) : planner.validate(points, roadWidth, route.bridgeLength > 0))) { diagnostics.rejected++; return null }
    route = { ...route, points }
    // Outside-to-outside corridors join at their surveyed internal town point,
    // rather than at an outside endpoint. Verify that exact contact first.
    const internalContact = !!throughRouteId && route.points.some(point => !!graph.nearest(point, 1e-7))
    const added = graph.add(route.points, { id: `layout-road-${++serial}`, kind: throughRouteId && input.arterial !== false ? 'arterial' : 'local', width: roadWidth, role, builtYear: year, phase: throughRouteId ? 'surveyed-main-corridor' : boundary ? 'regional-connections' : 'spatial-layout', reason, constructionCost: route.cost, ...(throughRouteId ? { throughRouteId } : {}), ...(role === 'access' ? { preserveEndpoint: true } : {}), ...(route.bridgeLength > 0 ? { bridge: true } : {}), ...(boundary ? { boundaryContinuation: true } : {}) }, graph.roads.length > 0 && !internalContact)
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

  // Regional roads acquire their own continuous physical alignment before
  // local streets exist. A later path over household streets is not a trunk.
  if (regional && input.arterial !== false) surveyLayoutMainCorridors({ environment, center, zones, railways, signal }, proposal => {
    if (!proposal.townConnection) return !!accept(proposal.route, 'highway', proposal.width, proposal.builtYear, '周辺地域から町を通過する連続した幹線の測量', true, proposal.id)
    const mainPoints = canonicalSurvey(proposal.route, false), connectionPoints = canonicalSurvey(proposal.townConnection, true)
    if (!mainPoints || !connectionPoints) return false
    for (const [route, points, roadWidth, role, radius] of [[proposal.route, mainPoints, proposal.width, 'highway', 85], [proposal.townConnection, connectionPoints, 9, 'collector', 50]] as const) {
      if (!avoidsReservations(points, roadWidth) || !planner.railwayWidthAllows(points, .01, roadWidth, role) || alignmentDiagnostics(points).minimumRadius < radius - 1e-6 || environment.terrain && !surveyedRoadGradeAllowed({ ...route, points }, role === 'highway' ? .09 : .13, environment.terrain.elevation) || !(role === 'highway' ? regional.validate(points, roadWidth, route.bridgeLength > 0) : planner.validate(points, roadWidth))) return false
    }
    const connectionMetadata = { id: `layout-road-${serial + 1}`, kind: 'local' as const, role: 'collector' as const, width: 9, builtYear: proposal.builtYear, phase: 'spatial-layout', reason: '町の旧道と独立した通過幹線を結ぶ集散道路', constructionCost: proposal.townConnection.cost, preserveEndpoint: true }
    const mainMetadata = { id: `layout-road-${serial + 2}`, kind: 'arterial' as const, role: 'highway' as const, width: proposal.width, builtYear: proposal.builtYear, phase: 'surveyed-main-corridor', reason: '周辺地域から町を通過する連続した幹線の測量', constructionCost: proposal.route.cost, boundaryContinuation: true, throughRouteId: proposal.id, ...(proposal.route.bridgeLength > 0 ? { bridge: true } : {}) }
    if (!junctionProfileAllowed({ ...mainMetadata, points: mainPoints }, connectionPoints.at(-1)!)) return false
    const projects = [{ points: connectionPoints, metadata: connectionMetadata }, { points: mainPoints, metadata: mainMetadata, requireConnection: false }], staged = graph.fork()
    const trial = staged.addBatch(projects)
    if (!trial || ![mainPoints[0]!, mainPoints.at(-1)!].every(point => Number.isFinite(staged.accessibilityFrom(center)(point)))) return false
    const built = graph.addBatch(projects)
    if (!built) return false
    serial += 2; diagnostics.accepted += built.length; diagnostics.streetLength += built.reduce((sum, road) => sum + roadLength(road.points), 0); diagnostics.boundaryConnections++
    for (const span of proposal.route.surveyedBridgeSpans ?? []) bridgeSpans.push({ roadId: mainMetadata.id, bankA: span.bankA, bankB: span.bankB })
    if (proposal.route.bridgeLength > 0) diagnostics.bridges++
    if (crossingSurvey && built.some(road => crossingSurvey.crossings(road.points).length)) { planner.setRailwayRoadNetwork(graph.roads); regional.setRailwayRoadNetwork(graph.roads) }
    return true
  })

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
      if (graph.roads.some(road => road.boundaryContinuation && road.points.some(p => edge.x === 0 ? p.x < 0 : edge.x === width ? p.x > width : edge.y === 0 ? p.y < 0 : p.y > height))) continue
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
    if (junctionProfileAllowed(connected.road, connected.point)) graph.ensureJunction(connected.point)
    active.push({ zone, hub: connected.point })
  }

  // Connect existing public streets BETWEEN urban hubs and real station
  // gates before enclosing a neighbourhood on its own. No planning circle
  // supplies the endpoints or the shape of these accepted town blocks.
  const neighbourhoodSites: LayoutNeighborhoodSite[] = accessTargets.filter(target => target.id.startsWith('station-access-')).map(target => ({ id: target.id, point: target.point, builtYear: target.builtYear }))
  for (const { zone, hub } of active) if (zone.kind !== 'rural' && !neighbourhoodSites.some(site => distance(site.point, hub) < 120)) neighbourhoodSites.push({ id: zone.id, point: hub, builtYear: zone.builtYear })
  const connectNeighbourhoodStreets = () => {
    let accepted = 0
    for (const link of proposeLayoutNeighborhoodLinks({ roads: graph.roads, sites: neighbourhoodSites })) {
      check()
      const from = graph.nearest(link.from.point, 1e-6), to = graph.nearest(link.to.point, 1e-6)
      if (!from || !to) continue
      const year = Math.max(link.builtYear, from.road.builtYear, to.road.builtYear)
      if (survey(from.point, to.point, 'collector', link.width, year, '隣接する住区と駅前の実公道を複数箇所で結ぶ連絡道路', false, 1200)) accepted++
    }
    return accepted
  }
  connectNeighbourhoodStreets()

  // A dry demand field identifies missing town blocks; it is never emitted as
  // a street lattice. The complete pavement still receives its ordinary width,
  // water, grade, acquisition and railway survey before any face can count.
  const urban = zones.filter(zone => zone.kind !== 'rural')
  const fieldSize = Math.max(75, Math.sqrt(width * height / 12000)), suitableRegions: PolygonRegion[] = []
  const suitableCell = (x: number, y: number, cellWidth: number, cellHeight: number) => {
    const middle = { x: x + cellWidth / 2, y: y + cellHeight / 2 }
    if (!urban.some(zone => pointInRegion(middle, zone))) return false
    for (const dx of [0, .5, 1]) for (const dy of [0, .5, 1]) {
      const point = { x: x + dx * cellWidth, y: y + dy * cellHeight }
      if (!landAvailable(point) || planner.waterAt(point) || (environment.terrain?.slope(point) ?? 0) > .13) return false
    }
    return true
  }
  for (let y = 12; y < height - 12; y += fieldSize) {
    const cellHeight = Math.min(fieldSize, height - 12 - y)
    let runStart: number | undefined, runEnd = 0
    for (let x = 12; x < width - 12; x += fieldSize) {
      const cellWidth = Math.min(fieldSize, width - 12 - x)
      if (suitableCell(x, y, cellWidth, cellHeight)) { runStart ??= x; runEnd = x + cellWidth }
      else if (runStart !== undefined) { suitableRegions.push({ polygon: rectangle(runStart, y, runEnd - runStart, cellHeight) }); runStart = undefined }
    }
    if (runStart !== undefined) suitableRegions.push({ polygon: rectangle(runStart, y, runEnd - runStart, cellHeight) })
  }
  // Actual surface track footprints split the proposal demand into its real
  // sides. A collector can close its own side instead of repeatedly asking for
  // a new nearby crossing; normal railway guards still own final acceptance.
  const railRegions = railways.filter(railway => railway.mode !== 'subway').flatMap(railway => railway.points.slice(1).map((point, i) => ({ polygon: corridorPolygon(railway.points[i]!, point, 3) })))
  const protectedLandRegions = [...(input.reservedRegions ?? []), ...environment.areas.filter(area => area.kind === 'water')]
  const excludedRegions = [...protectedLandRegions, ...railRegions]
  const coverageYears = [...new Set(urban.map(zone => zone.builtYear))].sort((a, b) => a - b)
  const coverageMasks = new Map(coverageYears.map(year => [year, createLayoutCoverageMask({ demandRegions: urban.filter(zone => zone.builtYear <= year), suitableRegions, excludedRegions })]))
  const coverageRecords: NonNullable<LayoutRoadDiagnostics['coverage']> = []
  diagnostics.coverage = coverageRecords
  const runCoveragePhase = (phase: 'before-fallback' | 'after-fallback', maximumAttempts: number) => {
    for (const year of coverageYears) {
      check()
      const mask = coverageMasks.get(year)!
      if (mask.area < 10000) continue
      const extra = { streetLength: 0, routeFailures: 0, guardFailures: 0, unchangedFaces: 0, surveyAttempts: [] as { from: Point; to: Point; through: Point; attempts: LayoutCoverageSurveyAttempt[]; rejectedInput?: string }[] }
      const isPublicContact = (anchor: LayoutCoverageAnchor, atYear: number) => graph.roads.some(road => road.id === anchor.roadId && road.builtYear <= atYear && road.width >= 4.6 && (road.level ?? 0) === 0 && !road.controlledAccess && road.role !== 'expressway' && road.role !== 'ramp' && road.points.slice(1).some((point, i) => distance(anchor.point, projectOnRoadSegment(anchor.point, road.points[i]!, point).point) < 1e-7))
      const pass = runLayoutCoveragePass({ builtYear: year, mask, phase, maximumAttempts, cellSize: fieldSize,
        readNetwork: () => { const roads = graph.roads.filter(road => road.builtYear <= year); return { roads, faces: extractStreetBlocks(roads) } },
        canAnchor: point => landAvailable(point) && planner.suitable(point, 8),
        tryAdoptWithFaceGain: (proposal, beforeFaces) => {
          check(); diagnostics.attempted++
          if (proposal.builtYear > year || !isPublicContact(proposal.from, year) || !isPublicContact(proposal.to, year)) { diagnostics.rejected++; extra.guardFailures++; return false }
          const startHeading = graph.junctionHeading(proposal.from.point, proposal.through), endHeading = graph.junctionHeading(proposal.to.point, proposal.through)
          const surveyed = surveyLayoutCoverageAlignment({ ...proposal, planner, builtYear: year, isPublicContact,
            elevation: environment.terrain?.elevation ?? (() => 0), rowAllows: avoidsReservations,
            ...(startHeading !== null ? { startHeading } : {}), ...(endHeading !== null ? { endHeading: endHeading + Math.PI } : {}) })
          extra.surveyAttempts.push({ from: proposal.from.point, to: proposal.to.point, through: proposal.through, attempts: surveyed.attempts, ...(surveyed.rejectedInput ? { rejectedInput: surveyed.rejectedInput } : {}) })
          const route = surveyed.route
          if (!route) { diagnostics.rejected++; extra.routeFailures++; return false }
          const points = canonicalSurvey(route, false)
          if (!points || distance(points[0]!, proposal.from.point) > 1e-7 || distance(points.at(-1)!, proposal.to.point) > 1e-7 || alignmentDiagnostics(points).minimumRadius < 50 - 1e-6 || !planner.validate(points, proposal.width) || !avoidsReservations(points, proposal.width) || !planner.railwayWidthAllows(points, .01, proposal.width, 'collector') || environment.terrain && !surveyedRoadGradeAllowed({ ...route, points }, .13, environment.terrain.elevation)) { diagnostics.rejected++; extra.guardFailures++; return false }
          // Only normalized, actually closed pavement earns dry-demand credit.
          // Same-era contacts are checked after canonical junction insertion.
          const staged = graph.fork()
          if (!staged.add(points, { id: 'coverage-trial', kind: 'local', role: 'collector', width: proposal.width, builtYear: year, phase: 'spatial-layout', reason: 'coverage trial', constructionCost: route.cost })) { extra.unchangedFaces++; return false }
          const gain = measureLayoutCoverageGain({ beforeFaces, afterFaces: extractStreetBlocks(staged.roads.filter(road => road.builtYear <= year)), mask, streetLength: roadLength(points) })
          if (!layoutCoverageHasPhysicalGain(gain)) { extra.unchangedFaces++; return false }
          const added = accept({ ...route, points }, 'collector', proposal.width, year, '未被覆の都市需要地を通り実公道へ戻る大街区の集散道路')
          if (!added) return false
          extra.streetLength += roadLength(added.points)
          return true
        },
      })
      coverageRecords.push({ ...pass, ...extra })
    }
  }
  runCoveragePhase('before-fallback', 2)

  // A single old street may genuinely leave an isolated neighbourhood with
  // no face at its opening date. Only that case receives an outer reach;
  // existing connected faces are never replaced by completed capsule stamps.
  const faceCache = new Map<number, Point[][]>()
  const facesAt = (year: number) => {
    let faces = faceCache.get(year)
    if (!faces) {
      // A large enclosure around a castle/campus is real, but cannot stand in
      // for the surrounding neighbourhood's usable street blocks. Its failed
      // first cut must not suppress the last isolated-frontage fallback.
      faces = extractStreetBlocks(graph.roads.filter(road => road.builtYear <= year)).filter(polygon => polygonArea(polygon) <= 600000 && !protectedLandRegions.some(region => polygonOverlapsRegion(polygon, region)))
      faceCache.set(year, faces)
    }
    return faces
  }
  for (const { zone, hub } of active.slice().sort((a, b) => a.zone.builtYear - b.zone.builtYear || a.zone.id.localeCompare(b.zone.id))) {
    if (zone.kind === 'rural' || layoutNeighborhoodHasStreetFace({ id: zone.id, point: hub, builtYear: zone.builtYear }, facesAt(zone.builtYear))) continue
    const anchors = openProjections(hub, zone.radius * 1.3, zone.builtYear, 32).filter(hit => hit.road.width >= 7.8 && roadLength(hit.road.points) >= 240)
    let changed = false
    for (const side of [-1, 1]) {
      let adopted = false
      for (const anchor of anchors.slice(0, 3)) {
        for (const fraction of [.86, .63, .42]) {
          const points = layoutFrontageLoop(anchor.road, anchor.point, zone.radius * 1.9, zone.radius * fraction, side)
          if (!points || !planner.validate(points, 7) || environment.terrain && !surveyedRoadGradeAllowed({ points }, .13, environment.terrain.elevation)) continue
          diagnostics.attempted++
          if (accept(planner.cost(points, 'collector'), 'collector', 7, zone.builtYear, '孤立した住区で旧道上の二つの接道点を結ぶ補完街路')) { adopted = true; changed = true; break }
        }
        if (adopted) break
      }
    }
    if (changed) faceCache.clear()
  }
  // Newly accepted isolated reaches can now supply separate frontage contacts
  // to their neighbours. This bounded second pass still creates no land until
  // its complete surveyed routes have been adopted by the real road graph.
  connectNeighbourhoodStreets()
  // Accepted fallback reaches now provide real contacts that the early survey
  // did not have. Recompute remaining dry demand after each adopted closure.
  runCoveragePhase('after-fallback', 4)

  const radii = active.map(item => item.zone.radius).sort((a, b) => a - b)
  const corridorSpacing = Math.max(380, Math.min(900, (radii[Math.floor(radii.length / 2)] ?? 600) * .9))
  const closestZone = (point: Point) => zones.filter(zone => pointInRegion(point, zone)).sort((a, b) => distance(a.center, point) / a.radius - distance(b.center, point) / b.radius)[0]
    ?? zones.slice().sort((a, b) => distance(a.center, point) - distance(b.center, point))[0]

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
    const frontages = polygon.flatMap((a, index) => {
      const b = polygon[(index + 1) % polygon.length]!, hit = graph.nearest(lerp(a, b, .5), .15)
      return hit ? [{ a, b, roadId: hit.road.id, width: hit.road.width, builtYear: hit.road.builtYear }] : []
    })
    for (let attempt = 0; attempt < 4; attempt++) {
      const split = planLayoutStreetFabricSplit({ polygon, zone, seed: `${input.seed}:face:${cursor}:${attempt}`, depth, frontages, terrain: environment.terrain })
      if (!split) break
      const from = graph.nearest(split.points[0]!, .08), to = graph.nearest(split.points.at(-1)!, .08)
      if (!from || !to) continue
      const year = Math.max(zone.builtYear, from.road.builtYear, to.road.builtYear)
      const points = split.points.map((point, index) => index === 0 ? from.point : index === split.points.length - 1 ? to.point : point)
      diagnostics.attempted++
      // Child faces describe this exact polyline. Validate its complete ROW;
      // replanning just the endpoints would invent a different street and lots.
      if (!planner.validate(points, split.width) || environment.terrain && !surveyedRoadGradeAllowed({ points }, .13, environment.terrain.elevation)) { diagnostics.rejected++; continue }
      const added = accept(planner.cost(points, 'lane'), 'lane', split.width, year, split.kind === 'readjusted' ? '平坦地の限られた一団で整えた街路' : split.kind === 'historic' ? '旧道の向きと地割に沿う短い街路' : '実在する周囲の道路へずらして接続する生活道路')
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
  const outsideSides = new Set<string>()
  for (const road of roads) if (road.boundaryContinuation) for (const point of [road.points[0]!, road.points.at(-1)!]) {
    if (point.x < 0) outsideSides.add('west'); if (point.x > width) outsideSides.add('east')
    if (point.y < 0) outsideSides.add('north'); if (point.y > height) outsideSides.add('south')
  }
  diagnostics.boundaryConnections = outsideSides.size
  // Final roads keep their actual opening phase. A weak spatial brief cannot
  // waive a longitudinal grade constraint at a later stage.
  if (environment.terrain) for (const road of roads) if (!road.bridge && !road.boundaryContinuation && !surveyedRoadGradeAllowed({ points: road.points }, road.role === 'highway' ? .09 : .13, environment.terrain.elevation)) throw new Error(`Layout road profile failed: ${road.id}`, { cause: { road, diagnostics } })
  return { roads, graph, blocks: extractStreetBlocks(roads), center, zones, diagnostics, bridgeSpans }
}

/** Ordinary public road length; controlled roads cannot create house frontage. */
export function layoutOrdinaryStreetLength(roads: readonly Road[]) {
  return roads.filter(road => !road.controlledAccess && road.role !== 'expressway' && road.role !== 'ramp').reduce((sum, road) => sum + roadLength(road.points), 0)
}
