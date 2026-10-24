import type { Point } from './types'

export function isobathCrossing(a: Point, b: Point, elevation: (p: Point) => number): Point {
  let low = a, high = b, first = elevation(a)
  const last = elevation(b)
  if (!first) return a
  if (!last) return b
  if ((first < 0) === (last < 0)) throw new Error('A shoreline crossing must bracket sea level')
  for (let i = 0; i < 40 && Math.hypot(high.x - low.x, high.y - low.y) > .000001; i++) {
    const middle = { x: (low.x + high.x) / 2, y: (low.y + high.y) / 2 }, z = elevation(middle)
    if (!z) return middle
    if ((z < 0) === (first < 0)) { low = middle; first = z } else high = middle
  }
  return { x: (low.x + high.x) / 2, y: (low.y + high.y) / 2 }
}

/** Resolve only the actual zero isobath inside a marching-square boundary cell.
 * Coarse-grid connectivity is unchanged. Inserted vertices are roots of the
 * same reconstructed physical DEM, never an off-terrain smoothing spline.
 */
export function refineIsobath(a: Point, b: Point, input: {
  elevation(p: Point): number
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  tolerance?: number
}): Point[] {
  const tolerance = input.tolerance ?? .15, { bounds, elevation } = input
  const project = (p: Point, normal: Point): Point | null => {
    const z = elevation(p)
    if (!z) return p
    let low = -Infinity, high = Infinity
    for (const [position, direction, minimum, maximum] of [[p.x, normal.x, bounds.minX, bounds.maxX], [p.y, normal.y, bounds.minY, bounds.maxY]]) {
      if (Math.abs(direction!) < 1e-12) continue
      const first = (minimum! - position!) / direction!, last = (maximum! - position!) / direction!
      low = Math.max(low, Math.min(first, last)); high = Math.min(high, Math.max(first, last))
    }
    let result: Point | null = null, best = Infinity
    for (const limit of [low, high]) {
      if (!Number.isFinite(limit) || Math.abs(limit) < .001) continue
      let previous = p
      for (let i = 1; i <= 8; i++) {
        const sample = { x: p.x + normal.x * limit * i / 8, y: p.y + normal.y * limit * i / 8 }, next = elevation(sample)
        if ((next < 0) !== (z < 0) || !next) {
          const root = isobathCrossing(previous, sample, elevation), distance = Math.hypot(root.x - p.x, root.y - p.y)
          if (distance < best) { best = distance; result = root }
          break
        }
        previous = sample
      }
    }
    return result
  }
  const resolve = (first: Point, last: Point, depth: number): Point[] => {
    const dx = last.x - first.x, dy = last.y - first.y, length = Math.hypot(dx, dy)
    if (depth >= 8 || length < tolerance) return [first, last]
    const normal = { x: -dy / length, y: dx / length }
    let selected: Point | null = null, maximum = tolerance
    // Quarter points detect an inflection whose chord midpoint is on sea level.
    for (const fraction of [.25, .5, .75]) {
      const p = { x: first.x + dx * fraction, y: first.y + dy * fraction }, root = project(p, normal)
      if (!root) continue
      const distance = Math.hypot(root.x - p.x, root.y - p.y)
      if (distance > maximum) { maximum = distance; selected = root }
    }
    if (!selected || Math.hypot(selected.x - first.x, selected.y - first.y) < .01 || Math.hypot(selected.x - last.x, selected.y - last.y) < .01) return [first, last]
    return [...resolve(first, selected, depth + 1).slice(0, -1), ...resolve(selected, last, depth + 1)]
  }
  return resolve(a, b, 0)
}
