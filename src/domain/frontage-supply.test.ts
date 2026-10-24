import { describe, expect, it } from 'vitest'
import { frontageCapacity } from './frontage-supply'
import { PlanarRoadGraph } from './road-graph'
import { RoadPlanner } from './road-planner'

describe('actual frontage service capacity', () => {
  it('counts only land in the accessible frontage band instead of an entire coarse opportunity cell', () => {
    const cell = { capacity: 20, area: Math.PI * 100 ** 2, frontageDepth: 50 }
    expect(frontageCapacity(cell, 0)).toBe(12)
    expect(frontageCapacity(cell, 100)).toBe(3)
    expect(frontageCapacity(cell, 151)).toBe(0)
    expect(frontageCapacity(cell, Infinity)).toBe(0)
    expect(frontageCapacity(cell, 10)).toBeLessThan(cell.capacity)
  })
  it('opens genuinely unserved inner land through a funded connected street while retaining the original perimeter', () => {
    const graph = new PlanarRoadGraph(), points = [{ x: 100, y: 100 }, { x: 700, y: 100 }, { x: 700, y: 700 }, { x: 100, y: 700 }, { x: 100, y: 100 }]
    graph.add(points, { id: 'perimeter', builtYear: 1900, width: 6, role: 'lane', kind: 'local', phase: 'railway', reason: '既存道路', constructionCost: 2400 }, false)
    const planner = new RoadPlanner({ width: 900, height: 900, core: null, areas: [] })
    const cells = Array.from({ length: 9 }, (_, i) => ({ point: { x: 200 + i * 50, y: 400 }, capacity: 12, area: 7000, frontageDepth: 25 }))
    const before = cells.reduce((sum, cell) => sum + frontageCapacity(cell, graph.nearest(cell.point)!.distance), 0)
    const route = planner.plan({ x: 100, y: 400 }, { x: 700, y: 400 }, { role: 'lane', width: 6, alignment: 'planned' })!
    const served = cells.reduce((sum, cell) => sum + frontageCapacity(cell, 0), 0)
    expect(before).toBe(0)
    expect(served * 36).toBeGreaterThan(route.cost)
    expect(route.cost).toBeLessThan(1500)
    expect(graph.add(route.points, { id: 'inner', builtYear: 1955, width: 6, role: 'lane', kind: 'local', phase: 'suburban', reason: '未充足需要の沿道用地への接続', constructionCost: route.cost })).not.toBeNull()
    expect(cells.every(cell => graph.nearest(cell.point)!.distance < .1)).toBe(true)
    expect(graph.roads[0]!.builtYear).toBe(1900)
    expect(Number.isFinite(graph.travelTime(points[0]!, cells[4]!.point))).toBe(true)
  })
})
