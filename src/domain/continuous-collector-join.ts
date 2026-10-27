import type { Point } from './types'
import { alignmentDiagnostics, tangentAlignment } from './road-alignment'

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y)
const copy = (point: Point): Point => ({ ...point })
const lengthOf = (points: readonly Point[]) => points.slice(1).reduce((sum, point, i) => sum + distance(points[i]!, point), 0)

/** Cut a polyline at physical chainage, retaining every vertex outside the cut. */
function splitAt(points: readonly Point[], chainage: number) {
  let traversed = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, length = distance(a, b)
    if (length < 1e-9) continue
    if (traversed + length >= chainage - 1e-9) {
      const t = Math.max(0, Math.min(1, (chainage - traversed) / length))
      const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      return { point, heading: Math.atan2(b.y - a.y, b.x - a.x), before: points.slice(0, i).map(copy), after: points.slice(i).map(copy) }
    }
    traversed += length
  }
  return null
}

function append(points: Point[], point: Point) {
  if (!points.length || distance(points.at(-1)!, point) > 1e-8) points.push(copy(point))
}

/** Geometric candidates only. Every changed path still needs the caller's
 * full ROW, water, railway, grade, date and registered-bank validation.
 * Trim metres along each leg, never a fixed number of its sampling vertices. */
export function continuousCollectorJoinCandidates(first: readonly Point[], last: readonly Point[], minimumRadius = 50): Point[][] {
  if (first.length < 2 || last.length < 2 || !Number.isFinite(minimumRadius) || minimumRadius <= 0 || [...first, ...last].some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return []
  if (distance(first.at(-1)!, last[0]!) > 1e-6) return []
  const firstLength = lengthOf(first), lastLength = lengthOf(last)
  if (Math.min(firstLength, lastLength) < 1e-6) return []
  const acceptable = (points: Point[]) => {
    const shape = alignmentDiagnostics(points, 5)
    // A perfectly collinear reversal has zero cross product and therefore no
    // circumcircle radius. It must not pass as an infinitely gentle bend.
    return shape.minimumRadius >= minimumRadius - 1e-6 && shape.maximumDeflection < Math.PI / 2
  }
  const joined: Point[] = []
  for (const point of first) append(joined, point)
  for (const point of last.slice(1)) append(joined, point)
  if (acceptable(joined)) return [joined]

  const result: Point[][] = [], tried = new Set<string>()
  for (const reach of [160, 240, 320, 100]) {
    const firstTrim = Math.min(reach, firstLength / 2), lastTrim = Math.min(reach, lastLength / 2)
    const key = `${firstTrim}:${lastTrim}`
    if (tried.has(key)) continue
    tried.add(key)
    const start = splitAt(first, firstLength - firstTrim), end = splitAt(last, lastTrim)
    if (!start || !end || distance(start.point, end.point) < 1e-6 || Math.cos(start.heading - end.heading) < Math.cos(Math.PI * 5 / 6)) continue
    for (const handle of [.65, .85, 1.05]) {
      const connector = tangentAlignment(start.point, end.point, start.heading, end.heading, firstTrim * handle, lastTrim * handle, 5)
      const points: Point[] = []
      for (const point of start.before) append(points, point)
      for (const point of connector) append(points, point)
      for (const point of end.after) append(points, point)
      if (acceptable(points)) result.push(points)
    }
  }
  return result
}
