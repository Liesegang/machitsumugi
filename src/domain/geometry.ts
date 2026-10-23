import type { Point } from './types'
import { difference as fastDifference, intersection as fastIntersection, union as fastUnion } from 'polygon-clipping'
import ClipperLib from 'clipper-lib'
import type { Path, PolyNode } from 'clipper-lib'
type Polygon = [number, number][][]
type MultiPolygon = Polygon[]
// Library errors must propagate to the worker instead of calling browser alert().
;(ClipperLib as typeof ClipperLib & { Error: (message: string) => never }).Error = message => { throw new Error(message) }
export const clippingDiagnostics = { operations: 0, preciseFallbacks: 0, preciseMilliseconds: 0, canonicalizationSkips: 0 }
export interface PolygonRegion { polygon: Point[]; holes?: Point[][] }
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number }
export const boundsOf = (points: Point[]): Bounds => ({ minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)) })
export const overlaps = (a: Bounds, b: Bounds) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
export const rectangle = (x: number, y: number, width: number, height: number): Point[] => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }]
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
export function seededRandom(seed: string) {
  let hash = 2166136261
  for (const c of seed) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619)
  return () => { hash += 0x6d2b79f5; let t = hash; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 }
}
export function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
export function segmentsCross(a: Point, b: Point, c: Point, d: Point) { return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0 }
export function polygonsOverlap(a: Point[], b: Point[]) {
  if (!overlaps(boundsOf(a), boundsOf(b))) return false
  return a.some(p => pointInPolygon(p, b)) || b.some(p => pointInPolygon(p, a)) || a.some((p, i) => b.some((q, j) => segmentsCross(p, a[(i + 1) % a.length]!, q, b[(j + 1) % b.length]!)))
}
export function projectPoint(point: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return { x: a.x + dx * t, y: a.y + dy * t }
}
export const distanceToSegment = (point: Point, a: Point, b: Point) => distance(point, projectPoint(point, a, b))
export const polygonArea = (polygon: Point[]) => Math.abs(polygon.reduce((sum, p, i) => { const q = polygon[(i + 1) % polygon.length]!; return sum + p.x * q.y - q.x * p.y }, 0)) / 2
export const regionArea = (region: PolygonRegion) => polygonArea(region.polygon) - (region.holes ?? []).reduce((sum, hole) => sum + polygonArea(hole), 0)
export const pointInRegion = (point: Point, region: PolygonRegion) => pointInPolygon(point, region.polygon) && !(region.holes ?? []).some(hole => pointInPolygon(point, hole))
/** An island/clearing inside a hole is available land; crossing its bank is not. */
export function polygonOverlapsRegion(polygon: Point[], region: PolygonRegion) {
  if (!polygonsOverlap(polygon, region.polygon)) return false
  return !(region.holes ?? []).some(hole => polygon.every(p => pointInPolygon(p, hole)) && !polygon.some((p, i) => hole.some((q, j) => segmentsCross(p, polygon[(i + 1) % polygon.length]!, q, hole[(j + 1) % hole.length]!))))
}
// A common submillimetre lattice keeps acquired boundaries compatible. Rounding
// an output ring to centimetres can collapse a narrow connection and invalidate it.
const clipGeometry = (region: PolygonRegion, precision = 10_000): Polygon => [region.polygon, ...region.holes ?? []].map(ring => ring.map(p => [Math.round(p.x * precision) / precision, Math.round(p.y * precision) / precision]))
function clippedRegions(geometry: MultiPolygon): PolygonRegion[] {
  return geometry.map(rings => {
    const points = rings.map(ring => ring.slice(0, -1).map(p => ({ x: p[0], y: p[1] })).filter((p, i, all) => i === 0 || p.x !== all[i - 1]!.x || p.y !== all[i - 1]!.y))
    const holes = points.slice(1).filter(hole => hole.length >= 3 && polygonArea(hole) > .01)
    return { polygon: points[0]!, ...(holes.length ? { holes } : {}) }
  }).filter(region => region.polygon.length >= 3 && regionArea(region) > .01)
}
/** Vatti integer clipping is independent of the floating sweep used above.
 * Submillimetre internal coordinates preserve the centimetre survey boundaries;
 * the PolyTree retains holes and nested islands instead of flattening rings. */
function integerClip(subject: Polygon, obstacles: Polygon[], operation: 'difference' | 'intersection'): PolygonRegion[] {
  const scale = 10_000
  const paths = (polygon: Polygon): Path[] => polygon.map((ring, index) => {
    const path = ring.map(([x, y]) => ({ X: Math.round(x * scale), Y: Math.round(y * scale) }))
    if (ClipperLib.Clipper.Orientation(path) !== (index === 0)) path.reverse()
    return path
  })
  const clipper = new ClipperLib.Clipper()
  clipper.StrictlySimple = true
  if (!clipper.AddPaths(paths(subject), ClipperLib.PolyType.ptSubject, true)) throw new Error('土地境界の入力に面積がありません。')
  // Resolve shared acquisition edges before the difference. Otherwise adjacent
  // clip contours can survive as touching holes rather than one continuous hole.
  const mergedCuts: Path[] = [], merger = new ClipperLib.Clipper()
  merger.AddPaths(obstacles.flatMap(paths), ClipperLib.PolyType.ptSubject, true)
  if (!merger.Execute(ClipperLib.ClipType.ctUnion, mergedCuts, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) throw new Error('取得境界の結合に失敗しました。')
  clipper.AddPaths(mergedCuts, ClipperLib.PolyType.ptClip, true)
  const tree = new ClipperLib.PolyTree()
  const success = clipper.Execute(operation === 'difference' ? ClipperLib.ClipType.ctDifference : ClipperLib.ClipType.ctIntersection, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  if (!success) throw new Error('土地境界の整数座標計算に失敗しました。')
  const geometry: MultiPolygon = []
  const ring = (node: PolyNode): [number, number][] => {
    const points: [number, number][] = node.Contour().map(p => [p.X / scale, p.Y / scale])
    return [...points, points[0]!]
  }
  const visit = (node: PolyNode) => {
    if (!node.IsHole() && node.Contour().length >= 3) geometry.push([ring(node), ...node.Childs().filter(child => child.IsHole()).map(ring)])
    for (const child of node.Childs()) visit(child)
  }
  visit(tree)
  // Vatti may retain adjacent holes sharing an edge. Their filled region is
  // correct; a union canonicalizes those contours for other polygon readers.
  try { return clippedRegions(fastUnion(geometry)) }
  catch { clippingDiagnostics.canonicalizationSkips++; return clippedRegions(geometry) }
}
/** Exact land conversion keeps the unconverted remainder, including enclosed holes. */
export function subtractRegions(subject: PolygonRegion, obstacles: PolygonRegion[]): PolygonRegion[] {
  const nearby = obstacles.filter(obstacle => polygonOverlapsRegion(subject.polygon, obstacle))
  if (!nearby.length) return [subject]
  for (const obstacle of nearby) {
    const boundaryCrosses = subject.polygon.some((p, i) => obstacle.polygon.some((q, j) => segmentsCross(p, subject.polygon[(i + 1) % subject.polygon.length]!, q, obstacle.polygon[(j + 1) % obstacle.polygon.length]!)))
    if (!boundaryCrosses && subject.polygon.every(p => pointInRegion(p, obstacle)) && !(obstacle.holes ?? []).some(hole => polygonsOverlap(subject.polygon, hole))) return []
  }
  const geometry = clipGeometry(subject), cuts = nearby.map(obstacle => clipGeometry(obstacle))
  clippingDiagnostics.operations++
  try { return clippedRegions(fastDifference(geometry, ...cuts)) }
  catch {
    clippingDiagnostics.preciseFallbacks++
    const started = Date.now(), result = integerClip(geometry, cuts, 'difference')
    clippingDiagnostics.preciseMilliseconds += Date.now() - started
    return result
  }
}
export function intersectRegions(subject: PolygonRegion, boundary: PolygonRegion): PolygonRegion[] {
  const a = clipGeometry(subject), b = clipGeometry(boundary)
  clippingDiagnostics.operations++
  try { return clippedRegions(fastIntersection(a, b)) }
  catch {
    clippingDiagnostics.preciseFallbacks++
    const started = Date.now(), result = integerClip(a, [b], 'intersection')
    clippingDiagnostics.preciseMilliseconds += Date.now() - started
    return result
  }
}
export function corridorPolygon(a: Point, b: Point, radius: number): Point[] {
  const length = distance(a, b), ux = (b.x - a.x) / (length || 1), uy = (b.y - a.y) / (length || 1)
  const p = { x: a.x - ux * radius, y: a.y - uy * radius }, q = { x: b.x + ux * radius, y: b.y + uy * radius }
  return [{ x: p.x - uy * radius, y: p.y + ux * radius }, { x: q.x - uy * radius, y: q.y + ux * radius }, { x: q.x + uy * radius, y: q.y - ux * radius }, { x: p.x + uy * radius, y: p.y - ux * radius }]
}
export function pathPointAt(points: Point[], fraction: number): Point {
  const lengths = points.slice(1).map((p, i) => distance(points[i]!, p))
  let remaining = lengths.reduce((a, b) => a + b, 0) * fraction
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!
    if (remaining <= length) { const a = points[i]!, b = points[i + 1]!, t = remaining / (length || 1); return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } }
    remaining -= length
  }
  return points.at(-1)!
}
export function smoothPath(points: Point[], passes = 2) {
  let result = points
  for (let pass = 0; pass < passes; pass++) {
    const next = [result[0]!]
    for (let i = 1; i < result.length; i++) {
      const a = result[i - 1]!, b = result[i]!
      next.push({ x: a.x * .75 + b.x * .25, y: a.y * .75 + b.y * .25 }, { x: a.x * .25 + b.x * .75, y: a.y * .25 + b.y * .75 })
    }
    next.push(result.at(-1)!)
    result = next
  }
  return result
}
