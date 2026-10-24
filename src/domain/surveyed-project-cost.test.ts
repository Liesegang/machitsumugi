import { describe, expect, it, vi } from 'vitest'
import { surveyedProjectCost } from './surveyed-project-cost'
import type { PlannedRoute } from './road-planner'
import type { RoadRole } from './road-graph'
import type { Point } from './types'

const path = (from: number, to: number) => [{ x: from, y: 0 }, { x: to, y: 0 }]
const original = (cost = 2620): PlannedRoute => ({ points: path(0, 1000), length: 1000, cost, bridgeLength: 100, method: 'bridge-project' })
// A real nonlinear construction schedule: the final100m lie in water and
// each surveyed new bridge project has a fixed420-credit deck establishment.
const surveyCost = (points: Point[], _role: RoadRole, bridge: boolean): PlannedRoute => {
  const first = points[0]!.x, last = points.at(-1)!.x, length = Math.abs(last - first)
  const wet = bridge ? Math.max(0, Math.min(1000, Math.max(first, last)) - Math.max(900, Math.min(first, last))) : 0
  return { points, length, cost: length - wet + wet * 13 + (wet > 0 ? 420 : 0), bridgeLength: wet, method: 'direct' }
}
const chunks = (reused = true) => [{ path: path(0, 900), bridge: false, reused: false }, { path: path(900, 1000), bridge: true, reused }]

describe('surveyed new project construction cost', () => {
  it('charges900m of new dry road without smearing a reused bridge cost into its approaches', () => {
    expect(surveyedProjectCost({ route: original(), role: 'lane', chunks: chunks(), surveyCost })).toEqual({ costs: [900, 0], newTotal: 900 })
  })

  it('retains additional acquisition once on new work and never charges a reused deck', () => {
    expect(surveyedProjectCost({ route: original(2720), role: 'lane', chunks: chunks(), surveyCost })).toEqual({ costs: [1000, 0], newTotal: 1000 })
  })

  it('resurveys all-new dry and bridge work at the actual physical costs', () => {
    expect(surveyedProjectCost({ route: original(), role: 'lane', chunks: chunks(false), surveyCost })).toEqual({ costs: [900, 1720], newTotal: 2620 })
    const priced = surveyedProjectCost({ route: original(2720), role: 'lane', chunks: chunks(false), surveyCost })
    expect(priced.newTotal).toBe(2720)
    expect(priced.costs.reduce((a, b) => a + b, 0)).toBeCloseTo(2720, 10)
    expect(priced.costs[0]).toBeGreaterThan(900)
    expect(priced.costs[1]).toBeGreaterThan(1720)
  })

  it('charges nothing for a wholly reused project, including acquisition uplift', () => {
    const survey = vi.fn(surveyCost)
    expect(surveyedProjectCost({ route: original(2720), role: 'lane', chunks: chunks().map(chunk => ({ ...chunk, reused: true })), surveyCost: survey })).toEqual({ costs: [0, 0], newTotal: 0 })
    expect(survey).not.toHaveBeenCalled()
  })

  it('does not turn a stale discounted appraisal or invalid survey into free physical construction', () => {
    expect(surveyedProjectCost({ route: original(500), role: 'lane', chunks: chunks(false), surveyCost }).newTotal).toBe(2620)
    const invalid = surveyedProjectCost({ route: original(), role: 'lane', chunks: chunks(), surveyCost: (points, role, bridge) => ({ ...surveyCost(points, role, bridge), cost: Infinity }) })
    expect(invalid.newTotal).toBe(Infinity)
    expect(invalid.costs[0]).toBe(Infinity)
    expect(invalid.costs[1]).toBe(0)
  })
})
