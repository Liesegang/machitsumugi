import type { Point } from './types'
import type { RoadRole } from './road-graph'
import type { PlannedRoute } from './road-planner'

export interface SurveyedProjectChunk { path: Point[]; bridge: boolean; reused: boolean }

/** Price actual new works, including each new deck's fixed construction cost.
 * Reusing a bridge cannot transfer its water/overhead costs onto dry approaches.
 * The original appraisal may additionally include acquisition or another
 * nonphysical uplift; retain that once, shared only among new physical works.
 */
export function surveyedProjectCost(input: {
  route: PlannedRoute
  role: RoadRole
  chunks: readonly SurveyedProjectChunk[]
  surveyCost: (path: Point[], role: RoadRole, bridge: boolean) => PlannedRoute
}): { costs: number[]; newTotal: number } {
  const { route, role, chunks, surveyCost } = input
  const costs = chunks.map(chunk => chunk.reused ? 0 : surveyCost(chunk.path, role, chunk.bridge).cost)
  const firstNew = chunks.findIndex(chunk => !chunk.reused)
  if (firstNew < 0) return { costs, newTotal: 0 }
  const fullPhysical = surveyCost(route.points, role, chunks.some(chunk => chunk.bridge)).cost
  // Invalid surveys remain unaffordable; never turn a nonfinite difference into
  // zero-credit construction. The transaction still owns physical validation.
  if (!Number.isFinite(route.cost) || route.cost < 0 || !Number.isFinite(fullPhysical) || fullPhysical < 0 || costs.some(cost => !Number.isFinite(cost) || cost < 0)) {
    costs[firstNew] = Infinity
    return { costs, newTotal: Infinity }
  }
  const physicalTotal = costs.reduce((sum, cost) => sum + cost, 0)
  const uplift = Math.max(0, route.cost - fullPhysical)
  if (physicalTotal > 0) {
    // Only the uplift is apportioned. Water length, fixed deck costs, earthwork
    // and railway work have already been surveyed on their actual new chunks.
    for (let i = 0; i < costs.length; i++) costs[i]! += uplift * costs[i]! / physicalTotal
  } else costs[firstNew]! += uplift
  return { costs, newTotal: physicalTotal + uplift }
}
