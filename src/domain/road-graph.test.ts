import { describe, expect, it } from 'vitest'
import { PlanarRoadGraph, extractStreetBlocks, roadLength } from './road-graph'
import type { RoadMetadata } from './road-graph'

const metadata = (id: string): RoadMetadata => ({ id, builtYear: 1700, phase: 'oldtown', role: 'lane', reason: 'test transport project', width: 6, kind: 'local', constructionCost: 100 })
const point = (x: number, y: number) => ({ x, y })

describe('incremental planar road graph', () => {
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
})
