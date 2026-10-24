import { describe, expect, it } from 'vitest'
import { PlanarRoadGraph, extractStreetBlocks, roadLength } from './road-graph'
import type { RoadMetadata } from './road-graph'

const metadata = (id: string): RoadMetadata => ({ id, builtYear: 1700, phase: 'oldtown', role: 'lane', reason: 'test transport project', width: 6, kind: 'local', constructionCost: 100 })
const point = (x: number, y: number) => ({ x, y })

describe('incremental planar road graph', () => {
  it('invalidates exact road and travel queries after a new shortcut, including retained accessors', () => {
    const graph = new PlanarRoadGraph(), source = point(0, 0), destination = point(300, 0), middle = point(150, 0)
    graph.add([source, point(0, 300), point(300, 300), destination], metadata('old-detour'), false)
    expect(graph.nearest(middle, 20)).toBeNull()
    const time = graph.accessibilityFrom(source)
    expect(time(destination)).toBeCloseTo(900 / 220, 9)
    expect(graph.accessibilityFrom(source)).toBe(time)
    graph.add([source, destination], metadata('shortcut'))
    expect(graph.nearest(middle, 20)!.distance).toBe(0)
    expect(time(destination)).toBeCloseTo(300 / 220, 9)
    expect(graph.accessibilityFrom(source)(destination)).toBe(time(destination))
  })

  it('does not retain an unreachable cached result after the first road is built', () => {
    const graph = new PlanarRoadGraph(), source = point(0, 0), destination = point(100, 0)
    const time = graph.accessibilityFrom(source)
    expect(time(destination)).toBe(Infinity)
    graph.add([source, destination], metadata('first-road'), false)
    expect(time(destination)).toBeCloseTo(100 / 220, 9)
  })

  it('inserts true crossing junctions while preserving the old physical route', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(0, 100), point(300, 100)], metadata('old'), false)
    const added = graph.add([point(80, 100), point(80, 200), point(230, 200), point(230, 0)], metadata('new'))
    expect(added).not.toBeNull()
    expect(graph.roads[0]!.points).toEqual([point(0, 100), point(80, 100), point(230, 100), point(300, 100)])
    expect(roadLength(graph.roads[0]!.points)).toBe(300)
    expect(added!.points).toContainEqual(point(230, 100))
    expect(Number.isFinite(graph.travelTime(point(0, 100), point(230, 0)))).toBe(true)
  })

  it('can select separate junction sites on one older named road', () => {
    const graph = new PlanarRoadGraph()
    const samples = Array.from({ length: 31 }, (_, i) => point(i * 10, 0))
    graph.add(samples, metadata('one-old-route'), false)
    const anchors = graph.projections(point(150, 70), 240, 6)
    expect(anchors.length).toBeGreaterThan(2)
    expect(new Set(anchors.map(a => a.road.id)).size).toBe(1)
    expect(Math.max(...anchors.map(a => a.point.x)) - Math.min(...anchors.map(a => a.point.x))).toBeGreaterThan(150)
  })

  it('finds physical survey-line crossings and builds a real connected loop', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(20, 20), point(200, 20), point(200, 180), point(20, 180)], metadata('old-route'), false)
    const hits = graph.crossings(point(80, 0), point(80, 200))
    expect(hits.map(hit => hit.point)).toEqual([point(80, 20), point(80, 180)])
    graph.add(hits.map(hit => hit.point), metadata('survey-link'))
    expect(extractStreetBlocks(graph.roads)).toHaveLength(1)
    expect(graph.roads[0]!.points).toContainEqual(point(80, 20))
    expect(graph.roads[0]!.points).toContainEqual(point(80, 180))
  })

  it('distinguishes extending an open road end from a turn at an actual junction', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(20, 100), point(200, 100)], metadata('old'), false)
    expect(graph.openEndHeading(point(200, 100))).toBeCloseTo(0, 8)
    expect(Math.abs(graph.openEndHeading(point(20, 100))!)).toBeCloseTo(Math.PI, 8)
    expect(graph.openEndHeading(point(100, 100))).toBeUndefined()
    graph.add([point(200, 100), point(200, 240)], metadata('junction-arm'))
    expect(graph.openEndHeading(point(200, 100))).toBeUndefined()
  })

  it('gives a new main street a perpendicular approach and refuses a fifth junction arm', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(100, 500), point(1100, 500)], { ...metadata('old-main'), kind: 'arterial', width: 13 }, false)
    const heading = graph.junctionHeading(point(600, 500), point(300, 1000))!
    expect(heading).toBeCloseTo(Math.PI / 2, 8)
    graph.add([point(600, 500), point(600, 1000)], metadata('south'))
    expect(graph.junctionHeading(point(600, 500), point(900, 100))).toBeCloseTo(-Math.PI / 2, 8)
    graph.add([point(600, 500), point(600, 100)], metadata('north'))
    expect(graph.junctionHeading(point(600, 500), point(900, 800))).toBeNull()
    expect(graph.hasAcuteMajorCrossing([point(100, 450), point(1000, 550)])).toBe(true)
    expect(graph.hasAcuteMajorCrossing([point(300, 300), point(300, 700)])).toBe(false)
  })

  it('extracts actual bounded street faces and removes dead-end excursions', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(10, 10), point(210, 10), point(210, 210), point(10, 210), point(10, 10)], metadata('ring'), false)
    graph.add([point(10, 100), point(80, 100)], metadata('dead-end'))
    const faces = extractStreetBlocks(graph.roads)
    expect(faces).toHaveLength(1)
    const area = faces[0]!.reduce((sum, p, i, polygon) => sum + p.x * polygon[(i + 1) % polygon.length]!.y - polygon[(i + 1) % polygon.length]!.x * p.y, 0) / 2
    expect(area).toBe(40000)
    expect(faces[0]).not.toContainEqual(point(80, 100))
  })

  it('computes access from a projection on a long road rather than its distant endpoint', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(0, 0), point(3000, 0)], metadata('long-road'), false)
    expect(graph.accessibilityFrom(point(1500, 0))(point(1500, 75))).toBeCloseTo(1, 5)
    expect(graph.accessibilityFrom(point(1500, 0))(point(1720, 0))).toBeCloseTo(1, 5)
  })

  it('preserves a transport entrance even when its forecourt is shorter than the normal road snap radius', () => {
    const graph = new PlanarRoadGraph(), station = point(400, 100.5)
    graph.add([point(0, 100), point(1000, 100)], metadata('old-route'), false)
    const link = graph.add([point(400, 100), station], { ...metadata('forecourt'), role: 'access', width: 3.5, preserveEndpoint: true })
    expect(link!.points.at(-1)).toEqual(station)
    expect(graph.roads[0]!.points).toContainEqual(point(400, 100))
    expect(graph.travelTime(point(400, 100), station)).toBeCloseTo(.5 / 220, 7)
    expect(graph.ensureJunction(point(650, 100))).toBe(true)
    expect(graph.roads[0]!.points).toContainEqual(point(650, 100))
  })

  it('keeps grade-separated mainlines inaccessible until explicit interchange ramps connect both levels', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(100, 100), point(100, 500), point(100, 900)], metadata('west-street'), false)
    graph.add([point(900, 100), point(900, 500), point(900, 900)], metadata('east-street'), false)
    graph.add([point(0, 500), point(100, 500), point(900, 500), point(1000, 500)], { ...metadata('expressway'), role: 'expressway', width: 22, level: 1, controlledAccess: true }, false)
    expect(graph.travelTime(point(100, 100), point(900, 100))).toBe(Infinity)
    expect(graph.nearest(point(500, 500), 50)).toBeNull()
    const ramp = { ...metadata('west-ramp'), role: 'ramp' as const, width: 7, level: 1, controlledAccess: true }
    graph.add([point(100, 800), point(250, 800), point(350, 500)], ramp)
    expect(graph.travelTime(point(100, 100), point(900, 100))).toBe(Infinity)
    graph.add([point(900, 800), point(750, 800), point(650, 500)], { ...ramp, id: 'east-ramp' })
    expect(Number.isFinite(graph.travelTime(point(100, 100), point(900, 100)))).toBe(true)
    expect(graph.roads.find(road => road.id === 'expressway')!.points).toContainEqual(point(350, 500))
    expect(extractStreetBlocks(graph.roads)).toEqual([])
  })

  it('leaves no half-built infrastructure when one mandatory access is rejected', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(100, 100), point(900, 100)], metadata('old'), false)
    const before = structuredClone(graph.roads)
    expect(graph.addBatch([{ points: [point(100, 400), point(900, 400)], metadata: { ...metadata('mainline'), role: 'expressway', controlledAccess: true, level: 1 }, requireConnection: false }, { points: [point(500, 300), point(600, 400)], metadata: { ...metadata('unconnected-ramp'), role: 'ramp', controlledAccess: true, level: 1 } }])).toBeNull()
    expect(graph.roads).toEqual(before)
  })

  it('keeps a physically surveyed short culvert instead of breaking the route at its stream', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(100, 100), point(300, 100)], metadata('approach'), false)
    expect(graph.add([point(300, 100), point(302, 100)], { ...metadata('culvert'), role: 'bridge', bridge: true })).not.toBeNull()
    expect(graph.add([point(302, 100), point(500, 100)], metadata('far-bank'))).not.toBeNull()
    expect(Number.isFinite(graph.travelTime(point(100, 100), point(500, 100)))).toBe(true)
  })

  it('commits a bridge widening and its new approaches as one dated transaction', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(100, 100), point(140, 100), point(160, 100), point(200, 100)], { ...metadata('old-bridge'), role: 'bridge', bridge: true, width: 4 }, false)
    graph.add([point(140, 100), point(140, 220)], metadata('old-access'))
    const projects = [
      { points: [point(-50, 100), point(80, 100)], metadata: { ...metadata('west'), builtYear: 1955 }, requireConnection: false },
      { points: [point(80, 100), point(220, 100)], metadata: { ...metadata('old-bridge'), builtYear: 1955, role: 'bridge' as const, bridge: true, width: 8.5, boundaryContinuation: true }, modifies: 'old-bridge' },
      { points: [point(220, 100), point(350, 100)], metadata: { ...metadata('east'), builtYear: 1955 }, requireConnection: false },
    ]
    expect(graph.addBatch(projects)).toHaveLength(3)
    expect(graph.roads.filter(road => road.bridge)).toHaveLength(1)
    expect(graph.roads.find(road => road.id === 'old-bridge')!.points).toContainEqual(point(140, 100))
    expect(graph.roadHistory.filter(v => v.value.id === 'old-bridge').map(v => [v.from, v.to, v.value.width, v.value.modifiedYear])).toEqual([[1700, 1955, 4, undefined], [1955, undefined, 8.5, 1955]])
    expect(graph.roadHistory.find(v => v.value.id === 'old-bridge' && v.from === 1955)!.value.boundaryContinuation).toBe(true)
    expect(Number.isFinite(graph.travelTime(point(140, 220), point(-50, 100)))).toBe(true)
    expect(Number.isFinite(graph.travelTime(point(-50, 100), point(350, 100)))).toBe(true)
  })

  it('rolls back a staged widening and its archive when a later mandatory approach fails', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(100, 100), point(200, 100)], { ...metadata('old-bridge'), role: 'bridge', bridge: true, width: 4 }, false)
    const before = structuredClone(graph.roadHistory)
    expect(graph.addBatch([
      { points: [point(100, 100), point(200, 100)], metadata: { ...metadata('old-bridge'), builtYear: 1955, width: 8.5 }, modifies: 'old-bridge' },
      { points: [point(400, 100), point(500, 100)], metadata: metadata('disconnected') },
    ])).toBeNull()
    expect(graph.roadHistory).toEqual(before)
    expect(graph.roads[0]!.width).toBe(4)
  })
})
