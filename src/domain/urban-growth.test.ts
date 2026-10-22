import { beforeAll, describe, expect, it } from 'vitest'
import type { Point } from './types'
import { simulateUrbanGrowth } from './urban-growth'
import type { UrbanGrowthInput, UrbanGrowthResult } from './urban-growth'

// An unobstructed test region isolates demand/transport interventions from terrain.
// These are model invariants, not empirical thresholds for Japanese cities.
const fixture: UrbanGrowthInput = {
  width: 1800, height: 1400, seed: 'causal-market-17', type: 'castle', center: { x: 900, y: 700 },
  core: null, areas: [], arterial: true, railway: true, stationPoints: [{ x: 620, y: 940 }], density: 65,
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
function toSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy
  const t = d ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / d)) : 0
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy })
}
function pathDistance(point: Point, path: Point[]) {
  let minimum = Infinity
  for (let i = 1; i < path.length; i++) minimum = Math.min(minimum, toSegment(point, path[i - 1], path[i]))
  return minimum
}
function pathLength(path: Point[]) { return path.slice(1).reduce((sum, p, i) => sum + distance(path[i], p), 0) }

function expectEarlierGeometry(earlier: UrbanGrowthResult, later: UrbanGrowthResult, throughYear: number) {
  const laterRoads = new Map(later.roads.map(road => [road.id, road]))
  const older = earlier.roads.filter(road => road.builtYear <= throughYear)
  expect(older.length).toBeGreaterThan(0)
  for (const road of older) {
    const retained = laterRoads.get(road.id)
    expect(retained, `missing historic road ${road.id}`).toBeDefined()
    expect(retained!.builtYear).toBe(road.builtYear)
    expect(retained!.phase).toBe(road.phase)
    // Later junctions may insert vertices; compare centerlines instead of arrays.
    for (const point of road.points) expect(pathDistance(point, retained!.points)).toBeLessThan(.1)
    for (const point of retained!.points) expect(pathDistance(point, road.points)).toBeLessThan(.1)
    expect(Math.abs(pathLength(road.points) - pathLength(retained!.points))).toBeLessThan(.2)
  }
  expect(later.roads.filter(road => road.builtYear <= throughYear).map(r => r.id).sort()).toEqual(older.map(r => r.id).sort())
}

/** Independent geometric graph reconstruction; 10 cm tolerates floating point snaps. */
function topology(result: UrbanGrowthResult) {
  const points: Point[] = [], buckets = new Map<string, number[]>(), parents: number[] = [], edges = new Set<string>()
  const root = (n: number): number => parents[n] === n ? n : (parents[n] = root(parents[n]))
  const node = (p: Point) => {
    const x = Math.floor(p.x / .1), y = Math.floor(p.y / .1)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const id of buckets.get(`${x + dx}:${y + dy}`) ?? []) if (distance(points[id], p) < .1) return id
    const id = points.length, key = `${x}:${y}`
    points.push(p); parents.push(id); buckets.set(key, [...buckets.get(key) ?? [], id])
    return id
  }
  for (const road of result.roads) for (let i = 1; i < road.points.length; i++) {
    const a = node(road.points[i - 1]), b = node(road.points[i])
    if (a === b) continue
    edges.add(a < b ? `${a}:${b}` : `${b}:${a}`)
    parents[root(a)] = root(b)
  }
  const components = new Set(points.map((_, i) => root(i))).size
  return { components, loops: edges.size - points.length + components }
}

function expectSplitCrossings(result: UrbanGrowthResult) {
  const segments = result.roads.flatMap(road => road.points.slice(1).map((b, i) => {
    const a = road.points[i]
    return { a, b, road: road.id, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) }
  })).sort((a, b) => a.minX - b.minX)
  for (let i = 0; i < segments.length; i++) {
    const a = segments[i], rx = a.b.x - a.a.x, ry = a.b.y - a.a.y
    for (let j = i + 1; j < segments.length && segments[j].minX <= a.maxX; j++) {
      const b = segments[j]
      if (b.minY > a.maxY || b.maxY < a.minY) continue
      const sx = b.b.x - b.a.x, sy = b.b.y - b.a.y, denominator = rx * sy - ry * sx
      if (Math.abs(denominator) < .0000001) continue
      const qx = b.a.x - a.a.x, qy = b.a.y - a.a.y
      const t = (qx * sy - qy * sx) / denominator, u = (qx * ry - qy * rx) / denominator
      if (t < 0 || t > 1 || u < 0 || u > 1) continue
      const intersection = { x: a.a.x + t * rx, y: a.a.y + t * ry }
      expect(Math.min(distance(intersection, a.a), distance(intersection, a.b)), `unsplit crossing on ${a.road} / ${b.road}`).toBeLessThan(.1)
      expect(Math.min(distance(intersection, b.a), distance(intersection, b.b)), `unsplit crossing on ${b.road} / ${a.road}`).toBeLessThan(.1)
    }
  }
}

describe('urban growth causal invariants', () => {
  let zero: UrbanGrowthResult, historic: UrbanGrowthResult, railway: UrbanGrowthResult, present: UrbanGrowthResult, withoutRailway: UrbanGrowthResult, repeated: UrbanGrowthResult
  beforeAll(() => {
    zero = simulateUrbanGrowth({ ...fixture, density: 0, era: 'present' })
    historic = simulateUrbanGrowth({ ...fixture, era: 'historic' })
    railway = simulateUrbanGrowth({ ...fixture, era: 'railway' })
    present = simulateUrbanGrowth({ ...fixture, era: 'present' })
    withoutRailway = simulateUrbanGrowth({ ...fixture, railway: false, era: 'present' })
    repeated = simulateUrbanGrowth({ ...fixture, era: 'historic' })
  }, 120_000)

  it('does not schedule later expansion with demand set to zero', () => {
    expect(zero.roads.length).toBeGreaterThan(0)
    expect(zero.roads.every(road => road.builtYear < 1700)).toBe(true)
    expect(zero.growthLog.filter(stage => stage.year >= 1700).every(stage => stage.roadsAdded === 0 && stage.constructionCost === 0)).toBe(true)
    expect(zero.centers.some(center => center.kind === 'station' || center.kind === 'suburb')).toBe(false)
  })

  it('changes actual development decisions when positive demand is introduced', () => {
    expect(present.demandSchedule.at(-1)!.households).toBeGreaterThan(zero.demandSchedule.at(-1)!.households)
    expect(present.roads.some(road => road.builtYear >= 1700 && road.phase !== 'regional')).toBe(true)
    expect(present.developmentCells.reduce((n, cell) => n + cell.households, 0)).toBeGreaterThan(zero.developmentCells.reduce((n, cell) => n + cell.households, 0))
  })

  it('preserves the established street centerlines when later eras are simulated', () => {
    expectEarlierGeometry(historic, railway, 1800)
    expectEarlierGeometry(historic, present, 1800)
    expect(historic.roads.every(road => road.builtYear <= 1800)).toBe(true)
    expect(railway.roads.every(road => road.builtYear <= 1930)).toBe(true)
  })

  it('cannot let a future railway change the pre-1900 road history', () => {
    expectEarlierGeometry(withoutRailway, present, 1899)
    expect(historic.centers.some(center => center.kind === 'station')).toBe(false)
    expect(present.centers.some(center => center.kind === 'station' && center.activeYear >= 1900)).toBe(true)
    expect(withoutRailway.centers.some(center => center.kind === 'station')).toBe(false)
    expect(present.growthLog.filter(stage => stage.year < 1900)).toEqual(withoutRailway.growthLog.filter(stage => stage.year < 1900))
  })

  it('produces a connected planar street network with bounded faces in the unobstructed town', () => {
    expect(topology(present).components).toBe(1)
    expect(topology(present).loops).toBeGreaterThan(0)
    expect(present.blocks.length).toBeGreaterThan(0)
    expectSplitCrossings(present)
  })

  it('replays the same seed and inputs exactly, including chronological decisions', () => {
    expect(repeated).toEqual(historic)
  })
})
