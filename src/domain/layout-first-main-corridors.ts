import type { Point, Railway } from './types'
import type { LayoutFirstZone } from './layout-first-types'
import type { PlannedRoute, PlanningEnvironment, PlanningOptions } from './road-planner'
import { RegionalRoadPlanner } from './regional-road-planner'
import { alignmentDiagnostics } from './road-alignment'
import { distance, distanceToSegment } from './geometry'

export interface LayoutMainCorridor {
  id: string
  route: PlannedRoute
  width: number
  builtYear: number
}
export interface LayoutMainCorridorInput {
  environment: PlanningEnvironment
  center: Point
  zones: readonly LayoutFirstZone[]
  railways: Railway[]
  signal?: AbortSignal
}
type MainAlignmentPlanner = Pick<RegionalRoadPlanner, 'plan' | 'validate'>

const angleDifference = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle))

/** Both halves receive a common centre tangent before either is surveyed.
 * A cheapest western approach cannot impose an impossible eastern departure. */
export function layoutMainCorridorTangents(start: Point, center: Point, goal: Point): number[] {
  const incoming = Math.atan2(center.y - start.y, center.x - start.x), outgoing = Math.atan2(goal.y - center.y, goal.x - center.x)
  const bearing = incoming + angleDifference(outgoing - incoming) / 2
  return [0, -Math.PI / 6, Math.PI / 6].map(offset => angleDifference(bearing + offset))
}

/** Joint tangent proposals are finite. Every leg uses the ordinary physical
 * planner, and the full assembled pavement must retain its highway radius. */
export function planLayoutMainCorridorAlignment(planner: MainAlignmentPlanner, start: Point, center: Point, goal: Point, width: number): PlannedRoute | null {
  const leg = (a: Point, b: Point, heading: Pick<PlanningOptions, 'startHeading' | 'endHeading'>) => {
    const options: PlanningOptions = { role: 'highway', width, allowBridge: true, maximumGrade: .09, maxNodes: 16000, ...heading }
    // Geographic distance can understate a necessary tributary detour. The
    // single retry raises only the finite search allowance, never a guard.
    return planner.plan(a, b, { ...options, maxNodesPerKm: 1800 }) ?? planner.plan(a, b, options)
  }
  for (const tangent of layoutMainCorridorTangents(start, center, goal)) {
    const first = leg(start, center, { endHeading: tangent })
    if (!first) continue
    const second = leg(center, goal, { startHeading: tangent })
    if (!second || distance(first.points.at(-1)!, center) > 1e-7 || distance(second.points[0]!, center) > 1e-7) continue
    const points = [...first.points, ...second.points.slice(1)], bridgeLength = first.bridgeLength + second.bridgeLength
    if (first.length + second.length > distance(start, goal) * 1.8 || alignmentDiagnostics(points).minimumRadius < 85 || !planner.validate(points, width, bridgeLength > 0)) continue
    const surveyedBridgeSpans = [...(first.surveyedBridgeSpans ?? []), ...(second.surveyedBridgeSpans ?? [])]
    // Preserve actual surveyed bridge costs/decks rather than re-costing their
    // joined samples as an ordinary dry route or charging the crossings twice.
    return { points, length: first.length + second.length, cost: first.cost + second.cost, bridgeLength, method: bridgeLength > 0 ? 'bridge-project' : 'heading-search', ...(surveyedBridgeSpans.length ? { surveyedBridgeSpans } : {}) }
  }
  return null
}

/** Nearby tributaries are different water barriers. Deduplicate alternatives
 * only within the same actual river, and retain each river before extra sites. */
export function selectLayoutMainBridgeCandidates<T extends { point: Point; riverId?: string }>(candidates: readonly T[], first: Point, last: Point, reach: number, limit = 24): T[] {
  const ranked = candidates.filter(candidate => distanceToSegment(candidate.point, first, last) < reach).slice().sort((a, b) => distanceToSegment(a.point, first, last) - distanceToSegment(b.point, first, last))
  const distinct: T[] = []
  for (const candidate of ranked) if (!distinct.some(other => candidate.riverId !== undefined && other.riverId === candidate.riverId && distance(candidate.point, other.point) < 280)) distinct.push(candidate)
  const rivers = new Set<string>(), firstSites: T[] = []
  for (const [index, candidate] of distinct.entries()) { const river = candidate.riverId ?? `untagged-${index}`; if (!rivers.has(river)) { rivers.add(river); firstSites.push(candidate) } }
  return [...firstSites, ...distinct.filter(candidate => !firstSites.includes(candidate))].slice(0, limit)
}

/** Demand supplies a regional direction, never rows or a spacing lattice. */
export function layoutMainCorridorBearings(zones: readonly LayoutFirstZone[], center: Point): number[] {
  const points = zones.filter(zone => zone.kind !== 'rural')
  let xx = 0, xy = 0, yy = 0
  for (const zone of points) {
    const x = zone.center.x - center.x, y = zone.center.y - center.y, weight = Math.max(.1, zone.density) * Math.min(800, zone.radius)
    xx += x * x * weight; xy += x * y * weight; yy += y * y * weight
  }
  const primary = points.length > 1 ? Math.atan2(2 * xy, xx - yy) / 2 : 0
  return [primary, primary + Math.PI / 2]
}

/** A complete through alignment is surveyed before household streets exist.
 * The same canonical pavement crosses the town and joins two outside portals;
 * no path over a later street mesh is promoted to manufacture this road. */
export function surveyLayoutMainCorridors(input: LayoutMainCorridorInput, adopt: (proposal: LayoutMainCorridor) => boolean): LayoutMainCorridor[] {
  const { environment, center } = input, { width, height } = environment
  if (!environment.terrain?.continuationTerrain) return []
  const result: LayoutMainCorridor[] = [], roadWidth = 12
  const edge = (angle: number) => {
    const dx = Math.cos(angle), dy = Math.sin(angle)
    const tx = dx > 1e-6 ? (width - center.x) / dx : dx < -1e-6 ? -center.x / dx : Infinity
    const ty = dy > 1e-6 ? (height - center.y) / dy : dy < -1e-6 ? -center.y / dy : Infinity
    const t = Math.min(tx, ty)
    return { x: center.x + dx * t, y: center.y + dy * t }
  }
  for (const [index, angle] of layoutMainCorridorBearings(input.zones, center).entries()) {
    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException('Generation cancelled', 'AbortError')
    const first = edge(angle + Math.PI), last = edge(angle)
    // Limit the lazy bridge graph to surveyed crossings in this geographic
    // corridor. A distant valley must not become a cheap accidental detour.
    const crossings = selectLayoutMainBridgeCandidates(environment.terrain.bridgeCandidates ?? [], first, last, Math.min(width, height) * .22)
    const terrain = { ...environment.terrain, bridgeSites: crossings.map(crossing => crossing.point), bridgeCandidates: crossings }
    const planner = new RegionalRoadPlanner({ ...environment, terrain, bridgeSites: terrain.bridgeSites })
    planner.setRailwayCorridors(input.railways)
    const from = planner.boundaryPortals(center, { width: roadWidth, preferred: first, maxCandidates: 2 })
    const to = planner.boundaryPortals(center, { width: roadWidth, preferred: last, maxCandidates: 2 })
    const pairs = from.flatMap(start => to.map(goal => ({ start, goal, distance: distance(start, center) + distance(center, goal) }))).sort((a, b) => a.distance - b.distance).slice(0, 2)
    for (const { start, goal } of pairs) {
        const route = planLayoutMainCorridorAlignment(planner, start, center, goal, roadWidth)
        if (!route) continue
        const proposal = { id: `layout-main-corridor-${index + 1}`, route, width: roadWidth, builtYear: 1650 }
        if (!adopt(proposal)) continue
        result.push(proposal); break
    }
  }
  return result
}
