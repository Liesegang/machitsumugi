import { beforeAll, describe, expect, it } from 'vitest'
import { surveyContinuousCityRoadFrame } from './continuous-city-roads'
import type { ContinuousCityRoadInput } from './continuous-city-types'
import type { Point, Road } from './types'
import { corridorPolygon, distance, distanceToSegment, polygonOverlapsRegion, rectangle } from './geometry'
import { certifyLayoutAccess } from './layout-first-access'

function fixture(arterial = true, width = 3000, height = 2400, regional = false): ContinuousCityRoadInput {
  const center = { x: width / 2, y: height / 2 }
  const plain = { elevation: () => 12, slope: () => 0, waterAt: () => false, seaAt: () => false }
  const initialRoads: Road[] = [
    { id: 'regional-east-west', points: [{ x: -250, y: center.y }, center, { x: width + 250, y: center.y }], width: 12, kind: 'arterial', role: 'highway', builtYear: 1650, boundaryContinuation: true },
    { id: 'regional-north-south', points: [{ x: center.x, y: -250 }, center, { x: center.x, y: height + 250 }], width: 11, kind: 'arterial', role: 'collector', builtYear: 1900, boundaryContinuation: true },
  ]
  return {
    config: { name: '地区幹線試験市', seed: 'major-neighbourhood-network', type: 'newtown', terrain: 'plain', density: 100, forest: 0, railway: false, stations: 1, arterial, facilities: [], settlement: 'metropolis', targetYear: 2025 },
    environment: { width, height, areas: [], core: null, terrain: { ...plain, bridgeSites: [], ...(regional ? { continuationTerrain: plain } : {}) } },
    center, initialRoads, reservedRegions: [], railways: [],
    demand: { center, regions: [{ polygon: rectangle(0, 0, width, height) }], at: p => p.x > 0 && p.x < width && p.y > 0 && p.y < height ? 1 : 0, costAt: p => p.x < 0 || p.x > width || p.y < 0 || p.y > height ? Infinity : 0, openingAt: () => 1955, metrics: { cellSize: 60, reachableLandArea: width * height, targetUrbanArea: width * height, selectedUrbanArea: width * height } },
  }
}

const major = (road: Road) => road.width >= 8 && !road.controlledAccess && (road.level ?? 0) === 0
const length = (road: Road) => road.points.slice(1).reduce((sum, p, i) => sum + distance(road.points[i]!, p), 0)
const depth = (point: Point, roads: Road[]) => Math.min(...roads.filter(major).flatMap(road => road.points.slice(1).map((p, i) => distanceToSegment(point, road.points[i]!, p))))
function depthP90(roads: Road[]) {
  // Offset probes are independent of the generator's demand sampling lattice.
  const values: number[] = []
  for (let y = 87; y < 2400; y += 113) for (let x = 71; x < 3000; x += 127) values.push(depth({ x, y }, roads))
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length * .9)]!
}
function cycleRank(roads: Road[]) {
  const adjacency = new Map<string, Set<string>>(), key = (p: Point) => `${Math.round(p.x * 1e4)}:${Math.round(p.y * 1e4)}`
  let edges = 0, components = 0
  for (const road of roads.filter(major)) for (let i = 1; i < road.points.length; i++) {
    const a = key(road.points[i - 1]!), b = key(road.points[i]!)
    if (a === b) continue
    if (!adjacency.has(a)) adjacency.set(a, new Set())
    if (!adjacency.has(b)) adjacency.set(b, new Set())
    if (!adjacency.get(a)!.has(b)) edges++
    adjacency.get(a)!.add(b); adjacency.get(b)!.add(a)
  }
  const seen = new Set<string>()
  for (const start of adjacency.keys()) if (!seen.has(start)) {
    components++; const pending = [start]; seen.add(start)
    for (let i = 0; i < pending.length; i++) for (const next of adjacency.get(pending[i]!)!) if (!seen.has(next)) { seen.add(next); pending.push(next) }
  }
  return edges - adjacency.size + components
}

describe('continuous neighbourhood arterial frame', () => {
  const input = fixture(), before = JSON.stringify({ roads: input.initialRoads, regions: input.demand.regions })
  let result: ReturnType<typeof surveyContinuousCityRoadFrame>
  beforeAll(() => { result = surveyContinuousCityRoadFrame(input) }, 15000)

  it('constructs new two-ended major pavement with dated outside access instead of repainting local lanes', () => {
    const originalIds = new Set(input.initialRoads!.map(road => road.id)), added = result.roads.filter(road => major(road) && !originalIds.has(road.id))
    expect(added.length).toBeGreaterThan(0)
    expect(added.reduce((sum, road) => sum + length(road), 0)).toBeGreaterThan(500)
    expect(result.diagnostics.arterialNetwork!.routes).toBeGreaterThan(0)
    expect(result.roads.some(road => road.width === 4.8)).toBe(false)
    for (const road of added) {
      expect(road.kind).toBe('arterial')
      expect(road.builtYear).toBeGreaterThanOrEqual(1955)
      const otherMajor = result.roads.filter(other => other.id !== road.id && major(other) && (other.builtYear ?? 1650) <= (road.builtYear ?? 1650))
      for (const point of [road.points[0]!, road.points.at(-1)!]) expect(depth(point, otherMajor)).toBeLessThan(.001)
      expect(length(road) / distance(road.points[0]!, road.points.at(-1)!)).toBeLessThanOrEqual(1.65 + .001)
    }
    const targets = added.flatMap(road => [road.points[0]!, road.points.at(-1)!].map((point, i) => ({ id: `${road.id}-${i}`, point, builtYear: road.builtYear ?? 1650 })))
    expect(certifyLayoutAccess({ width: 3000, height: 2400, roads: result.roads, targets }).unserved).toEqual([])
    expect(JSON.stringify({ roads: input.initialRoads, regions: input.demand.regions })).toBe(before)
  })

  it('improves independently sampled access to real major roads and adds alternatives to the initial crossing', () => {
    expect(depthP90(result.roads)).toBeLessThan(depthP90(input.initialRoads!) * .95)
    expect(cycleRank(input.initialRoads!)).toBe(0)
    expect(cycleRank(result.roads)).toBeGreaterThan(0)
    const diagnostic = result.diagnostics.arterialNetwork!
    expect(diagnostic.servedAfter).toBeGreaterThan(diagnostic.servedBefore)
    expect(diagnostic.links.every(link => link.length > 0 && link.ratio <= 1.65 + .001)).toBe(true)
  })

  it('retains the protected campus across the full pavement width', () => {
    const input = fixture(), campus = { polygon: rectangle(2050, 350, 300, 400) }
    input.reservedRegions = [campus]
    const before = JSON.stringify(campus), result = surveyContinuousCityRoadFrame(input)
    expect(result.diagnostics.arterialNetwork!.routes).toBeGreaterThan(0)
    const originalIds = new Set(input.initialRoads!.map(road => road.id))
    for (const road of result.roads.filter(road => !originalIds.has(road.id))) for (let i = 1; i < road.points.length; i++) expect(polygonOverlapsRegion(corridorPolygon(road.points[i - 1]!, road.points[i]!, road.width / 2 + .75), campus)).toBe(false)
    expect(JSON.stringify(campus)).toBe(before)
  }, 15000)

  it('keeps the inherited physical mains but skips new arterial acquisition when disabled', () => {
    const input = fixture(false), before = JSON.stringify(input.initialRoads), result = surveyContinuousCityRoadFrame(input)
    const originalIds = new Set(input.initialRoads!.map(road => road.id))
    expect(result.diagnostics.arterialNetwork?.routes ?? 0).toBe(0)
    expect(result.roads.filter(road => major(road) && !originalIds.has(road.id))).toEqual([])
    expect(result.roads.filter(major).reduce((sum, road) => sum + length(road), 0)).toBeCloseTo(input.initialRoads!.reduce((sum, road) => sum + length(road), 0), 6)
    expect(JSON.stringify(input.initialRoads)).toBe(before)
  }, 15000)

  it('surveys additional regional outlets for a large developed basin using actual surrounding terrain', () => {
    const input = fixture(true, 6000, 4500, true), before = JSON.stringify(input.initialRoads), result = surveyContinuousCityRoadFrame(input)
    const added = result.roads.filter(road => road.boundaryContinuation && !input.initialRoads!.some(old => old.id === road.id))
    expect(result.diagnostics.regionalDistrictRoutes!.routes).toBeGreaterThan(0)
    expect(added.length).toBeGreaterThan(0)
    for (const road of added) {
      expect(road.width).toBeGreaterThanOrEqual(9)
      expect(road.kind).toBe('arterial')
      expect(road.builtYear).toBeGreaterThanOrEqual(1955)
      const end = road.points.at(-1)!
      expect(end.x < 0 || end.x > 6000 || end.y < 0 || end.y > 4500).toBe(true)
      expect(length(road) / distance(road.points[0]!, end)).toBeLessThanOrEqual(1.65 + .001)
    }
    const targets = added.map(road => ({ id: road.id, point: road.points[0]!, builtYear: road.builtYear ?? 1650 }))
    expect(certifyLayoutAccess({ width: 6000, height: 4500, roads: result.roads, targets }).unserved).toEqual([])
    expect(JSON.stringify(input.initialRoads)).toBe(before)
    const localOnly = fixture(true, 6000, 4500)
    delete localOnly.environment.terrain!.continuationTerrain
    expect(surveyContinuousCityRoadFrame(localOnly).diagnostics.regionalDistrictRoutes).toBeUndefined()
  }, 15000)
})
