import { describe, expect, it } from 'vitest'
import { PlanarRoadGraph } from './road-graph'
import { renewExistingRoad } from './road-renewal'

function graph() {
  const graph = new PlanarRoadGraph()
  graph.add([{ x: 0, y: 100 }, { x: 600, y: 100 }], { id: 'old', builtYear: 1700, width: 4, role: 'lane', kind: 'local', phase: 'oldtown', reason: '街道', constructionCost: 400 }, false)
  graph.add([{ x: 300, y: 100 }, { x: 300, y: 300 }], { id: 'branch', builtYear: 1800, width: 4, role: 'access', kind: 'local', phase: 'oldtown', reason: '生活道', constructionCost: 100 })
  return graph
}
const cost = (points: { x: number; y: number }[]) => ({ points, length: 600, cost: 600, bridgeLength: 0, method: 'direct' as const })
describe('funded road renewal', () => {
  it('upgrades inhabited old streets within capital funds and preserves their old width and junctions', () => {
    const roads = graph(), cells = [{ point: { x: 300, y: 120 }, households: 500 }]
    const result = renewExistingRoad({ graph: roads, planner: { validate: () => true, cost }, cells, year: 1955, funds: 5000 })
    expect(result).not.toBeNull()
    expect(result!.cost).toBeLessThan(5000)
    expect(roads.roadHistory.filter(v => v.value.id === 'old').map(v => [v.from, v.to, v.value.width])).toEqual([[1700, 1955, 4], [1955, undefined, 8]])
    expect(Number.isFinite(roads.travelTime({ x: 0, y: 100 }, { x: 300, y: 300 }))).toBe(true)
    expect(roads.modify('old', 1960, { points: [{ x: 0, y: 100 }, { x: 300, y: 0 }, { x: 600, y: 100 }], width: 8, reason: '付替え', constructionCost: 1000 })).toBeNull()
  })
  it('does not force an upgrade without demand, funding or a complete-width physical survey', () => {
    const roads = graph(), cells = [{ point: { x: 300, y: 120 }, households: 500 }]
    for (const input of [{ cells: [], funds: 5000, valid: true }, { cells, funds: 100, valid: true }, { cells, funds: 5000, valid: false }]) {
      expect(renewExistingRoad({ graph: roads, planner: { validate: () => input.valid, cost }, cells: input.cells, year: 1955, funds: input.funds })).toBeNull()
    }
    expect(roads.roadHistory).toHaveLength(2)
  })
})
