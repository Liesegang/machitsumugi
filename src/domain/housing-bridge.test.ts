import { describe, expect, it } from 'vitest'
import { PlanarRoadGraph } from './road-graph'
import { RoadPlanner } from './road-planner'
import { planHousingCollectorBridge } from './transport-investment'
import { createRoadProjectCache } from './road-project-cache'
import { rectangle } from './geometry'

function fixture() {
  const waterAt = (p: { x: number }) => p.x >= 390 && p.x <= 410
  const graph = new PlanarRoadGraph()
  graph.add([{ x: 200, y: 250 }, { x: 200, y: 750 }], { id: 'inhabited-bank', role: 'lane', kind: 'local', width: 5, builtYear: 1800, phase: 'historic', reason: 'existing road', constructionCost: 500 }, false)
  const terrain = { elevation: () => 10, slope: () => 0, waterAt, seaAt: () => false, bridgeSites: [{ x: 400, y: 500 }], bridgeCandidates: [{ point: { x: 400, y: 500 }, bankA: { x: 345, y: 500 }, bankB: { x: 455, y: 500 }, width: 20, cost: 100 }] }
  const planner = new RoadPlanner({ width: 1000, height: 1000, areas: [{ id: 'river', kind: 'water', polygon: rectangle(390, 0, 20, 1000) }], core: null, terrain })
  return { graph, planner, year: 1955, settlement: 'regional-city', funds: 3000, unmet: 200, start: { x: 200, y: 500 }, goal: { x: 650, y: 500 }, site: { x: 600, y: 500 }, oppositeBankSupply: 130, occupied: [{ point: { x: 220, y: 510 }, households: 40 }], cache: new Map() }
}

describe('housing-frontier collector bridge survey', () => {
  it('can survey a modest bridge to viable opposite-bank supply while ordinary frontage roads remain dry', () => {
    const input = fixture(), before = JSON.stringify(input.graph.roads)
    expect(createRoadProjectCache(input.planner, () => input.funds)(input.start, input.goal, 'access', 4.6)).toBeNull()
    const route = planHousingCollectorBridge(input)!
    expect(route).not.toBeNull(); expect(route.bridgeLength).toBeCloseTo(20, 2)
    expect(route.surveyedBridgeSpans).toHaveLength(1); expect(route.cost).toBeLessThan(input.funds)
    expect(input.planner.validate(route.points, 6.5, true)).toBe(true)
    expect(route.length).toBeLessThanOrEqual(720)
    expect(JSON.stringify(input.graph.roads)).toBe(before)
  })
  it('requires affordable demand, occupied approach and a sufficiently large developable district', () => {
    const input = fixture()
    for (const patch of [{ funds: 0 }, { oppositeBankSupply: 89 }, { unmet: 19 }, { occupied: [] }, { year: 1850 }, { settlement: 'village' }]) expect(planHousingCollectorBridge({ ...input, ...patch })).toBeNull()
    expect(input.cache.size).toBe(0)
  })
  it('keeps hillside, sea, unsurveyed and existing-bridge protections', () => {
    const input = fixture(), original = input.planner.environment.terrain!
    input.planner.environment.terrain = { ...original, slope: () => .15 }
    expect(planHousingCollectorBridge(input)).toBeNull()
    input.planner.environment.terrain = { ...original, seaAt: () => true }
    expect(planHousingCollectorBridge(input)).toBeNull()
    input.planner.environment.terrain = { ...original, bridgeCandidates: [] }
    expect(planHousingCollectorBridge(input)).toBeNull()
    input.planner.environment.terrain = original
    input.graph.add([{ x: 345, y: 600 }, { x: 455, y: 600 }], { id: 'existing-bridge', role: 'bridge', bridge: true, width: 6.5, kind: 'local', builtYear: 1900, phase: 'railway', reason: 'existing crossing', constructionCost: 1000 }, false)
    expect(planHousingCollectorBridge(input)).toBeNull()
  })
})
