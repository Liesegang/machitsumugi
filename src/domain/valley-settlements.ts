import type { Point } from './types'

/** Ranked, existing dry land opportunities upstream/downstream on the same bank.
 * Chainage follows the real valley, rather than extending one local tangent to
 * an arbitrary map edge. Road feasibility is still checked by the road planner.
 */
export function valleySettlementCandidates(input: { river: Point[]; origin: Point; candidates: Point[]; slope(p: Point): number }): Point[][] {
  const { river, origin, candidates, slope } = input
  if (river.length < 2) return []
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
  const along = [0]
  for (let i = 1; i < river.length; i++) along.push(along.at(-1)! + distance(river[i - 1]!, river[i]!))
  const locate = (p: Point) => {
    let result = { distance: Infinity, along: 0, side: 0 }
    for (let i = 1; i < river.length; i++) {
      const a = river[i - 1]!, b = river[i]!, dx = b.x - a.x, dy = b.y - a.y, length = distance(a, b)
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (length * length || 1)))
      const point = { x: a.x + dx * t, y: a.y + dy * t }, d = distance(p, point)
      if (d < result.distance) result = { distance: d, along: along[i - 1]! + length * t, side: dx * (p.y - point.y) - dy * (p.x - point.x) }
    }
    return result
  }
  const home = locate(origin)
  const surveyed = candidates.map(point => ({ point, location: locate(point), grade: slope(point) }))
  return [-1, 1].map(direction => surveyed.filter(candidate => {
    const chainage = (candidate.location.along - home.along) * direction
    return chainage >= 250 && chainage <= 1000 && candidate.location.side * home.side > 0 && candidate.location.distance > 70 && candidate.location.distance < 320 && candidate.grade < .09
  }).sort((a, b) => distance(a.point, origin) + a.grade * 1000 - distance(b.point, origin) - b.grade * 1000).map(candidate => candidate.point))
}
