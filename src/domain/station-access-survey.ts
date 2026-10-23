import { distance, projectPoint } from './geometry'
import type { Point, Road } from './types'
import type { RoadPlanner, PlannedRoute } from './road-planner'

const stationKey = (p: Point) => `${p.x.toFixed(5)},${p.y.toFixed(5)}`
export interface StationAccessSurvey { roads: Road[]; planner: RoadPlanner; routes: Map<string, PlannedRoute | null>; rejected: Point[]; attempts: number }
export function stationAccess(point: Point, survey: StationAccessSurvey) {
  const key = stationKey(point)
  if (survey.routes.has(key)) {
    const cached = survey.routes.get(key)!
    if (!cached || Number.isFinite(cached.cost) && survey.planner.validate(cached.points, 4, cached.bridgeLength > 0)) return cached
    survey.routes.delete(key)
  }
  const anchors: Point[] = []
  const projections = survey.roads.flatMap(road => road.points.slice(1).map((b, i) => projectPoint(point, road.points[i]!, b))).sort((a, b) => distance(a, point) - distance(b, point))
  for (const p of projections) if (distance(p, point) <= 1800 && anchors.every(a => distance(a, p) > 85)) { anchors.push(p); if (anchors.length >= 5) break }
  let route: PlannedRoute | null = null
  // A nearby second street can have a clear approach even when the nearest
  // street lies across a creek. Check every cheap straight approach before
  // spending a heading-state search on an obstructed first choice.
  for (const anchor of anchors) {
    if (distance(anchor, point) < 1e-7) { route = { points: [anchor, point], cost: 0, length: 0, bridgeLength: 0, method: 'direct' }; break }
    if (survey.planner.validate([anchor, point], 4)) {
      const candidate = survey.planner.cost([anchor, point], 'access')
      if (Number.isFinite(candidate.cost)) { route = candidate; break }
    }
  }
  if (!route) for (const anchor of anchors.slice(0, 3)) {
    route = survey.planner.plan(anchor, point, { role: 'access', width: 4, allowBridge: false, maxNodes: 6000 })
    if (route) break
  }
  if (!route) for (const anchor of anchors.slice(0, 2)) {
    route = survey.planner.plan(anchor, point, { role: 'access', width: 4, allowBridge: true, maxNodes: 9000 })
    if (route) break
  }
  survey.routes.set(key, route); return route
}
