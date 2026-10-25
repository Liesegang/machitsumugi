import type { Point, Railway } from './types'
import type { LayoutFirstZone } from './layout-first-types'
import type { PlannedRoute, PlanningEnvironment } from './road-planner'
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
    const candidates = (environment.terrain.bridgeCandidates ?? []).filter(candidate => distanceToSegment(candidate.point, first, last) < Math.min(width, height) * .22)
      .sort((a, b) => distanceToSegment(a.point, first, last) - distanceToSegment(b.point, first, last))
    const crossings = candidates.filter((candidate, i) => !candidates.slice(0, i).some(other => distance(candidate.point, other.point) < 280)).slice(0, 14)
    const terrain = { ...environment.terrain, bridgeSites: crossings.map(crossing => crossing.point), bridgeCandidates: crossings }
    const planner = new RegionalRoadPlanner({ ...environment, terrain, bridgeSites: terrain.bridgeSites })
    planner.setRailwayCorridors(input.railways)
    const from = planner.boundaryPortals(center, { width: roadWidth, preferred: first, maxCandidates: 2 })
    const to = planner.boundaryPortals(center, { width: roadWidth, preferred: last, maxCandidates: 2 })
    const pairs = from.flatMap(start => to.map(goal => ({ start, goal, distance: distance(start, center) + distance(center, goal) }))).sort((a, b) => a.distance - b.distance).slice(0, 2)
    for (const { start, goal } of pairs) {
        const route = planner.plan(start, goal, { role: 'highway', width: roadWidth, through: center, allowBridge: true, maximumGrade: .09, maxNodes: 4200 })
        if (!route || route.length > distance(start, goal) * 1.8 || alignmentDiagnostics(route.points).minimumRadius < 75 || !planner.validate(route.points, roadWidth, route.bridgeLength > 0)) continue
        const proposal = { id: `layout-main-corridor-${index + 1}`, route, width: roadWidth, builtYear: 1650 }
        if (!adopt(proposal)) continue
        result.push(proposal); break
    }
  }
  return result
}
