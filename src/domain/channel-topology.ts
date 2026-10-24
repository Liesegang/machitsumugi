import type { Point } from './types'

const turn = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

/** A stream's successive samples may approach another reach but cannot flow
 * through it and continue around a closed loop. Bank contact/cutoff is handled
 * separately by the physical neck survey. Bucket exact segment tests keep this
 * guard local even when an evolved channel has thousands of samples. */
function crossedVertices(points: Point[]): Set<number> {
  const bins = new Map<string, number[]>(), crossed = new Set<number>(), size = 64
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y)
    const seen = new Set<number>(), keys: string[] = []
    for (let y = Math.floor(minY / size); y <= Math.floor(maxY / size); y++) for (let x = Math.floor(minX / size); x <= Math.floor(maxX / size); x++) {
      const key = `${x}:${y}`; keys.push(key)
      for (const j of bins.get(key) ?? []) {
        if (j >= i - 1 || seen.has(j)) continue
        seen.add(j)
        const c = points[j - 1]!, d = points[j]!
        if (maxX < Math.min(c.x, d.x) || Math.max(c.x, d.x) < minX || maxY < Math.min(c.y, d.y) || Math.max(c.y, d.y) < minY) continue
        const abC = turn(a, b, c), abD = turn(a, b, d), cdA = turn(c, d, a), cdB = turn(c, d, b)
        if (abC * abD < -1e-10 && cdA * cdB < -1e-10) { crossed.add(i - 1); crossed.add(i); crossed.add(j - 1); crossed.add(j) }
      }
    }
    for (const key of keys) { const bucket = bins.get(key) ?? []; bucket.push(i); bins.set(key, bucket) }
  }
  return crossed
}

export const channelHasCrossings = (points: Point[]): boolean => crossedVertices(points).size > 0

/** Keep source/confluence indices and hydraulic sample order unchanged. Only a
 * numerically folded proposal is resisted: unaffected reaches still migrate.
 * No loop is painted over, no water polygon is filled, and no new cutoff or
 * abandoned lake is asserted without the separate physical bank survey. */
export function preventChannelCrossings(previous: Point[], proposal: Point[], pinned: ReadonlySet<number>): Point[] {
  let next = proposal
  for (let pass = 0; pass < 6; pass++) {
    const crossed = crossedVertices(next)
    if (!crossed.size) return next
    let changed = false
    next = next.slice()
    for (const i of crossed) if (!pinned.has(i) && (next[i]!.x !== previous[i]!.x || next[i]!.y !== previous[i]!.y)) { next[i] = previous[i]!; changed = true }
    if (!changed) return previous
  }
  return crossedVertices(next).size ? previous : next
}
