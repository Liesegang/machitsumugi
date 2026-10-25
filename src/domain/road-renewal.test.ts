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
  it('can acquire and widen a former farm route when actual urban traffic funds a collector, preserving its original history', () => {
    const makeFarm = () => {
      const roads = new PlanarRoadGraph()
      roads.add([{ x: 0, y: 100 }, { x: 600, y: 100 }], { id: 'inherited-farm', builtYear: 1650, width: 3.2, role: 'farm', kind: 'local', phase: 'regional', reason: '耕地への道', constructionCost: 300 }, false)
      return roads
    }
    const input = { planner: { validate: () => true, railwayWidthAllows: () => true, cost }, cells: [{ point: { x: 590, y: 100 }, households: 1400 }], destinations: [{ point: { x: 0, y: 100 }, weight: 1 }], year: 1955, funds: 8000 }
    const roads = makeFarm(), renewed = renewExistingRoad({ ...input, graph: roads })
    expect(renewed).not.toBeNull()
    expect(renewed!.road.role).toBe('collector')
    expect(renewed!.cost).toBeGreaterThan(0)
    expect(roads.roadHistory.map(version => [version.from, version.to, version.value.role, version.value.width])).toEqual([[1650, 1955, 'farm', 3.2], [1955, undefined, 'collector', 9.5]])
    for (const override of [{ cells: [] }, { funds: 1 }, { planner: { ...input.planner, validate: () => false } }]) expect(renewExistingRoad({ ...input, ...override, graph: makeFarm() })).toBeNull()
  })
  it('upgrades inhabited old streets within capital funds and preserves their old width and junctions', () => {
    const roads = graph(), cells = [{ point: { x: 590, y: 100 }, households: 1400 }]
    const result = renewExistingRoad({ graph: roads, planner: { validate: () => true, railwayWidthAllows: () => true, cost }, cells, destinations: [{ point: { x: 0, y: 100 }, weight: 1 }], year: 1955, funds: 5000 })
    expect(result).not.toBeNull()
    expect(result!.cost).toBeLessThan(5000)
    expect(roads.roadHistory.filter(v => v.value.id === 'old').map(v => [v.from, v.to, v.value.width])).toEqual([[1700, 1955, 4], [1955, undefined, 9.5]])
    expect(Number.isFinite(roads.travelTime({ x: 0, y: 100 }, { x: 300, y: 300 }))).toBe(true)
    expect(roads.modify('old', 1960, { points: [{ x: 0, y: 100 }, { x: 300, y: 0 }, { x: 600, y: 100 }], width: 8, reason: '付替え', constructionCost: 1000 })).toBeNull()
  })
  it('does not force an upgrade without demand, funding or a complete-width physical survey', () => {
    const roads = graph(), cells = [{ point: { x: 300, y: 120 }, households: 500 }]
    for (const input of [{ cells: [], funds: 5000, valid: true }, { cells, funds: 100, valid: true }, { cells, funds: 5000, valid: false }]) {
      expect(renewExistingRoad({ graph: roads, planner: { validate: () => input.valid, railwayWidthAllows: () => true, cost }, cells: input.cells, destinations: [{ point: { x: 0, y: 100 }, weight: 1 }], year: 1955, funds: input.funds })).toBeNull()
    }
    expect(roads.roadHistory).toHaveLength(2)
  })

  it('widens the connected traffic corridor across old road identities without selecting a nearby unloaded branch', () => {
    const roads = new PlanarRoadGraph()
    for (let i = 0; i < 3; i++) roads.add([{ x: i * 600, y: 100 }, { x: (i + 1) * 600, y: 100 }], { id: `section-${i}`, builtYear: 1700, width: 4, role: 'lane', kind: 'local', phase: 'oldtown', reason: '旧道', constructionCost: 300 }, false)
    roads.add([{ x: 600, y: 100 }, { x: 600, y: 500 }], { id: 'unloaded-branch', builtYear: 1800, width: 4, role: 'lane', kind: 'local', phase: 'oldtown', reason: '脇道', constructionCost: 300 })
    const result = renewExistingRoad({ graph: roads, planner: { validate: () => true, railwayWidthAllows: () => true, cost }, cells: [{ point: { x: 1790, y: 100 }, households: 2400 }], destinations: [{ point: { x: 0, y: 100 }, weight: 1 }], year: 1955, funds: 20000 })
    expect(result!.roads.map(r => r.id).sort()).toEqual(['section-0', 'section-1', 'section-2'])
    expect(roads.roads.find(r => r.id === 'unloaded-branch')!.width).toBe(4)
    for (const i of [0, 1, 2]) expect(roads.roadHistory.filter(v => v.value.id === `section-${i}`).map(v => [v.from, v.to, v.value.width])).toEqual([[1700, 1955, 4], [1955, undefined, 9.5]])
  })

  it('allows a genuinely loaded short bottleneck only in terminal actual-stock policy, preserving historical defaults and finite funds', () => {
    const makeGraph = () => {
      const roads = new PlanarRoadGraph()
      roads.add([{ x: 100, y: 100 }, { x: 200, y: 100 }], { id: 'short-loaded', builtYear: 1700, width: 4, role: 'lane', kind: 'local', phase: 'oldtown', reason: '既存の狭い区間', constructionCost: 100 }, false)
      return roads
    }
    const input = { planner: { validate: () => true, railwayWidthAllows: () => true, cost }, cells: [{ point: { x: 195, y: 100 }, households: 1400 }], destinations: [{ point: { x: 100, y: 100 }, weight: 1 }], year: 2025, funds: 5000 }
    expect(renewExistingRoad({ ...input, graph: makeGraph() })).toBeNull()
    const roads = makeGraph(), result = renewExistingRoad({ ...input, graph: roads, actualStock: true })!
    expect(result).not.toBeNull()
    expect(result.cost).toBeLessThanOrEqual(input.funds)
    expect(result.road.width).toBeGreaterThan(4)
    expect(roads.roadHistory.map(v => [v.from, v.to, v.value.width])).toEqual([[1700, 2025, 4], [2025, undefined, result.road.width]])
    expect(renewExistingRoad({ ...input, graph: makeGraph(), actualStock: true, funds: 1 })).toBeNull()
    expect(renewExistingRoad({ ...input, graph: makeGraph(), actualStock: true, cells: [] })).toBeNull()
  })
})
