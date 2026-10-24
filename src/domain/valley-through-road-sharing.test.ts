import { describe, expect, it } from 'vitest'
import type { Point } from './types'
import type { ValleyThroughRoad } from './valley-through-road'
import { commitValleyThroughRoad, shareValleyBridgeDecks } from './valley-through-road'
import { PlanarRoadGraph, roadLength } from './road-graph'
import { RegionalRoadPlanner } from './regional-road-planner'
import { RoadPlanner } from './road-planner'

const bankA = { x: 0, y: 0 }, bankB = { x: 20, y: 0 }, attachment = { x: 50, y: 60 }
const line = (a: Point, b: Point, n = 10) => Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }))
const section = (points: Point[], bridge = false) => ({ points, bridge, length: roadLength(points) })
const metadata = { builtYear: 1900, phase: 'oldtown', role: 'access' as const, reason: '既存道路', width: 4, kind: 'local' as const, constructionCost: 30 }
function fixture() {
  const sections = [section(line({ x: -100, y: 0 }, bankA)), section(line(bankA, bankB), true),
    section([bankB, { x: 50, y: 20 }, attachment, { x: 20, y: 60 }, { x: 20.4, y: 0 }]),
    section(line({ x: 20.4, y: 0 }, { x: -.4, y: 0 }), true), section(line({ x: -.4, y: 0 }, { x: -100, y: 80 }))]
  const spans = [{ bankA, bankB }, { bankA, bankB }]
  const network = shareValleyBridgeDecks(sections, spans), length = sections.reduce((s, part) => s + part.length, 0), constructionLength = network.reduce((s, part) => s + part.length, 0)
  const costed = network.map(part => ({ ...part, constructionCost: part.length * (part.bridge ? 13 : 1.8) + (part.bridge ? 420 : 0) }))
  const constructionCost = costed.reduce((sum, part) => sum + part.constructionCost, 0)
  const project: ValleyThroughRoad = { width: 8.5, fundingLimit: 2000, attachment, headwaterPass: true, sections: costed,
    route: { points: sections.flatMap((part, i) => part.points.slice(i ? 1 : 0)), length, cost: 1000, bridgeLength: 40, method: 'bridge-project', surveyedBridgeSpans: spans, boundaryContinuation: true },
    constructionLength, constructionCost }
  return { sections, spans, network, project }
}

describe('one bridge shared by a regional road programme', () => {
  it('re-evaluates regional section credits in the existing translated terrain proxy, including surveyed water and fixed bridge cost', () => {
    const terrain = { elevation: (p: Point) => 50 + Math.max(0, p.x) * .02, slope: () => .02, waterAt: (p: Point) => p.x >= 20 && p.x <= 40, bridgeSites: [] }
    const local = (p: Point) => ({ x: p.x - 450, y: p.y - 450 }), landCost = (p: Point) => Math.max(0, p.x) / 1000
    const regional = new RegionalRoadPlanner({ width: 600, height: 400, areas: [], core: null, landCost, terrain: { ...terrain, continuationTerrain: terrain } })
    const reference = new RoadPlanner({ width: 1500, height: 1300, areas: [], core: null, landCost: p => landCost(local(p)), terrain: { elevation: p => terrain.elevation(local(p)), slope: terrain.slope, waterAt: p => terrain.waterAt(local(p)), bridgeSites: [] } })
    const points = [{ x: -100, y: 200 }, { x: 300, y: 200 }]
    const expected = reference.cost(points.map(p => ({ x: p.x + 450, y: p.y + 450 })), 'highway', true), measured = regional.cost(points, 'highway', true)
    expect(measured.cost).toBe(expected.cost)
    expect(measured.bridgeLength).toBeCloseTo(20, 3)
    expect(measured.points[0]).toEqual(points[0])
    expect(measured.points.at(-1)).toEqual(points.at(-1))
  })
  it('retains both city approaches while sharing only the identical surveyed deck and exact junction nodes', () => {
    const { sections, spans, network } = fixture(), before = structuredClone(sections)
    expect(network).toHaveLength(4)
    expect(network.filter(part => part.bridge)).toHaveLength(1)
    expect(network[2]!.points[0]).toEqual(bankB)
    expect(network[2]!.points.at(-1)).toEqual(bankB)
    expect(network[3]!.points[0]).toEqual(bankA)
    expect(network[2]!.points).toContainEqual(attachment)
    expect(network.every(part => part.length === roadLength(part.points))).toBe(true)
    expect(shareValleyBridgeDecks(sections, [])).toHaveLength(5)
    expect(shareValleyBridgeDecks(sections, spans)).toEqual(network)
    expect(sections).toEqual(before)
    const parallel = [...sections, section(line({ x: 20, y: 8 }, { x: 0, y: 8 }), true)]
    expect(shareValleyBridgeDecks(parallel, [...spans, { bankA: { x: 0, y: 8 }, bankB: { x: 20, y: 8 } }]).filter(part => part.bridge)).toHaveLength(2)
  })
  it('commits the network atomically, charges a shared bridge once, and preserves the inherited bridge history', () => {
    const { project } = fixture(), graph = new PlanarRoadGraph()
    graph.add(line(bankA, bankB), { ...metadata, id: 'inherited-bridge', role: 'bridge', bridge: true }, false)
    graph.add(line(attachment, { x: 80, y: 60 }), { ...metadata, id: 'city-street' }, false)
    let id = 0
    const added = commitValleyThroughRoad(graph, project, { year: 1955, reason: '橋を共有する国道事業', nextId: () => `national-${id++}` })
    expect(added).toHaveLength(4)
    expect(graph.roads.filter(road => road.bridge)).toHaveLength(1)
    expect(added!.reduce((sum, road) => sum + road.constructionCost, 0)).toBeCloseTo(project.constructionCost, 9)
    expect(added!.find(road => road.bridge)!.constructionCost).toBe(20 * 13 + 420)
    for (const endpoint of [project.route.points[0]!, project.route.points.at(-1)!]) expect(Number.isFinite(graph.travelTime(attachment, endpoint))).toBe(true)
    expect(graph.roadHistory.filter(v => v.value.id === 'inherited-bridge').map(v => [v.from, v.to, v.value.width])).toEqual([[1900, 1955, 4], [1955, undefined, 8.5]])
  })
  it('retains rejection and the original history when an unrelated existing road duplicates a required approach', () => {
    const { project } = fixture(), graph = new PlanarRoadGraph()
    graph.add(project.sections[0]!.points, { ...metadata, id: 'existing-other-road' }, false)
    graph.add(line(attachment, { x: 80, y: 60 }), { ...metadata, id: 'city-street' }, false)
    const before = JSON.stringify(graph.roadHistory)
    let id = 0
    expect(commitValleyThroughRoad(graph, project, { year: 1955, reason: '重複する事業', nextId: () => `national-${id++}` })).toBeNull()
    expect(JSON.stringify(graph.roadHistory)).toBe(before)
  })
  it('rejects an otherwise valid network when its physical-section credits exceed the regional appropriation', () => {
    const { project } = fixture(), graph = new PlanarRoadGraph()
    graph.add(line(attachment, { x: 80, y: 60 }), { ...metadata, id: 'city-street' }, false)
    const before = JSON.stringify(graph.roadHistory)
    expect(commitValleyThroughRoad(graph, { ...project, fundingLimit: project.constructionCost - 1 }, { year: 1955, reason: '予算超過', nextId: () => 'overbudget' })).toBeNull()
    expect(JSON.stringify(graph.roadHistory)).toBe(before)
  })
})
