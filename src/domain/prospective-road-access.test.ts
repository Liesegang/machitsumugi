import { describe, expect, it } from 'vitest'
import { frontageCapacity } from './frontage-supply'
import { PlanarRoadGraph } from './road-graph'
import { RoadPlanner } from './road-planner'
import { prospectiveRoadDistance, PROSPECTIVE_ROAD_REACH } from './prospective-road-access'

const existingStreet = () => {
  const graph = new PlanarRoadGraph()
  graph.add([{ x: 100, y: 100 }, { x: 900, y: 100 }], { id: 'existing', builtYear: 1900, width: 6, role: 'lane', kind: 'local', phase: 'railway', reason: '既存道路', constructionCost: 800 }, false)
  return graph
}

describe('prospective development road reach', () => {
  it('recognizes an unserved250m site without assigning frontage until a separately surveyed street is built', () => {
    const graph = existingStreet(), point = { x: 500, y: 350 }
    const cell = { capacity: 12, area: 7000, frontageDepth: 25 }
    // The old160m lookup erased this finite opportunity before the350/380m
    // project gates could appraise it, regardless of demand or available funds.
    expect(graph.nearest(point, 160)).toBeNull()
    expect(prospectiveRoadDistance(graph, point)).toBe(250)
    expect(frontageCapacity(cell, prospectiveRoadDistance(graph, point))).toBe(0)
    expect(graph.roads).toHaveLength(1)
    const planner = new RoadPlanner({ width: 1000, height: 800, core: null, areas: [] })
    const route = planner.plan({ x: 500, y: 100 }, point, { role: 'lane', width: 6 })!
    expect(route).not.toBeNull()
    expect(planner.validate(route.points, 6)).toBe(true)
    expect(route.cost).toBeGreaterThan(0)
    expect(frontageCapacity(cell, prospectiveRoadDistance(graph, point))).toBe(0)
    const fundedBudget = route.cost
    expect(graph.add(route.points, { id: 'funded-access', builtYear: 1960, width: 6, role: 'lane', kind: 'local', phase: 'suburban', reason: '未接道用地への測量・取得済み接続', constructionCost: fundedBudget })).not.toBeNull()
    expect(prospectiveRoadDistance(graph, point)).toBeCloseTo(0)
    expect(frontageCapacity(cell, prospectiveRoadDistance(graph, point))).toBeGreaterThan(0)
    expect(Number.isFinite(graph.travelTime({ x: 100, y: 100 }, point))).toBe(true)
    expect(graph.roads[0]!.builtYear).toBe(1900)
  })

  it('keeps the existing380m boundary instead of searching unlimited hinterland', () => {
    const graph = existingStreet()
    expect(PROSPECTIVE_ROAD_REACH).toBe(380)
    expect(prospectiveRoadDistance(graph, { x: 500, y: 479 })).toBe(379)
    expect(prospectiveRoadDistance(graph, { x: 500, y: 481 })).toBe(Infinity)
    expect(graph.roads).toHaveLength(1)
  })
})
