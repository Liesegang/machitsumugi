import { expect } from 'vitest'
import { corridorPolygon, distance, distanceToSegment, intersectRegions, pointInPolygon, polygonArea, regionArea, segmentsCross, subtractRegions } from '../geometry'
import type { castleLayout } from '../castle-layout'
import type { Point } from '../types'

export type CastleGeometry = ReturnType<typeof castleLayout>
export const compounds = (castle: CastleGeometry) => castle.enclosures as Record<string, Point[]>
const area = (polygon: Point[]) => ({ polygon })
const intersectionArea = (a: Point[], b: { polygon: Point[]; holes?: Point[][] }) => intersectRegions(area(a), b).reduce((sum, r) => sum + regionArea(r), 0)
const outsideArea = (a: Point[], b: Point[]) => subtractRegions(area(a), [area(b)]).reduce((sum, r) => sum + regionArea(r), 0)

/** Edge determinants share one scale under every affine transform. Normalize
 * their cyclic sequence so rotation, shear, stretch and subdivision cannot make
 * the same polygon template look like a genuinely different castle plan. */
export function affineRingSignature(points: Point[]) {
  let ring = points.filter((p, i) => distance(p, points[(i + points.length - 1) % points.length]!) > 1e-7), changed = true
  while (changed && ring.length > 3) {
    changed = false
    ring = ring.filter((p, i, all) => {
      const a = all[(i + all.length - 1) % all.length]!, b = all[(i + 1) % all.length]!, cross = (p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)
      const keep = Math.abs(cross) > 1e-7 * Math.max(1, distance(a, p) * distance(p, b))
      changed ||= !keep
      return keep
    })
  }
  const signature = (vertices: Point[]) => {
    const edges = vertices.map((a, i) => { const b = vertices[(i + 1) % vertices.length]!; return { x: b.x - a.x, y: b.y - a.y } })
    const wedges = edges.map((a, i) => { const b = edges[(i + 1) % edges.length]!; return a.x * b.y - a.y * b.x }), scale = wedges.reduce((n, x) => n + Math.abs(x), 0)
    const values = wedges.map(x => Math.round(x / (scale || 1) * 100_000))
    return values.map((_, i) => [...values.slice(i), ...values.slice(0, i)].join(',')).sort()[0]!
  }
  return [signature(ring), signature([...ring].reverse())].sort()[0]!
}

export function castleShapeSignature(castle: CastleGeometry) {
  const enclosures = compounds(castle), total = Object.values(enclosures).reduce((n, p) => n + polygonArea(p), 0)
  return `${affineRingSignature(castle.core)};${Object.entries(enclosures).sort().map(([name, p]) => `${name}:${Math.round(polygonArea(p) / total * 10_000)}`).join(';')}`
}

/** Independent footprint/topology contracts, without fixed vertex counts,
 * a fixed total structure count, or one particular historical castle plan. */
export function expectCastlePhysicalGeometry(castle: CastleGeometry) {
  const enclosures = compounds(castle), names = ['honmaru', 'ninomaru', 'sannomaru']
  expect(Object.keys(enclosures)).toEqual(expect.arrayContaining(names))
  for (const name of names) {
    const polygon = enclosures[name]!
    expect(polygon.length).toBeGreaterThanOrEqual(4)
    expect(polygonArea(polygon)).toBeGreaterThan(500)
    expect(outsideArea(polygon, castle.core)).toBeLessThan(.01)
    for (let i = 0; i < polygon.length; i++) for (let j = i + 2; j < polygon.length; j++) if (!(i === 0 && j === polygon.length - 1)) expect(segmentsCross(polygon[i]!, polygon[(i + 1) % polygon.length]!, polygon[j]!, polygon[(j + 1) % polygon.length]!)).toBe(false)
    expect(castle.grounds.some(g => g.id.startsWith(`castle-courtyard-${name}`) && intersectionArea(polygon, g) > 500)).toBe(true)
    for (const water of castle.areas) expect(intersectionArea(polygon, water)).toBeLessThan(.01)
  }
  for (const [i, name] of names.entries()) for (const other of names.slice(i + 1)) expect(intersectionArea(enclosures[name]!, area(enclosures[other]!))).toBeLessThan(.01)
  expect(castle.structures.map(b => b.id)).toEqual(expect.arrayContaining(['castle-keep', 'castle-small-keep', 'castle-palace', 'castle-ninomaru-palace']))
  for (const [i, building] of castle.structures.entries()) {
    expect(building.kind).toBe('public'); expect(building.builtYear).toBe(1650)
    expect(names.some(name => outsideArea(building.polygon, enclosures[name]!) < .01)).toBe(true)
    expect(castle.areas.some(w => intersectionArea(building.polygon, w) > .01)).toBe(false)
    for (const other of castle.structures.slice(i + 1)) expect(intersectionArea(building.polygon, area(other.polygon))).toBeLessThan(.01)
  }
  const key = (p: Point) => `${p.x.toFixed(7)}:${p.y.toFixed(7)}`, pending = [castle.gate.inside], visited = new Set<string>()
  while (pending.length) {
    const p = pending.pop()!, id = key(p)
    if (visited.has(id)) continue
    visited.add(id)
    for (const path of castle.paths) for (let i = 1; i < path.points.length; i++) {
      if (key(path.points[i - 1]!) === id) pending.push(path.points[i]!)
      if (key(path.points[i]!) === id) pending.push(path.points[i - 1]!)
    }
  }
  const walls = castle.grounds.filter(g => g.id.startsWith('castle-wall-'))
  for (const path of castle.paths) {
    expect(path.builtYear).toBe(1650)
    expect(path.points.every(p => visited.has(key(p)))).toBe(true)
    for (let i = 1; i < path.points.length; i++) {
      const paving = corridorPolygon(path.points[i - 1]!, path.points[i]!, path.width / 2)
      expect(outsideArea(paving, castle.core)).toBeLessThan(.01)
      for (const obstacle of [...castle.areas, ...walls, ...castle.structures]) expect(intersectionArea(paving, obstacle)).toBeLessThan(.01)
    }
  }
  for (const name of names) expect(castle.paths.some(path => path.points.slice(1).some((b, i) => distance(path.points[i]!, b) >= 12 && pointInPolygon({ x: (path.points[i]!.x + b.x) / 2, y: (path.points[i]!.y + b.y) / 2 }, enclosures[name]!)))).toBe(true)
  for (const building of castle.structures) {
    let nearest = Infinity
    for (const path of castle.paths) for (let i = 1; i < path.points.length; i++) for (let j = 0; j < building.polygon.length; j++) {
      const a = path.points[i - 1]!, b = path.points[i]!, p = building.polygon[j]!, q = building.polygon[(j + 1) % building.polygon.length]!
      nearest = Math.min(nearest, distanceToSegment(p, a, b), distanceToSegment(q, a, b), distanceToSegment(a, p, q), distanceToSegment(b, p, q))
    }
    expect(nearest).toBeLessThanOrEqual(12)
  }
  for (const crossing of castle.gateCrossings) for (const obstacle of [...castle.areas, ...walls]) expect(intersectionArea(crossing, obstacle)).toBeLessThan(.01)
}
