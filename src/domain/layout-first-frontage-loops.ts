import type { Point, Road } from './types'
import { distance, pathPointAt, projectPoint } from './geometry'
import { alignmentDiagnostics, splineAlignment } from './road-alignment'
import { roadLength } from './road-graph'

/** Open a town block from two real frontage points. The outer street follows
 * the acquired road's changing bearing; this is neither an administrative
 * district outline nor a citywide rectangular frame. Callers survey all ROW. */
export function layoutFrontageLoop(road: Road, anchor: Point, reach: number, depth: number, side: number): Point[] | null {
  const length = roadLength(road.points)
  if (length < 240 || reach < 180 || depth < 65) return null
  let along = 0, nearest = 0, minimum = Infinity
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]!, b = road.points[i]!, point = projectPoint(anchor, a, b), separation = distance(anchor, point)
    if (separation < minimum) { minimum = separation; nearest = along + distance(a, point) }
    along += distance(a, b)
  }
  const span = Math.min(length * .92, reach), start = Math.max(0, Math.min(length - span, nearest - span / 2)), end = start + span
  const at = (chainage: number) => pathPointAt(road.points, Math.max(0, Math.min(1, chainage / length)))
  const offset = (chainage: number, amount: number) => {
    const point = at(chainage), before = at(chainage - 35), after = at(chainage + 35), bearing = Math.atan2(after.y - before.y, after.x - before.x)
    return { x: point.x - Math.sin(bearing) * amount * side, y: point.y + Math.cos(bearing) * amount * side }
  }
  const controls = [at(start), offset(start, depth * .45), offset(start + span * .16, depth), offset(start + span * .49, depth * .96), offset(end - span * .17, depth), offset(end, depth * .45), at(end)]
  const points = splineAlignment(controls, 5)
  return alignmentDiagnostics(points).minimumRadius >= 50 ? points : null
}
