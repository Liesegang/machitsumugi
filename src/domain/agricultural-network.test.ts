import { describe, expect, it } from 'vitest'
import { surveyAgriculturalAccessProjects } from './agricultural-network'
import { PlanarRoadGraph } from './road-graph'
import { RoadPlanner } from './road-planner'
import type { RoadMetadata } from './road-graph'
import type { Area, Point } from './types'
import { rectangle } from './geometry'

const metadata = (id: string): RoadMetadata => ({ id, builtYear: 1650, phase: 'regional', role: 'farm', reason: 'survey', width: 3.5, kind: 'local', constructionCost: 0 })

describe('connected agricultural district access', () => {
  it('surveys a real same-bank source instead of declaring a nearby road across water to be access', () => {
    const graph = new PlanarRoadGraph()
    graph.add([{ x: 190, y: 50 }, { x: 190, y: 750 }], metadata('west-bank'), false)
    graph.add([{ x: 190, y: 50 }, { x: 650, y: 50 }, { x: 650, y: 750 }], metadata('east-bank'))
    const water: Area = { id: 'river', kind: 'water', polygon: rectangle(220, 100, 20, 700) }
    const wet = (p: Point) => p.x >= 220 && p.x <= 240 && p.y >= 100
    const planner = new RoadPlanner({ width: 1000, height: 800, areas: [water], core: null, terrain: { waterAt: wet, elevation: () => 5, slope: () => 0, bridgeSites: [] } })
    const sectors = [{ id: 'east-field', point: { x: 300, y: 400 }, ownerResistance: .6 }], original = structuredClone(sectors)
    expect(graph.nearest(sectors[0]!.point, 150)?.road.id).toBe('west-bank')
    const projects = [...surveyAgriculturalAccessProjects({ graph, planner, sectors })]
    expect(projects).toHaveLength(1)
    expect(projects[0]!.route.points[0]!.x).toBeGreaterThan(240)
    expect(graph.projections(projects[0]!.route.points[0]!, .01).some(source => source.road.id === 'east-bank')).toBe(true)
    expect(planner.validate(projects[0]!.route.points, 3.5)).toBe(true)
    expect(projects[0]!.route.bridgeLength).toBe(0)
    expect(sectors).toEqual(original)
    expect(graph.roads).toHaveLength(2)
  })

  it('connects a productive plain in successive surveyed projects without inventing an initial distant source', () => {
    const graph = new PlanarRoadGraph()
    graph.add([{ x: 50, y: 100 }, { x: 50, y: 800 }], metadata('old-road'), false)
    const planner = new RoadPlanner({ width: 1600, height: 900, areas: [], core: null })
    const sectors = [{ id: 'outer', point: { x: 1150, y: 400 }, ownerResistance: .6 }, { id: 'near', point: { x: 550, y: 400 }, ownerResistance: .5 }]
    const projects = []
    for (const project of surveyAgriculturalAccessProjects({ graph, planner, sectors })) {
      expect(graph.nearest(project.route.points[0]!, .01)).toBeTruthy()
      expect(planner.validate(project.route.points, project.width)).toBe(true)
      expect(graph.add(project.route.points, metadata(`farm-${projects.length}`))).toBeTruthy()
      projects.push(project)
    }
    expect(projects.map(project => project.sector.id)).toEqual(['near', 'outer'])
    expect(projects.every(project => project.year === 1650 && project.route.cost < 700)).toBe(true)
    expect(graph.nearest(sectors[0]!.point, .01)).toBeTruthy()
  })

  it('leaves a landlocked sector uncultivated when every actual source requires an unsurveyed river crossing', () => {
    const graph = new PlanarRoadGraph()
    graph.add([{ x: 100, y: 50 }, { x: 100, y: 750 }], metadata('only-west-road'), false)
    const water: Area = { id: 'river', kind: 'water', polygon: rectangle(220, 0, 30, 800) }
    const planner = new RoadPlanner({ width: 1000, height: 800, areas: [water], core: null })
    const projects = [...surveyAgriculturalAccessProjects({ graph, planner, sectors: [{ id: 'unserved-east', point: { x: 300, y: 400 }, ownerResistance: .8 }] })]
    expect(projects).toEqual([])
  })
})
