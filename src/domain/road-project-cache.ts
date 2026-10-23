import type { Point } from './types'
import type { RoadRole } from './road-graph'
import { roadConstructionFactor } from './road-planner'
import type { PlannedRoute, RoadPlanner } from './road-planner'

/** Geometry failures persist; a temporary lack of funds never poisons the cache. */
export function createRoadProjectCache(planner: Pick<RoadPlanner, 'plan'> & Partial<Pick<RoadPlanner, 'transportRevision'>>, availableFunds: () => number) {
  const cache = new Map<string, PlannedRoute | null>()
  return (a: Point, b: Point, role: RoadRole, width: number, through?: Point, planned = false): PlannedRoute | null => {
    // A smoothed 'through' corner need not pass the exact control point. The
    // chord, unlike the two control-polygon legs, is always a valid lower bound.
    const lowerBound = Math.hypot(b.x - a.x, b.y - a.y) * roadConstructionFactor(role)
    if (lowerBound > availableFunds()) return null
    const key = [planner.transportRevision ?? 0, a.x.toFixed(1), a.y.toFixed(1), b.x.toFixed(1), b.y.toFixed(1), role, width, through?.x.toFixed(1), through?.y.toFixed(1), planned].join(':')
    if (cache.has(key)) return cache.get(key)!
    const route = planner.plan(a, b, { role, width, ...(through ? { through } : {}), maxNodes: 2400, alignment: planned ? 'planned' : 'natural' })
    cache.set(key, route)
    return route
  }
}
