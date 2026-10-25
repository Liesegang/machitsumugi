import { describe, expect, it } from 'vitest'
import { distanceToSegment, rectangle } from './geometry'
import { PlanarRoadGraph } from './road-graph'
import { RoadPlanner } from './road-planner'
import { planHousingFrontierBridge, surveyHousingFrontageAccess } from './transport-investment'
import { prospectiveRoadDistance, PROSPECTIVE_ROAD_REACH } from './prospective-road-access'

function fixture(roadwayOnly = false) {
  const graph = new PlanarRoadGraph()
  graph.add([{ x: 200, y: 250 }, { x: 200, y: 750 }], { id: 'old-street', kind: 'local', role: 'lane', width: 5, builtYear: 1800, phase: 'oldtown', reason: '既存市街の街路', constructionCost: 500 }, false)
  const waterAt = (p: { x: number }) => p.x >= 390 && p.x <= 410
  const terrain = { elevation: () => 10, slope: () => 0, seaAt: () => false, waterAt, bridgeSites: [], bridgeCandidates: [200, 500, 800].map(y => ({ point: { x: 400, y }, bankA: { x: 345, y }, bankB: { x: 455, y }, width: 20, cost: 100 })) }
  const planner = new RoadPlanner({ width: 1100, height: 1000, core: null, areas: [{ id: 'river', kind: 'water', polygon: rectangle(390, 0, 20, 1000) }], terrain,
    ...(roadwayOnly ? { exactLandCost: true, landCost: (point: { x: number; y: number }) => point.x > 455 && Math.abs(point.y - 500) > 20 ? Infinity : 0 } : {}),
  })
  const cells = [
    { point: { x: 220, y: 510 }, households: 40, capacity: 40, roadDistance: 20, frontageDepth: 30, area: 10000, suitability: .9, formationCostPerHousehold: 0 },
    ...[600, 680, 760].flatMap(x => [470, 530].map(y => ({ point: { x, y }, households: 0, capacity: 80, servicedCapacity: 0, roadDistance: prospectiveRoadDistance(graph, { x, y }), frontageDepth: 35, area: 10000, suitability: .9, formationCostPerHousehold: 0 }))),
  ]
  return { graph, planner, cells, year: 1955, settlement: 'regional-city', funds: 5000, unmet: 200, cache: new Map() }
}

describe('first access to an unoccupied river bank', () => {
  it('turns actual dry far-bank supply into an ordinary growth frontier without replacing old streets', () => {
    const input = fixture(), oldStreet = structuredClone(input.graph.roads[0]!), target = input.cells[1]!.point
    expect(prospectiveRoadDistance(input.graph, target)).toBe(Infinity)
    expect(input.cells.slice(1).every(cell => cell.roadDistance >= PROSPECTIVE_ROAD_REACH)).toBe(true)
    const project = planHousingFrontierBridge(input)!
    expect(project).not.toBeNull()
    expect(project.route.surveyedBridgeSpans).toHaveLength(1)
    expect(project.capacity).toBeGreaterThanOrEqual(20)
    expect(project.benefit).toBeGreaterThan(project.route.cost)
    expect(project.served.every(cell => Math.min(...project.route.points.slice(1).map((point, i) => distanceToSegment(cell.point, project.route.points[i]!, point))) < cell.frontageDepth + 1)).toBe(true)
    expect(input.graph.roads).toHaveLength(1)
    const span = project.route.surveyedBridgeSpans![0]!, a = project.route.points.findIndex(p => Math.hypot(p.x - span.bankA.x, p.y - span.bankA.y) < .01), b = project.route.points.findIndex(p => Math.hypot(p.x - span.bankB.x, p.y - span.bankB.y) < .01)
    const metadata = { kind: 'local' as const, role: 'collector' as const, width: project.width, builtYear: 1955, phase: 'suburban', reason: '対岸への実測した接道', constructionCost: project.route.cost, preserveEndpoint: true }
    expect(input.graph.addBatch([
      { points: project.route.points.slice(0, a + 1), metadata: { ...metadata, id: 'approach' } },
      { points: project.route.points.slice(a, b + 1), metadata: { ...metadata, id: 'deck', role: 'bridge', bridge: true } },
      { points: project.route.points.slice(b), metadata: { ...metadata, id: 'runout' } },
    ])).not.toBeNull()
    const updatedStreet = input.graph.roads[0]!
    expect({ ...updatedStreet, points: oldStreet.points }).toEqual(oldStreet)
    expect(updatedStreet.points[0]).toEqual(oldStreet.points[0])
    expect(updatedStreet.points.at(-1)).toEqual(oldStreet.points.at(-1))
    expect(updatedStreet.points.every(point => point.x === 200 && point.y >= 250 && point.y <= 750)).toBe(true)
    expect(prospectiveRoadDistance(input.graph, target)).toBeLessThan(PROSPECTIVE_ROAD_REACH)
    expect(input.graph.roads.filter(road => road.bridge)).toHaveLength(1)
  })

  it('retains real occupied approaches, finite funds, unmet demand and productive far-bank supply requirements', () => {
    const input = fixture()
    for (const patch of [{ funds: 0 }, { funds: 500 }, { unmet: 19 }, { year: 1850 }, { settlement: 'village' }, { cells: input.cells.filter(cell => !cell.households) }, { cells: input.cells.slice(0, 1) }, { cells: input.cells.map(cell => ({ ...cell, formationCostPerHousehold: 13 })) }]) expect(planHousingFrontierBridge({ ...input, ...patch })).toBeNull()
    expect(input.graph.roads).toHaveLength(1)
  })

  it('does not purchase a bridge using disk edges whose centres cannot take occupancy', () => {
    const input = fixture(true)
    input.cells = input.cells.map(cell => cell.households ? cell : { ...cell, point: { ...cell.point, y: 545 } })
    expect(planHousingFrontierBridge(input)).toBeNull()
    expect(input.graph.roads).toHaveLength(1)
  })

  it('commits the bridge and its mandatory dry pad access atomically', () => {
    const input = fixture(), original = structuredClone(input.graph.roads), project = planHousingFrontierBridge(input)!
    const span = project.route.surveyedBridgeSpans![0]!, a = project.route.points.findIndex(point => Math.hypot(point.x - span.bankA.x, point.y - span.bankA.y) < .01), b = project.route.points.findIndex(point => Math.hypot(point.x - span.bankB.x, point.y - span.bankB.y) < .01)
    const metadata = { kind: 'local' as const, role: 'collector' as const, width: project.width, builtYear: 1955, phase: 'suburban', reason: '測量した橋と実在する接道敷地', constructionCost: project.route.cost, preserveEndpoint: true }
    const pieces = [
      { points: project.route.points.slice(0, a + 1), metadata: { ...metadata, id: 'approach' } },
      { points: project.route.points.slice(a, b + 1), metadata: { ...metadata, id: 'deck', role: 'bridge' as const, bridge: true } },
      { points: project.route.points.slice(b), metadata: { ...metadata, id: 'runout' } },
    ]
    const entrance = project.route.points.at(-1)!, pad = { x: entrance.x, y: entrance.y + 60 }
    expect(input.planner.validate([entrance, pad], 4.6)).toBe(true)
    const accessMetadata = { ...metadata, id: 'mandatory-access', role: 'access' as const, width: 4.6 }
    expect(input.graph.addBatch([...pieces, { points: [{ x: 1000, y: 950 }, pad], metadata: accessMetadata }])).toBeNull()
    expect(input.graph.roads).toEqual(original)
    expect(input.graph.addBatch([...pieces, { points: [entrance, pad], metadata: accessMetadata }])).not.toBeNull()
    expect(input.graph.nearest(pad, 1)?.distance).toBe(0)
    expect(input.graph.roads.filter(road => road.bridge)).toHaveLength(1)
    expect(original[0]!.points.every(point => input.graph.roads[0]!.points.some(actual => actual.x === point.x && actual.y === point.y))).toBe(true)
  })

  it('rejects an interior access-road hill even when both endpoint elevations match', () => {
    const input = fixture(), start = { x: 600, y: 500 }, goal = { x: 660, y: 500 }
    expect(surveyHousingFrontageAccess(input.planner, start, goal, 4.6)).not.toBeNull()
    const terrain = { ...input.planner.environment.terrain!, elevation: (point: { x: number }) => 10 + Math.max(0, 1 - Math.abs(point.x - 630) / 12) * 8 }
    expect(terrain.elevation(start)).toBe(terrain.elevation(goal))
    expect(surveyHousingFrontageAccess(new RoadPlanner({ ...input.planner.environment, terrain }), start, goal, 4.6)).toBeNull()
  })
})
