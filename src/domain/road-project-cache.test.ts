import { describe, expect, it, vi } from 'vitest'
import { createRoadProjectCache } from './road-project-cache'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute } from './road-planner'

const start = { x: 0, y: 0 }, goal = { x: 100, y: 0 }
const route: PlannedRoute = { points: [start, goal], cost: 100, length: 100, bridgeLength: 0, method: 'direct' }

describe('budgeted road project cache', () => {
  it('replans physically different widths while reusing identical surveys', () => {
    const plan = vi.fn<RoadPlanner['plan']>(() => route), cached = createRoadProjectCache({ plan }, () => 1000)
    cached(start, goal, 'lane', 3.5)
    cached(start, goal, 'lane', 3.5)
    cached(start, goal, 'lane', 6)
    expect(plan).toHaveBeenCalledTimes(2)
    expect(plan.mock.calls.map(call => call[2].width)).toEqual([3.5, 6])
  })
  it('skips unaffordable lower bounds and retries after funding changes', () => {
    let budget = 50
    const plan = vi.fn<RoadPlanner['plan']>(() => route), cached = createRoadProjectCache({ plan }, () => budget)
    expect(cached(start, goal, 'lane', 5)).toBeNull()
    expect(plan).not.toHaveBeenCalled()
    budget = 150
    expect(cached(start, goal, 'lane', 5)).toBe(route)
    expect(plan).toHaveBeenCalledTimes(1)
    budget = 0
    expect(cached(start, goal, 'lane', 5)).toBeNull()
    budget = 150
    expect(cached(start, goal, 'lane', 5)).toBe(route)
    expect(plan).toHaveBeenCalledTimes(1)
  })
  it('never reuses a narrow road through land too narrow for the requested width', () => {
    const rectangle = (y0: number, y1: number) => [{ x: 0, y: y0 }, { x: 300, y: y0 }, { x: 300, y: y1 }, { x: 0, y: y1 }]
    const planner = new RoadPlanner({ width: 300, height: 200, core: null, areas: [
      { id: 'upper-water', kind: 'water', polygon: rectangle(0, 97.5) },
      { id: 'lower-water', kind: 'water', polygon: rectangle(102.5, 200) },
    ] })
    const cached = createRoadProjectCache(planner, () => 1000), a = { x: 40, y: 100 }, b = { x: 260, y: 100 }
    expect(cached(a, b, 'lane', 3.5, undefined, true)).not.toBeNull()
    expect(cached(a, b, 'lane', 6, undefined, true)).toBeNull()
  })
})
