import { describe, expect, it, vi } from 'vitest'
import { PlanarRoadGraph, extractStreetBlocks, roadLength, roadTravelSpeed } from './road-graph'
import type { RoadMetadata } from './road-graph'

const metadata = (id: string): RoadMetadata => ({ id, builtYear: 1700, phase: 'oldtown', role: 'lane', reason: 'test transport project', width: 6, kind: 'local', constructionCost: 100 })
const point = (x: number, y: number) => ({ x, y })

describe('incremental planar road graph', () => {
  it('permits a measured oblique local T only within a safe free sector while retaining square defaults and end tangents', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(0, 0), point(200, 0)], metadata('old-lane'), false)
    const desired = point(120, 100), angle = Math.atan2(100, 20), at = point(100, 0)
    expect(graph.junctionHeading(at, desired)).toBeCloseTo(Math.PI / 2)
    expect(graph.junctionHeading(at, desired, Math.PI / 10)).toBeCloseTo(angle)
    expect(graph.junctionHeading(at, point(200, 100), Math.PI / 10)).toBeCloseTo(Math.PI / 2)
    expect(graph.junctionHeading(point(200, 0), point(220, 100), Math.PI / 10)).toBeCloseTo(0)
  })

  it('prunes reuse by endpoints while retaining raw-append fallback across graph rebuild APIs', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(0, 0), point(100, 0)], metadata('near'), false)
    graph.add([point(10000, 0), point(10100, 0)], metadata('far'), false)
    const expectIndexed = (value: PlanarRoadGraph) => {
      const far = value.roads.find(road => road.id === 'far')!, descriptor = Object.getOwnPropertyDescriptor(far, 'width')!, read = vi.fn(() => 6)
      Object.defineProperty(far, 'width', { configurable: true, enumerable: true, get: read })
      try {
        expect(value.reusableRoad([point(0, 0), point(100, 5)], metadata('new-path'))).toBeNull()
        expect(read).not.toHaveBeenCalled()
      } finally { Object.defineProperty(far, 'width', descriptor) }
    }
    expectIndexed(graph)
    const raw = { ...metadata('raw'), points: [point(400, 0), point(500, 0)] }
    graph.roads.push(raw)
    expect(graph.reusableRoad([...raw.points].reverse(), metadata('raw-reverse'))).toBe(raw)
    graph.add([point(1000, 0), point(1100, 0)], metadata('indexed-after-raw'), false)
    expect(graph.reusableRoad(raw.points, metadata('still-raw'))).toBe(raw)
    expectIndexed(graph.fork())
    expect(graph.modify('near', 1800, { width: 8, reason: 'widen with complete index rebuild', constructionCost: 1 })).not.toBeNull()
    expectIndexed(graph)
    const appended = { ...metadata('raw-before-batch'), points: [point(600, 0), point(700, 0)] }
    graph.roads.push(appended)
    expect(graph.addBatch([{ points: [point(700, 0), point(700, 100)], metadata: metadata('batch-link') }])).not.toBeNull()
    expectIndexed(graph)
    expect(graph.reusableRoad(appended.points, metadata('batch-rebuilt-raw'))?.id).toBe('raw-before-batch')
  })

  it('keeps original first-match order when equivalent reuse endpoints span neighbouring index buckets', () => {
    const raw = new PlanarRoadGraph(), first = { ...metadata('first'), points: [point(100.01, 0), point(200.01, 0)] }, second = { ...metadata('second'), points: [point(99.99, 0), point(199.99, 0)] }
    raw.roads.push(first, second)
    const graph = raw.fork(), path = [point(100, 0), point(200, 0)]
    expect(graph.reusableRoad(path, metadata('proposal'))?.id).toBe('first')
    expect(graph.reusableRoad([...path].reverse(), metadata('reverse'))?.id).toBe('first')
    expect(graph.reusableRoad(path, { ...metadata('too-wide'), width: 6.1 })).toBeNull()
  })

  it('removes complete T/Y dead-end excursions without changing the actual closed perimeter', () => {
    const graph = new PlanarRoadGraph(), ring = [point(0, 0), point(400, 0), point(400, 300), point(0, 300), point(0, 0)]
    graph.add(ring, metadata('perimeter'), false)
    graph.add([point(0, 150), point(150, 150)], metadata('stem'))
    graph.add([point(150, 150), point(220, 220)], metadata('y-north'))
    graph.add([point(150, 150), point(240, 90)], metadata('y-south'))
    const faces = extractStreetBlocks(graph.roads)
    expect(faces).toHaveLength(1)
    expect(Math.abs(faces[0]!.reduce((sum, p, i, all) => sum + p.x * all[(i + 1) % all.length]!.y - all[(i + 1) % all.length]!.x * p.y, 0)) / 2).toBe(120000)
    expect(faces[0]!.every(p => p.x === 0 || p.x === 400 || p.y === 0 || p.y === 300)).toBe(true)
    for (let i = 0; i < faces[0]!.length; i++) expect(faces[0]![i]).not.toEqual(faces[0]![(i + 1) % faces[0]!.length])
    graph.add([point(150, 150), point(400, 150)], metadata('real-through-connection'))
    const split = extractStreetBlocks(graph.roads)
    expect(split).toHaveLength(2)
    expect(split.reduce((total, face) => total + Math.abs(face.reduce((sum, p, i) => sum + p.x * face[(i + 1) % face.length]!.y - face[(i + 1) % face.length]!.x * p.y, 0)) / 2, 0)).toBe(120000)
    graph.add([point(0, 20), point(10, 20), point(10, 30), point(0, 30)], metadata('small-traffic-island'), true)
    const physical = extractStreetBlocks(graph.roads, .001), area = (faces: { x: number; y: number }[][]) => faces.reduce((total, face) => total + Math.abs(face.reduce((sum, p, i) => sum + p.x * face[(i + 1) % face.length]!.y - face[(i + 1) % face.length]!.x * p.y, 0)) / 2, 0)
    expect(area(physical)).toBe(120000)
    expect(area(extractStreetBlocks(graph.roads))).toBe(119900)
  })
  it('validates the exact normalized insertion before mutating old junctions or any road state', () => {
    const graph = new PlanarRoadGraph(), old = graph.add([point(0, 0), point(300, 0)], metadata('old'), false)!, proposal = metadata('same-proposal-id')
    const state = () => JSON.stringify({ roads: graph.roads, history: graph.roadHistory, revision: graph.topologyRevision, metadata: proposal })
    const before = state(), source = [point(80, .6), point(80, 100), point(230, 100), point(230, -20)], inputBefore = structuredClone(source)
    let normalized: readonly Readonly<{ x: number; y: number }>[] = []
    expect(graph.add(source, proposal, true, candidate => { normalized = candidate.points; expect(candidate.points[0]).toEqual(point(80, 0)); expect(candidate.points).toContainEqual(point(230, 0)); return false })).toBeNull()
    expect(state()).toBe(before); expect(source).toEqual(inputBefore); expect(old.points).toEqual([point(0, 0), point(300, 0)])
    const accepted = graph.add(source, proposal, true, candidate => { normalized = candidate.points; return true })!
    expect(accepted.id).toBe('same-proposal-id'); expect(accepted.points).toEqual(normalized)
    expect(old.points).toContainEqual(point(80, 0)); expect(old.points).toContainEqual(point(230, 0))
  })

  it('also guards a reused road, and a rejected or throwing guard leaves all state intact', () => {
    const graph = new PlanarRoadGraph(), road = graph.add([point(0, 0), point(150, 0)], metadata('existing'), false)!, proposal = metadata('unused-id')
    const before = JSON.stringify({ roads: graph.roads, history: graph.roadHistory, revision: graph.topologyRevision, metadata: proposal })
    const guard = vi.fn(candidate => { expect(candidate.reusedRoadId).toBe('existing'); return false })
    expect(graph.add([...road.points].reverse(), proposal, true, guard)).toBeNull(); expect(guard).toHaveBeenCalledOnce()
    expect(() => graph.add([point(40, .5), point(40, 120)], proposal, true, () => { throw new Error('validator-rejected') })).toThrow('validator-rejected')
    expect(JSON.stringify({ roads: graph.roads, history: graph.roadHistory, revision: graph.topologyRevision, metadata: proposal })).toBe(before)
    expect(graph.add([...road.points].reverse(), proposal, true, candidate => candidate.reusedRoadId === 'existing')).toBe(road)
  })
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

  it('reuses exact projection queries without sharing caller-owned results', () => {
    const graph = new PlanarRoadGraph()
    graph.add(Array.from({ length: 31 }, (_, i) => point(i * 10, 0)), metadata('survey-road'), false)
    const road = graph.roads[0]!, controlledAccess = vi.fn(() => false)
    Object.defineProperty(road, 'controlledAccess', { get: controlledAccess })
    const query = point(150, 70), first = graph.projections(query, 240, 6), expected = structuredClone(first)
    const reads = controlledAccess.mock.calls.length
    expect(reads).toBeGreaterThan(0)
    first[0]!.point.x = -999
    first[0]!.distance = -1
    first[0]!.road = { ...road, id: 'caller-replacement' }
    first.reverse(); first.pop()
    const repeated = graph.projections(query, 240, 6)
    expect(controlledAccess.mock.calls.length).toBe(reads)
    expect(repeated).toEqual(expected)
    expect(repeated[0]!.road).toBe(road)
    expect(graph.projections(query, 240, 6)).not.toBe(repeated)
    expect(graph.projections(query, 240, 6)[0]!.point).not.toBe(repeated[0]!.point)
  })

  it('distinguishes exact projection coordinates, radius and requested count', () => {
    const graph = new PlanarRoadGraph()
    graph.add(Array.from({ length: 31 }, (_, i) => point(i * 10, 0)), metadata('survey-road'), false)
    const query = point(150, 50), many = graph.projections(query, 240, 3)
    expect(many).toHaveLength(3)
    expect(graph.projections(query, 240, 1)).toEqual(many.slice(0, 1))
    expect(graph.projections(query, 40, 3)).toEqual([])
    expect(graph.projections(point(150.0001, 50), 240, 3)[0]!.point.x).toBe(150.0001)
    expect(graph.projections(query, Infinity, 3)).toEqual(many)
  })

  it('invalidates projection results after both a new street and a realignment', () => {
    const graph = new PlanarRoadGraph(), query = point(150, 75)
    graph.add([point(0, 0), point(300, 0)], metadata('old-road'), false)
    expect(graph.projections(query, 200, 1)[0]!.distance).toBe(75)
    const changed = graph.modify('old-road', 1900, { points: [point(0, 0), query, point(300, 0)], width: 8, reason: 'funded realignment', constructionCost: 200 })
    expect(changed).not.toBeNull()
    const realigned = graph.projections(query, 200, 1)[0]!
    expect(realigned.distance).toBe(0)
    expect(realigned.road).toBe(changed)
    expect(realigned.road.width).toBe(8)
    const newQuery = point(150, 150)
    expect(graph.projections(newQuery, 200, 1)[0]!.distance).toBe(75)
    const street = graph.add([query, newQuery, point(300, 150)], { ...metadata('new-street'), builtYear: 1950 })
    expect(street).not.toBeNull()
    expect(graph.projections(newQuery, 200, 1)[0]!.distance).toBe(0)
    expect(graph.projections(newQuery, 200, 1)[0]!.road).toBe(street)
  })

  it('bounds retained projection queries and recomputes evicted exact sites', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(0, 0), point(300, 0)], metadata('survey-road'), false)
    const controlledAccess = vi.fn(() => false)
    Object.defineProperty(graph.roads[0]!, 'controlledAccess', { get: controlledAccess })
    const first = graph.projections(point(100, 20), Infinity, 1)
    let last = first
    for (let i = 0; i < 2048; i++) last = graph.projections(point(i / 10, 21), Infinity, 1)
    const reads = controlledAccess.mock.calls.length
    expect(graph.projections(point(204.7, 21), Infinity, 1)).toEqual(last)
    expect(controlledAccess.mock.calls.length).toBe(reads)
    expect(graph.projections(point(100, 20), Infinity, 1)).toEqual(first)
    expect(controlledAccess.mock.calls.length).toBeGreaterThan(reads)
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
    expect(graph.travelTime(point(400, 100), station)).toBeCloseTo(.5 / roadTravelSpeed({ role: 'access', width: 3.5 }), 7)
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
  it('uses the actual road width in route choice and invalidates time after a funded widening', () => {
    const graph = new PlanarRoadGraph(), a = point(0, 0), b = point(300, 0)
    graph.add([a, b], { ...metadata('narrow'), width: 3 }, false)
    const time = graph.accessibilityFrom(a)
    expect(time(b)).toBeCloseTo(300 / 110, 8)
    graph.add([a, point(0, 100), point(300, 100), b], { ...metadata('wide-detour'), width: 6 })
    expect(graph.travelTime(a, b)).toBeCloseTo(500 / 220, 8)
    expect(graph.modify('narrow', 1960, { width: 6, reason: 'funded corridor widening', constructionCost: 200 })).not.toBeNull()
    expect(time(b)).toBeCloseTo(300 / 220, 8)
    expect(roadTravelSpeed({ role: 'lane' })).toBe(220)
    expect(roadTravelSpeed({ role: 'lane', width: 20 })).toBe(220)
    expect(roadTravelSpeed({ role: 'access', width: 2.8 })).toBeLessThan(roadTravelSpeed({ role: 'access', width: 4.6 }))
  })
  it('reuses a reverse short bridge inside an atomic new route without duplicating its history or capacity', () => {
    const graph = new PlanarRoadGraph(), a = point(1527.6096333640426, 1276.7161067259492), b = point(1547.6285889453163, 1250.8823106459731)
    const deck = { ...metadata('original-deck'), role: 'bridge' as const, bridge: true, width: 13 }
    graph.add([a, b], deck, false)
    const history = structuredClone(graph.roadHistory)
    const reused = graph.reusableRoad([b, a], { ...deck, width: 10 })
    expect(reused?.id).toBe('original-deck')
    const batch = graph.addBatch([
      { points: [point(1600, 1100), b], metadata: { ...metadata('new-approach'), builtYear: 1900 }, requireConnection: false },
      { points: [b, a], metadata: { ...deck, id: 'duplicate-deck', builtYear: 1900 } },
      { points: [a, point(1400, 1400)], metadata: { ...metadata('new-exit'), builtYear: 1900 } },
    ])
    expect(batch).toHaveLength(3)
    expect(batch![1]!.id).toBe('original-deck')
    expect(graph.roads.filter(road => road.bridge)).toHaveLength(1)
    expect(graph.roadHistory.filter(version => version.value.id === 'original-deck')).toEqual(history)
    expect(Number.isFinite(graph.travelTime(point(1600, 1100), point(1400, 1400)))).toBe(true)
    expect(graph.reusableRoad([a, b], { ...deck, width: 14 })).toBeNull()
    expect(graph.reusableRoad([a, b], { ...deck, level: 1 })).toBeNull()
  })
  it('does not mistake a different curved route or another grade for the same owned corridor', () => {
    const graph = new PlanarRoadGraph()
    graph.add([point(0, 0), point(100, 60), point(200, 0)], metadata('curve'), false)
    expect(graph.reusableRoad([point(0, 0), point(200, 0)], metadata('straight'))).toBeNull()
    expect(graph.reusableRoad([point(0, 0), point(100, 60), point(200, 0)], { ...metadata('raised'), level: 1 })).toBeNull()
    expect(graph.reusableRoad([point(200, 0), point(100, 60), point(0, 0)], metadata('reverse'))?.id).toBe('curve')
  })
})
