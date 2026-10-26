import { describe, expect, it } from 'vitest'
import { buildContinuousCityRoads, continuousCityFaceCoverageQuery, continuousCityRoadGradeAllowed, partitionContinuousCityFace, surveyContinuousCityTrunks } from './continuous-city-roads'
import type { ContinuousCityRoadInput } from './continuous-city-types'
import type { Point, Road } from './types'
import { corridorPolygon, distance, distanceToSegment, intersectRegions, pointInPolygon, pointInRegion, polygonArea, polygonOverlapsRegion, rectangle, regionArea } from './geometry'
import { buildContinuousCityLandDomains } from './continuous-city-land-domains'
import { RailwayRoadConstraints } from './railway-road-constraints'
import { PlanarRoadGraph, projectOnRoadSegment } from './road-graph'
import { certifyLayoutAccess } from './layout-first-access'
import { onSurveyedBridge } from './surveyed-road-profile'

function fixture(width = 2000, height = 1600): ContinuousCityRoadInput {
  const center = { x: width / 2, y: height / 2 }, plain = { elevation: () => 12, slope: () => 0, waterAt: () => false, seaAt: () => false }
  return {
    config: { name: '連続市', seed: 'continuous-shared-streets', type: 'newtown', terrain: 'plain', density: 100, forest: 0, railway: false, stations: 1, arterial: true, facilities: [], settlement: 'metropolis' },
    environment: { width, height, areas: [], core: null, terrain: { ...plain, bridgeSites: [], continuationTerrain: plain } }, center, reservedRegions: [], railways: [],
    demand: { center, regions: [{ polygon: rectangle(0, 0, width, height) }], at: p => p.x > 0 && p.x < width && p.y > 0 && p.y < height ? 1 : 0, costAt: p => p.x < 0 || p.x > width || p.y < 0 || p.y > height ? Infinity : 0, openingAt: () => 1955, metrics: { cellSize: 60, reachableLandArea: width * height, targetUrbanArea: width * height, selectedUrbanArea: width * height } },
  }
}

// Independent last-leg measurement: a nearby street across water, a campus,
// or surface track supplies no frontage. Open T/tree streets count when their
// actual public pavement provides a clear dry connection.
function dryPublicDepthProbe(roads: Road[], input: ContinuousCityRoadInput, maximum = 90) {
  const rail = new RailwayRoadConstraints(input.railways), bins = new Map<string, { a: Point; b: Point }[]>()
  for (const road of roads) if (road.width >= 4.6 && !road.controlledAccess && (road.level ?? 0) === 0) for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]!, b = road.points[i]!
    for (let x = Math.floor((Math.min(a.x, b.x) - maximum) / 100); x <= Math.floor((Math.max(a.x, b.x) + maximum) / 100); x++) for (let y = Math.floor((Math.min(a.y, b.y) - maximum) / 100); y <= Math.floor((Math.max(a.y, b.y) + maximum) / 100); y++) {
      const key = `${x},${y}`, list = bins.get(key) ?? []; list.push({ a, b }); bins.set(key, list)
    }
  }
  return (point: Point) => {
    for (const { a, b } of bins.get(`${Math.floor(point.x / 100)},${Math.floor(point.y / 100)}`) ?? []) {
    const contact = projectOnRoadSegment(point, a, b).point, length = distance(point, contact)
    if (length > maximum) continue
    if (length < .1) return true
    if (rail.crossings([point, contact]).length || input.reservedRegions.some(region => polygonOverlapsRegion(corridorPolygon(point, contact, 1), region))) continue
    const count = Math.ceil(length / 4)
    if (Array.from({ length: count + 1 }, (_, n) => ({ x: point.x + (contact.x - point.x) * n / count, y: point.y + (contact.y - point.y) * n / count })).every(p => !input.environment.terrain?.waterAt(p))) return true
    }
    return false
  }
}

describe('continuous shared city streets', () => {
  it('matches exhaustive diagnostic containment at bin boundaries without changing saved geometry', () => {
    const polygons = [rectangle(-250, -250, 250, 250), rectangle(250, 0, 30, 500), [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 500 }, { x: 0, y: 500 }], []]
    for (const polygon of polygons) { polygon.forEach(Object.freeze); Object.freeze(polygon) }
    Object.freeze(polygons)
    const before = JSON.stringify(polygons), contains = continuousCityFaceCoverageQuery(polygons)
    const points: Point[] = []
    for (let y = -260; y <= 510; y += 17) for (let x = -260; x <= 510; x += 13) points.push({ x, y })
    for (const coordinate of [-250, 0, 250, 500]) for (const offset of [-1.01e-7, -.99e-7, 0, .99e-7, 1.01e-7]) points.push({ x: coordinate + offset, y: 0 }, { x: 0, y: coordinate + offset })
    for (const point of points) expect(contains(point)).toBe(polygons.some(polygon => pointInPolygon(point, polygon) || polygon.some((a, i) => distanceToSegment(point, a, polygon[(i + 1) % polygon.length]!) < 1e-7)))
    expect(JSON.stringify(polygons)).toBe(before)
  })
  it('measures intervening grade on a two-endpoint cut while retaining only registered bridge decks', () => {
    const points = [{ x: 0, y: 0 }, { x: 200, y: 0 }], elevation = (p: { x: number }) => Math.max(0, 10 - Math.abs(p.x - 100) * .2)
    expect(continuousCityRoadGradeAllowed({ points }, .13, elevation)).toBe(false)
    expect(continuousCityRoadGradeAllowed({ points, surveyedBridgeSpans: [{ bankA: { x: 50, y: 0 }, bankB: { x: 150, y: 0 }, riverId: 'ravine' }] }, .13, elevation)).toBe(true)
  })
  it('partitions an actual perimeter with exact polygon conservation, including a bent service street', () => {
    const face = rectangle(0, 0, 400, 250)
    const children = partitionContinuousCityFace(face, [{ x: 0, y: 90 }, { x: 180, y: 115 }, { x: 400, y: 100 }])!
    expect(children).toHaveLength(2)
    expect(children.reduce((sum, polygon) => sum + polygonArea(polygon), 0)).toBeCloseTo(polygonArea(face), 7)
    expect(partitionContinuousCityFace(face, [{ x: 0, y: 90 }, { x: 180, y: -30 }, { x: 400, y: 100 }])).toBeNull()
    expect(partitionContinuousCityFace(face, [{ x: 50, y: 50 }, { x: 400, y: 100 }])).toBeNull()
    const returning = partitionContinuousCityFace(face, [{ x: 0, y: 70 }, { x: 120, y: 70 }, { x: 120, y: 200 }, { x: 0, y: 200 }])!
    expect(returning).toHaveLength(2)
    expect(returning.reduce((sum, polygon) => sum + polygonArea(polygon), 0)).toBeCloseTo(polygonArea(face), 7)
  })

  it('rejects a normalized cut that loses an essential short bend before touching the actual parent graph', () => {
    const polygon = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100.01, y: 100.02 }, { x: 100.02, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }]
    const path = [{ x: 0, y: 100.01 }, { x: 100, y: 100.01 }, { x: 100.02, y: 100.04 }, { x: 200, y: 100.04 }], graph = new PlanarRoadGraph(), metadata = { id: 'perimeter', builtYear: 1955, role: 'lane' as const, width: 6, kind: 'local' as const, phase: 'test', reason: 'actual parent perimeter', constructionCost: 0 }
    graph.add([...polygon, polygon[0]!], metadata, false)
    expect(partitionContinuousCityFace(polygon, path)).not.toBeNull()
    const before = JSON.stringify({ roads: graph.roads, revision: graph.topologyRevision, history: graph.roadHistory })
    let normalized: Point[] = []
    const added = graph.add(path, { ...metadata, id: 'valid-only-before-normalization' }, true, candidate => { normalized = candidate.points.map(point => ({ ...point })); return !!partitionContinuousCityFace(polygon, normalized) })
    expect(normalized).not.toEqual(path)
    expect(partitionContinuousCityFace(polygon, normalized)).toBeNull()
    expect(added).toBeNull()
    expect(JSON.stringify({ roads: graph.roads, revision: graph.topologyRevision, history: graph.roadHistory })).toBe(before)
  })

  it('supplies sparse collector reach, actual dry plot frontage and opening-year gates without forcing ownership closure', () => {
    const input = fixture(), trunks = surveyContinuousCityTrunks(input)
    expect(trunks.diagnostics.boundaryConnections).toBeGreaterThanOrEqual(3)
    expect(trunks.roads.some(road => road.points[0]!.x < 0 && road.points.at(-1)!.x > 2000)).toBe(true)
    const gate = { id: 'school', point: { x: 1250, y: 1020 }, builtYear: 1875 }
    const result = buildContinuousCityRoads({ ...input, initialRoads: trunks.roads, accessTargets: [gate] })
    expect(result.diagnostics.unservedAccessIds).toEqual([])
    expect(certifyLayoutAccess({ width: 2000, height: 1600, roads: result.roads, targets: [gate] }).unserved).toEqual([])
    const collectors = result.diagnostics.collectorReachability!
    expect(collectors.servedAfter / collectors.samples).toBeGreaterThan(.95)
    expect(collectors.maximumDryDistance).toBeLessThanOrEqual(500)
    expect(collectors.attempted).toBeLessThanOrEqual(collectors.samples * 6)
    expect(new Set(result.roads.map(road => road.id)).size).toBe(result.roads.length)
    const savedGeometry = JSON.stringify({ roads: result.roads, blocks: result.blocks }), diagnosticSamples: Point[] = [], diagnosticStep = Math.max(120, Math.sqrt(2000 * 1600 / 1600))
    for (let y = diagnosticStep / 2; y < 1600; y += diagnosticStep) for (let x = diagnosticStep / 2; x < 2000; x += diagnosticStep) diagnosticSamples.push({ x, y })
    const exhaustiveCount = diagnosticSamples.filter(point => result.blocks.some(block => pointInPolygon(point, block.polygon) || block.polygon.some((a, i) => distanceToSegment(point, a, block.polygon[(i + 1) % block.polygon.length]!) < 1e-7))).length
    expect(diagnosticSamples.filter(continuousCityFaceCoverageQuery(result.blocks.map(block => block.polygon))).length).toBe(exhaustiveCount)
    expect(result.diagnostics.framedDemandSamples).toBe(exhaustiveCount)
    expect(result.diagnostics.demandCoverage).toBe(exhaustiveCount / diagnosticSamples.length)
    expect(JSON.stringify({ roads: result.roads, blocks: result.blocks })).toBe(savedGeometry)
    const service = result.diagnostics.localNetwork!
    expect(service.servedAfter).toBeGreaterThan(service.servedBefore)
    expect(service.attempted).toBeLessThanOrEqual(service.dryCells * 9)
    expect(service.connectedEnds).toBeGreaterThan(0)
    expect(service.deadEnds).toBeGreaterThan(0)
    // Deliberately offset from the driver's 32m cells. A 64m diagnostic must
    // not call a 60–100m courtyard served while only its border can hold lots.
    const supportsPlot = dryPublicDepthProbe(result.roads, input, 30)
    let probes = 0, usablePlots = 0, openButServed: Point | undefined
    for (let y = 27; y < 1600; y += 40) for (let x = 13; x < 2000; x += 40) {
      const point = { x, y }; probes++
      if (supportsPlot(point)) { usablePlots++; if (!openButServed && !result.blocks.some(block => pointInRegion(point, block))) openButServed = point }
    }
    expect(usablePlots / probes).toBeGreaterThan(.95)
    // Closed-face percentage is no longer an ownership condition: the new
    // disjoint fringe domains must retain this ACTUALLY served open ground.
    // Boundaries provide no invented frontage; dry public access was measured
    // independently above, and the land-domain suite checks actual acquisition.
    expect(openButServed).toBeDefined()
    const domains = buildContinuousCityLandDomains({ demandRegions: input.demand.regions, streetBlocks: result.blocks })
    expect(domains.fringe.some(domain => pointInRegion(openButServed!, domain))).toBe(true)
    expect(domains.domains.slice(0, result.blocks.length).every((block, i) => block === result.blocks[i])).toBe(true)
    expect(result.roads.filter(road => road.role === 'lane').every(road => road.points.slice(1).reduce((sum, b, i) => sum + distance(road.points[i]!, b), 0) <= 180.1)).toBe(true)
    const bins = new Map<string, { a: Point; b: Point }[]>(), adjacency = new Map<string, Set<string>>()
    // Same declared 5cm weld precision as the saved half-edge graph. Merely
    // read its vertices: rebuilding a design graph could repair a bad contact.
    const key = (point: Point) => `${Math.round(point.x * 20)},${Math.round(point.y * 20)}`
    for (const road of result.roads) {
      for (const point of road.points) if (!adjacency.has(key(point))) adjacency.set(key(point), new Set())
      for (let i = 1; i < road.points.length; i++) {
        const a = road.points[i - 1]!, b = road.points[i]!, ka = key(a), kb = key(b)
        adjacency.get(ka)!.add(kb); adjacency.get(kb)!.add(ka)
        for (let x = Math.floor((Math.min(a.x, b.x) - .06) / 100); x <= Math.floor((Math.max(a.x, b.x) + .06) / 100); x++) for (let y = Math.floor((Math.min(a.y, b.y) - .06) / 100); y <= Math.floor((Math.max(a.y, b.y) + .06) / 100); y++) {
          const bin = `${x},${y}`, segments = bins.get(bin) ?? []
          segments.push({ a, b }); bins.set(bin, segments)
        }
      }
    }
    for (const block of result.blocks) for (let i = 0; i < block.polygon.length; i++) {
      const a = block.polygon[i]!, b = block.polygon[(i + 1) % block.polygon.length]!
      const probe = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      expect((bins.get(`${Math.floor(probe.x / 100)},${Math.floor(probe.y / 100)}`) ?? []).some(segment => distanceToSegment(probe, segment.a, segment.b) < .06)).toBe(true)
    }
    const external = result.roads.flatMap(road => road.boundaryContinuation ? [road.points[0]!, road.points.at(-1)!] : []).find(point => point.x < 0 || point.x > 2000 || point.y < 0 || point.y > 1600)
    expect(external).toBeDefined()
    const reached = new Set([key(external!)]), queue = [...reached]
    for (let i = 0; i < queue.length; i++) for (const next of adjacency.get(queue[i]!) ?? []) if (!reached.has(next)) { reached.add(next); queue.push(next) }
    expect([...adjacency.keys()].filter(vertex => !reached.has(vertex))).toEqual([])
    expect(result.roads.filter(road => !reached.has(key(road.points[0]!)) || !reached.has(key(road.points.at(-1)!)))).toEqual([])
    expect(result.diagnostics.attempted).toBeLessThan(service.dryCells * 9 + result.diagnostics.demandSamples * 6 + 60)
  }, 15000)

  it('retains full compound protection and rail crossing separation while splitting dry parts of shared faces', () => {
    const input = fixture(), trunks = surveyContinuousCityTrunks(input), compound = { polygon: rectangle(1190, 420, 130, 150) }
    const railway = { id: 'main', name: '本線', points: [{ x: 1080, y: 0 }, { x: 1080, y: 1600 }] }
    const result = buildContinuousCityRoads({ ...input, initialRoads: trunks.roads, railways: [railway], reservedRegions: [compound] })
    for (const road of result.roads.filter(road => !trunks.roads.some(trunk => trunk.id === road.id))) for (let i = 1; i < road.points.length; i++) expect(polygonOverlapsRegion(corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2 + .75), compound)).toBe(false)
    const constraints = new RailwayRoadConstraints([railway]), all = result.roads.flatMap(road => constraints.crossings(road.points))
    const sites = all.filter((crossing, i) => !all.slice(0, i).some(other => distance(crossing.point, other.point) < 2))
    for (let i = 0; i < sites.length; i++) for (let j = 0; j < i; j++) expect(Math.abs(sites[i]!.chainage - sites[j]!.chainage)).toBeGreaterThanOrEqual(319.9)
    const supportsPlot = dryPublicDepthProbe(result.roads, input)
    expect(supportsPlot({ x: 600, y: 600 })).toBe(true)
    expect(supportsPlot({ x: 1500, y: 1000 })).toBe(true)
  }, 15000)

  it('reports requested modern transport unavailable rather than borrowing future street access', () => {
    const input = fixture(900, 750)
    const result = buildContinuousCityRoads({ ...input, config: { ...input.config, bypass: true, expressway: true }, initialRoads: [{ id: 'future-only', points: [{ x: -324, y: 375 }, { x: 1224, y: 375 }], kind: 'arterial', role: 'highway', width: 12, builtYear: 1995, boundaryContinuation: true }] })
    expect(result.diagnostics.modern.requested).toEqual(['bypass', 'expressway'])
    expect(result.diagnostics.modern.completed).toEqual([])
    expect(result.diagnostics.modern.unavailable.map(item => item.kind)).toEqual(['bypass', 'expressway'])
    expect(result.roads.every(road => (road.builtYear ?? 0) >= 1995)).toBe(true)
    // Both acquired vertices are outside. Actual segment projections, rather
    // than source vertex density or closure, must supply interior contacts.
    expect(result.roads.some(road => road.id !== 'future-only' && road.points.some(point => point.x > 0 && point.x < 900 && Math.abs(point.y - 375) < .05))).toBe(true)
    const supportsPlot = dryPublicDepthProbe(result.roads, input, 30)
    let probes = 0, served = 0
    for (let y = 27; y < 750; y += 40) for (let x = 13; x < 900; x += 40) { probes++; if (supportsPlot({ x, y })) served++ }
    expect(served / probes).toBeGreaterThan(.95)
  })

  it('crosses undemanded countryside and water only on a registered physical bank pair', () => {
    const input = fixture(1600, 1200), waterAt = (p: { x: number }) => p.x >= 780 && p.x <= 820
    const bridge = { point: { x: 800, y: 600 }, bankA: { x: 752, y: 600 }, bankB: { x: 848, y: 600 }, width: 40, cost: 100, riverId: 'river' }
    input.center = { x: 500, y: 600 }
    input.demand = { ...input.demand, at: p => p.x < 600 || p.x > 1000 ? 1 : 0, costAt: () => Infinity }
    input.environment.areas = [{ id: 'river', kind: 'water', polygon: rectangle(780, 0, 40, 1200) }]
    input.environment.terrain = { ...input.environment.terrain!, waterAt, bridgeSites: [bridge.point], bridgeCandidates: [bridge], continuationTerrain: { ...input.environment.terrain!.continuationTerrain!, waterAt } }
    const result = surveyContinuousCityTrunks(input)
    expect(result.diagnostics.boundaryConnections).toBeGreaterThanOrEqual(3)
    expect(result.diagnostics.bridgeSpans.length).toBeGreaterThan(0)
    for (const road of result.roads) for (const point of road.points.filter(waterAt)) {
      expect(onSurveyedBridge(point, road)).toBe(true)
      expect(Math.abs(point.y - 600)).toBeLessThan(1e-7)
    }
    for (const span of result.diagnostics.bridgeSpans) expect([span.bankA, span.bankB]).toEqual([bridge.bankA, bridge.bankB])
  })

  it('supplies dry collector reach independently across several north-south streams, a coast and a railway', () => {
    const input = fixture(3600, 2600), channels = [{ x: 900, width: 22 }, { x: 1700, width: 34 }, { x: 2600, width: 22 }]
    const seaAt = (p: { x: number; y: number }) => p.y > 2180 + p.x * .05
    const waterAt = (p: { x: number; y: number }) => seaAt(p) || channels.some(channel => Math.abs(p.x - channel.x) <= channel.width / 2)
    const candidates = channels.map((channel, i) => ({ point: { x: channel.x, y: 1100 }, bankA: { x: channel.x - channel.width / 2 - 32, y: 1100 }, bankB: { x: channel.x + channel.width / 2 + 32, y: 1100 }, width: channel.width, riverId: `river-${i}`, cost: 120 }))
    const channelAt = (p: { x: number; y: number }) => { const channel = channels.map((channel, i) => ({ ...channel, i })).sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x))[0]!; return { point: { x: channel.x, y: p.y }, tangent: { x: 0, y: 1 }, bankDistance: Math.abs(channel.x - p.x) - channel.width / 2, width: channel.width, surfaceElevation: 12, riverId: `river-${channel.i}` } }
    input.center = { x: 1950, y: 1100 }
    input.demand = { ...input.demand, at: p => p.x > 0 && p.x < 3600 && p.y > 0 && p.y < 2600 && !waterAt(p) ? 1 : 0 }
    input.environment.areas = [...channels.map((channel, i) => ({ id: `river-${i}`, kind: 'water' as const, polygon: rectangle(channel.x - channel.width / 2, 0, channel.width, 2600) })), { id: 'sea', kind: 'water', polygon: [{ x: 0, y: 2180 }, { x: 3600, y: 2360 }, { x: 3600, y: 2600 }, { x: 0, y: 2600 }] }]
    input.environment.terrain = { ...input.environment.terrain!, waterAt, seaAt, channelAt, rivers: channels.map((channel, i) => ({ id: `river-${i}`, points: [{ x: channel.x, y: 0 }, { x: channel.x, y: 2600 }] })), bridgeCandidates: candidates, continuationTerrain: { ...input.environment.terrain!.continuationTerrain!, waterAt, seaAt } }
    input.initialRoads = [{ id: 'acquired-main', points: [{ x: -324, y: 1100 }, ...candidates.flatMap(candidate => [candidate.bankA, candidate.bankB]), { x: 3924, y: 1100 }], kind: 'arterial', role: 'highway', width: 12, builtYear: 1650, boundaryContinuation: true, bridge: true, surveyedBridgeSpans: candidates.map(candidate => ({ bankA: candidate.bankA, bankB: candidate.bankB, riverId: candidate.riverId })) } as typeof input.initialRoads extends (infer R)[] | undefined ? R : never]
    input.railways = [{ id: 'surface-line', name: '本線', points: [{ x: 0, y: 1460 }, { x: 3600, y: 1460 }] }]
    input.reservedRegions = [{ polygon: rectangle(1860, 620, 160, 180) }]
    const result = buildContinuousCityRoads(input)
    const collectors = result.diagnostics.collectorReachability!
    expect(collectors.servedAfter / collectors.samples).toBeGreaterThan(.95)
    expect(collectors.maximumDryDistance).toBeLessThanOrEqual(500)
    expect(collectors.attempted).toBeLessThanOrEqual(collectors.samples * 6)
    const actualEnds = result.roads.flatMap(road => [road.points[0]!, road.points.at(-1)!].map((point, end) => ({ id: `${road.id}-${end}`, point, builtYear: road.builtYear ?? 1650 })))
    expect(certifyLayoutAccess({ width: 3600, height: 2600, roads: result.roads, targets: actualEnds }).unserved).toEqual([])
    for (const road of result.roads) for (const point of road.points) {
      expect(seaAt(point)).toBe(false)
      if (waterAt(point)) expect(onSurveyedBridge(point, road as Parameters<typeof onSurveyedBridge>[1])).toBe(true)
    }
    const constraints = new RailwayRoadConstraints(input.railways), crossings = result.roads.flatMap(road => constraints.crossings(road.points))
    const sites = crossings.filter((crossing, i) => !crossings.slice(0, i).some(other => distance(crossing.point, other.point) < 2))
    for (let i = 0; i < sites.length; i++) for (let j = 0; j < i; j++) expect(Math.abs(sites[i]!.chainage - sites[j]!.chainage)).toBeGreaterThanOrEqual(319.9)
  }, 30000)

  it('provides actual public frontage around a central reserved campus without requiring every street to divide its parent', () => {
    const input = fixture(1600, 1400), perimeter = rectangle(300, 200, 1000, 1000), campus = { polygon: rectangle(630, 500, 340, 400) }
    input.reservedRegions = [campus]
    input.initialRoads = perimeter.map((a, i) => ({ id: `acquired-perimeter-${i}`, points: [a, perimeter[(i + 1) % perimeter.length]!], role: 'collector', kind: 'local', width: 8.5, builtYear: 1955 }))
    const result = buildContinuousCityRoads(input)
    expect(result.diagnostics.localNetwork!.gainedAreaEstimate).toBeGreaterThan(0)
    const added = result.roads.filter(road => !road.id.startsWith('acquired-perimeter'))
    for (const road of added) for (let i = 1; i < road.points.length; i++) expect(polygonOverlapsRegion(corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2 + .75), campus)).toBe(false)
    // Final half-edge extraction welds vertices in 5cm bins and removes tiny
    // retraced excursions; require conservation to one square metre per km².
    expect(Math.abs(result.blocks.reduce((sum, block) => sum + intersectRegions(block, { polygon: perimeter }).reduce((area, region) => area + regionArea(region), 0), 0) - 1_000_000)).toBeLessThan(1)
    let dry = 0, served = 0
    const supportsPlot = dryPublicDepthProbe(result.roads, input)
    for (let y = 230; y < 1200; y += 60) for (let x = 330; x < 1300; x += 60) {
      const point = { x, y }
      if (pointInPolygon(point, campus.polygon)) continue
      dry++; if (supportsPlot(point)) served++
    }
    expect(served / dry).toBeGreaterThan(.95)
  }, 15000)

  it('serves the dry components of a large river/rail face without forcing a crossing through its campus', () => {
    const input = fixture(1600, 1600), perimeter = rectangle(200, 200, 1200, 1200), campus = { polygon: rectangle(370, 400, 260, 260) }, waterAt = (p: Point) => p.x >= 780 && p.x <= 820
    input.reservedRegions = [campus]
    input.environment.areas = [{ id: 'river', kind: 'water', polygon: rectangle(780, 0, 40, 1600) }]
    input.environment.terrain = { ...input.environment.terrain!, waterAt, continuationTerrain: { ...input.environment.terrain!.continuationTerrain!, waterAt } }
    input.railways = [{ id: 'running-line', name: '本線', points: [{ x: 0, y: 820 }, { x: 1600, y: 820 }] }]
    input.initialRoads = perimeter.map((a, i) => ({ id: `actual-perimeter-${i}`, points: [a, perimeter[(i + 1) % perimeter.length]!], role: 'collector', kind: 'local', width: 8.5, builtYear: 1955 }))
    const result = buildContinuousCityRoads(input)
    const actualStreetSegments = result.roads.filter(road => road.width >= 4.6 && !road.controlledAccess).flatMap(road => road.points.slice(1).map((b, i) => ({ a: road.points[i]!, b }))), rail = new RailwayRoadConstraints(input.railways)
    let dry = 0, served = 0
    for (let y = 230; y < 1400; y += 60) for (let x = 230; x < 1400; x += 60) {
      const point = { x, y }
      if (waterAt(point) || Math.abs(y - 820) < 10 || pointInPolygon(point, campus.polygon)) continue
      dry++
      // A campus can remain a large block. Measure the ACTUAL dry last leg,
      // rather than calling its buildable perimeter a void just because the
      // un-subtracted campus/rail parent polygon exceeds an area threshold.
      if (actualStreetSegments.some(({ a, b }) => {
        const contact = projectOnRoadSegment(point, a, b).point, length = distance(point, contact)
        if (length > 90) return false
        if (length < .1) return true
        const count = Math.ceil(length / 4)
        return !rail.crossings([point, contact]).length && !polygonOverlapsRegion(corridorPolygon(point, contact, 1), campus) && Array.from({ length: count + 1 }, (_, i) => ({ x: point.x + (contact.x - point.x) * i / count, y: point.y + (contact.y - point.y) * i / count })).every(p => !waterAt(p))
      })) served++
    }
    expect(served / dry).toBeGreaterThan(.9)
    for (const road of result.roads.filter(road => !road.id.startsWith('actual-perimeter'))) for (let i = 1; i < road.points.length; i++) expect(polygonOverlapsRegion(corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2 + .75), campus)).toBe(false)
  }, 15000)
})
