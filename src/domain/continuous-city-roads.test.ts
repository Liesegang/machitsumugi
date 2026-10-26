import { describe, expect, it } from 'vitest'
import { buildContinuousCityRoads, continuousCityRoadGradeAllowed, partitionContinuousCityFace, surveyContinuousCityTrunks } from './continuous-city-roads'
import type { ContinuousCityRoadInput } from './continuous-city-types'
import type { Point } from './types'
import { corridorPolygon, distance, distanceToSegment, pointInPolygon, polygonArea, polygonOverlapsRegion, rectangle } from './geometry'
import { RailwayRoadConstraints } from './railway-road-constraints'
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

describe('continuous shared city streets', () => {
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
  })

  it('frames almost all flat demand, subdivides real connected faces and serves opening-year gates', () => {
    const input = fixture(), trunks = surveyContinuousCityTrunks(input)
    expect(trunks.diagnostics.boundaryConnections).toBeGreaterThanOrEqual(3)
    expect(trunks.roads.some(road => road.points[0]!.x < 0 && road.points.at(-1)!.x > 2000)).toBe(true)
    const gate = { id: 'school', point: { x: 1250, y: 1020 }, builtYear: 1875 }
    const result = buildContinuousCityRoads({ ...input, initialRoads: trunks.roads, accessTargets: [gate] })
    expect(result.diagnostics.unservedAccessIds).toEqual([])
    expect(certifyLayoutAccess({ width: 2000, height: 1600, roads: result.roads, targets: [gate] }).unserved).toEqual([])
    expect(result.diagnostics.demandCoverage).toBeGreaterThan(.95)
    expect(new Set(result.roads.map(road => road.id)).size).toBe(result.roads.length)
    const living = result.blocks.filter(block => polygonArea(block.polygon) >= 900 && polygonArea(block.polygon) < 15000)
    expect(living.length).toBeGreaterThan(80)
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
    for (const block of living) for (let i = 0; i < block.polygon.length; i++) {
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
    expect(result.diagnostics.attempted).toBeLessThan(result.blocks.length * 6 + 60)
  }, 15000)

  it('retains full compound protection and rail crossing separation while splitting dry parts of shared faces', () => {
    const input = fixture(), trunks = surveyContinuousCityTrunks(input), compound = { polygon: rectangle(1190, 420, 130, 150) }
    const railway = { id: 'main', name: '本線', points: [{ x: 1080, y: 0 }, { x: 1080, y: 1600 }] }
    const result = buildContinuousCityRoads({ ...input, initialRoads: trunks.roads, railways: [railway], reservedRegions: [compound] })
    for (const road of result.roads.filter(road => !trunks.roads.some(trunk => trunk.id === road.id))) for (let i = 1; i < road.points.length; i++) expect(polygonOverlapsRegion(corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2 + .75), compound)).toBe(false)
    const constraints = new RailwayRoadConstraints([railway]), all = result.roads.flatMap(road => constraints.crossings(road.points))
    const sites = all.filter((crossing, i) => !all.slice(0, i).some(other => distance(crossing.point, other.point) < 2))
    for (let i = 0; i < sites.length; i++) for (let j = 0; j < i; j++) expect(Math.abs(sites[i]!.chainage - sites[j]!.chainage)).toBeGreaterThanOrEqual(319.9)
    expect(result.blocks.some(block => polygonArea(block.polygon) < 12000 && pointInPolygon({ x: 600, y: 600 }, block.polygon))).toBe(true)
    expect(result.blocks.some(block => polygonArea(block.polygon) < 12000 && pointInPolygon({ x: 1500, y: 1000 }, block.polygon))).toBe(true)
  }, 15000)

  it('reports requested modern transport unavailable rather than borrowing future street access', () => {
    const input = fixture(900, 750)
    const result = buildContinuousCityRoads({ ...input, config: { ...input.config, bypass: true, expressway: true }, initialRoads: [{ id: 'future-only', points: [{ x: -324, y: 375 }, { x: 1224, y: 375 }], kind: 'arterial', role: 'highway', width: 12, builtYear: 1995, boundaryContinuation: true }] })
    expect(result.diagnostics.modern.requested).toEqual(['bypass', 'expressway'])
    expect(result.diagnostics.modern.completed).toEqual([])
    expect(result.diagnostics.modern.unavailable.map(item => item.kind)).toEqual(['bypass', 'expressway'])
    expect(result.roads.every(road => (road.builtYear ?? 0) >= 1995)).toBe(true)
    // Both acquired vertices are outside: chainage sampling, rather than the
    // source polyline's vertex density, must supply the interior frame anchors.
    expect(result.diagnostics.demandCoverage).toBeGreaterThan(.90)
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

  it('closes broad shared urban faces independently across several north-south streams, a coast and a railway', () => {
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
    expect(result.diagnostics.demandCoverage).toBeGreaterThan(.90)
    expect(result.diagnostics.coarseFaces).toBeGreaterThan(24)
    expect(result.diagnostics.sharedExpansion.links).toBeGreaterThan(25)
    for (const road of result.roads) for (const point of road.points) {
      expect(seaAt(point)).toBe(false)
      if (waterAt(point)) expect(onSurveyedBridge(point, road as Parameters<typeof onSurveyedBridge>[1])).toBe(true)
    }
    const constraints = new RailwayRoadConstraints(input.railways), crossings = result.roads.flatMap(road => constraints.crossings(road.points))
    const sites = crossings.filter((crossing, i) => !crossings.slice(0, i).some(other => distance(crossing.point, other.point) < 2))
    for (let i = 0; i < sites.length; i++) for (let j = 0; j < i; j++) expect(Math.abs(sites[i]!.chainage - sites[j]!.chainage)).toBeGreaterThanOrEqual(319.9)
  }, 30000)

  it('uses a contained detour when all straight partitions hit the central reserved campus', () => {
    const input = fixture(1600, 1400), perimeter = rectangle(300, 200, 1000, 1000), campus = { polygon: rectangle(630, 500, 340, 400) }
    input.reservedRegions = [campus]
    input.initialRoads = perimeter.map((a, i) => ({ id: `acquired-perimeter-${i}`, points: [a, perimeter[(i + 1) % perimeter.length]!], role: 'collector', kind: 'local', width: 8.5, builtYear: 1955 }))
    const result = buildContinuousCityRoads(input)
    expect(result.diagnostics.largeFaceDetours.accepted).toBeGreaterThan(0)
    expect(result.diagnostics.largeFaceDetours.attempted).toBeLessThanOrEqual(2 * result.diagnostics.largeFaceDetours.faces)
    const added = result.roads.filter(road => !road.id.startsWith('acquired-perimeter'))
    for (const road of added) for (let i = 1; i < road.points.length; i++) expect(polygonOverlapsRegion(corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2 + .75), campus)).toBe(false)
    const firstDetour = added.find(road => road.reason?.startsWith('保護敷地・水域・鉄道'))!
    const children = partitionContinuousCityFace(perimeter, firstDetour.points)!
    expect(children.reduce((sum, polygon) => sum + polygonArea(polygon), 0)).toBeCloseTo(1_000_000, 6)
    // Final half-edge extraction welds vertices in 5cm bins and removes tiny
    // retraced excursions; require conservation to one square metre per km².
    expect(Math.abs(result.blocks.reduce((sum, block) => sum + polygonArea(block.polygon), 0) - 1_000_000)).toBeLessThan(1)
    expect(result.blocks.filter(block => polygonArea(block.polygon) < 25000).length).toBeGreaterThan(30)
  }, 15000)
})
