import { describe, expect, it } from 'vitest'
import { RoadPlanner } from './road-planner'
import { RegionalRoadPlanner } from './regional-road-planner'
import { PlanarRoadGraph } from './road-graph'
import { alignmentDiagnostics } from './road-alignment'
import { planModernTransport } from './modern-transport'

describe('regional modern transport programme', () => {
  const flat = { elevation: () => 0, slope: () => 0, waterAt: () => false }
  function fixture() {
    const environment = { width: 4000, height: 3000, areas: [], core: null, terrain: { ...flat, bridgeSites: [], continuationTerrain: flat } }
    const graph = new PlanarRoadGraph()
    graph.add([{ x: -324, y: 650 }, { x: 850, y: 650 }, { x: 850, y: 2650 }, { x: 4324, y: 2650 }], { id: 'inherited-regional', builtYear: 1650, phase: 'regional', role: 'highway', reason: 'old detour connecting neighbouring towns', width: 13, kind: 'arterial', constructionCost: 10000, boundaryContinuation: true }, false)
    return { graph, planner: new RoadPlanner(environment), regionalPlanner: new RegionalRoadPlanner(environment), width: 4000, height: 3000 }
  }
  it('plans a funded controlled mainline with physical slip roads rather than connecting every crossover', () => {
    const input = fixture()
    const project = planModernTransport({ ...input, kind: 'expressway', households: 30000, jobs: 15000, funds: 1e7 })
    expect(project).not.toBeNull()
    expect(project!.mainline.boundaryContinuation).toBe(true)
    expect(alignmentDiagnostics(project!.mainline.points).minimumRadius).toBeGreaterThan(239)
    expect(project!.accesses.filter(access => access.role === 'ramp')).toHaveLength(4)
    for (const access of project!.accesses) {
      expect(input.planner.validate(access.route.points, access.width)).toBe(true)
      expect(alignmentDiagnostics(access.route.points).minimumRadius).toBeGreaterThan(access.role === 'ramp' ? 59 : 49)
    }
    expect(project!.benefit).toBeGreaterThan(project!.cost)
    expect(project!.minutesSaved).toBeGreaterThan(0)
  })
  it('does not purchase a metropolitan corridor with village demand or an empty programme budget', () => {
    const input = fixture()
    expect(planModernTransport({ ...input, kind: 'expressway', households: 80, jobs: 30, funds: 2000 })).toBeNull()
    expect(planModernTransport({ ...input, kind: 'bypass', households: 30000, jobs: 15000, funds: 0 })).toBeNull()
  })
  it('can bound proposal surveys while retaining complete engineering checks', () => {
    const input = fixture()
    expect(planModernTransport({ ...input, kind: 'expressway', households: 30000, jobs: 15000, funds: 1e7, planningLimits: { maxPairs: 0 } })).toBeNull()
    const project = planModernTransport({ ...input, kind: 'expressway', households: 30000, jobs: 15000, funds: 1e7, planningLimits: { maxPairs: 2, maxAnchors: 3, maxDeltas: 3, maxNodes: 2400 } })
    expect(project).not.toBeNull()
    expect(project!.accesses.filter(access => access.role === 'ramp')).toHaveLength(4)
    expect(alignmentDiagnostics(project!.mainline.points).minimumRadius).toBeGreaterThan(239)
    expect(project!.benefit).toBeGreaterThan(project!.cost)
  })
})
