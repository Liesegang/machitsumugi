import { describe, expect, it } from 'vitest'
import { PlanarRoadGraph } from './road-graph'
import { RoadPlanner } from './road-planner'
import { investInNeighborhood, neighborhoodConnections } from './neighborhood-connections'
import { surveyNeighborhoodConnections } from './neighborhood-survey'

const a = { x: 200, y: 350 }, b = { x: 400, y: 350 }
function fixture() {
  const graph = new PlanarRoadGraph()
  graph.add([a, { x: 200, y: 900 }, { x: 400, y: 900 }, b], { id: 'old-detour', role: 'lane', kind: 'local', width: 5, builtYear: 1650, phase: 'regional', constructionCost: 1300, reason: 'old property access' }, false)
  const planner = new RoadPlanner({ width: 1200, height: 1200, areas: [], core: null })
  // Fully occupied existing frontage: no vacant capacity or future demand is
  // passed to this model, so a useful link cannot depend on new housing.
  const cells = [a, b].map(point => ({ point, households: 350, capacity: 350, area: 50000, frontageDepth: 20 }))
  return { graph, planner, cells, year: 1960, availableFunds: () => 4000, cache: new Map() }
}

describe('neighbourhood connectivity investment', () => {
  it('funds a physically connected shortcut for existing residents without new housing capacity', () => {
    const input = fixture(), project = [...neighborhoodConnections(input)][0]!
    expect(project).toBeDefined()
    expect(project.minutesSaved).toBeGreaterThan(0)
    expect(project.benefit).toBeGreaterThan(project.route.cost)
    expect(project.route.cost).toBeLessThanOrEqual(input.availableFunds())
    expect(input.planner.validate(project.route.points, project.width)).toBe(true)
    const before = input.graph.travelTime(a, b)
    expect(input.graph.add(project.route.points, { id: 'connection', role: 'lane', kind: 'local', width: project.width, builtYear: 1960, phase: 'suburban', constructionCost: project.route.cost, reason: 'paid detour reduction' })).not.toBeNull()
    expect(input.graph.travelTime(a, b)).toBeLessThan(before)
    expect([...neighborhoodConnections(input)]).toEqual([])
  })

  it('cannot draw speculative streets without residents or construction funds', () => {
    const input = fixture()
    expect([...neighborhoodConnections({ ...input, availableFunds: () => 0 })]).toEqual([])
    expect([...neighborhoodConnections({ ...input, cells: input.cells.map(cell => ({ ...cell, households: 0 })) })]).toEqual([])
  })

  it('keeps water barriers when an attractive local shortcut has no surveyed crossing', () => {
    const input = fixture()
    const planner = new RoadPlanner({ width: 1200, height: 1200, core: null, areas: [{ id: 'water', kind: 'water', polygon: [{ x: 250, y: 50 }, { x: 350, y: 50 }, { x: 350, y: 800 }, { x: 250, y: 800 }] }] })
    expect([...neighborhoodConnections({ ...input, planner })]).toEqual([])
  })
  it('funds a longer connection inside a large inhabited block from a finite resident levy without new-development income', () => {
    const graph = new PlanarRoadGraph(), a = { x: 200, y: 600 }, b = { x: 1000, y: 600 }
    graph.add([{ x: 200, y: 100 }, { x: 1000, y: 100 }, { x: 1000, y: 1100 }, { x: 200, y: 1100 }, { x: 200, y: 100 }], { id: 'inherited-block', builtYear: 1700, role: 'lane', kind: 'local', width: 5, phase: 'oldtown', reason: '旧街路', constructionCost: 3000 }, false)
    const cells = [a, b].map(point => ({ point, households: 350, area: 50000, frontageDepth: 20 }))
    expect(surveyNeighborhoodConnections({ graph, cells, maximumSpan: 300 }).some(survey => survey.chord > 300)).toBe(false)
    expect(surveyNeighborhoodConnections({ graph, cells }).some(survey => survey.chord > 700)).toBe(true)
    const planner = new RoadPlanner({ width: 1300, height: 1300, core: null, areas: [] }), before = graph.travelTime(a, b), developmentFees = 0, capital = 4000
    let serial = 0
    const investment = investInNeighborhood({ graph, planner, cells, year: 2020, funds: capital, cache: new Map(), commit: project => !!graph.add(project.route.points, { id: `connection-${serial++}`, builtYear: 2020, role: 'lane', kind: 'local', width: project.width, phase: 'suburban', reason: '既存住民による接続改善', constructionCost: project.route.cost }) })
    expect(investment.completed).toBeGreaterThan(0)
    expect(investment.spent).toBeGreaterThan(0)
    expect(investment.spent).toBeLessThanOrEqual(capital)
    expect(developmentFees).toBe(0)
    expect(graph.travelTime(a, b)).toBeLessThan(before)
    expect(graph.roadHistory.some(version => version.from === 2020)).toBe(true)
    expect(graph.roads.find(road => road.id === 'inherited-block')!.builtYear).toBe(1700)
  })
})
