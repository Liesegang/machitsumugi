import { describe, expect, it } from 'vitest'
import { PlanarRoadGraph } from './road-graph'
import { RoadPlanner } from './road-planner'
import { transportProjects } from './transport-investment'

describe('public transport investment', () => {
  it('requires both funded real demand and a physical improvement over the inherited network', () => {
    const graph = new PlanarRoadGraph(), a = { x: 200, y: 350 }, b = { x: 1000, y: 350 }
    graph.add([a, { x: 200, y: 1100 }, { x: 1000, y: 1100 }, b], { id: 'inherited-valley-route', role: 'lane', kind: 'local', width: 5, builtYear: 1650, phase: 'regional', constructionCost: 2000, reason: 'existing detour' }, false)
    const planner = new RoadPlanner({ width: 1400, height: 1400, areas: [], core: null })
    const centers = [a, b].map(point => ({ point, kind: 'historic' as const, activeYear: 1650, weight: 1, catchment: 250 }))
    const cells = [a, b].map(point => ({ point, households: 500, capacity: 500, landValue: 1, roadDistance: 0, frontageDepth: 20 }))
    const input = { graph, planner, centers, cells, year: 1930, funds: 4000, arterial: true, completed: new Set<string>(), cache: new Map() }
    expect(transportProjects({ ...input, funds: 0 })).toEqual([])
    expect(transportProjects({ ...input, cells: cells.map(cell => ({ ...cell, households: 0 })) })).toEqual([])
    const project = transportProjects(input)[0]!
    expect(project).toBeDefined()
    expect(project.width).toBeGreaterThan(5)
    expect(project.role).toBe('collector')
    expect(project.minutesSaved).toBeGreaterThan(0)
    expect(planner.validate(project.route.points, project.width)).toBe(true)
    expect(project.benefit).toBeGreaterThan(project.route.cost)
    expect(project.route.cost).toBeLessThanOrEqual(input.funds)
    input.completed.add(project.pair)
    expect(transportProjects(input)).toEqual([])
  })
})
