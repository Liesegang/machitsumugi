import type { Point } from './types'
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
