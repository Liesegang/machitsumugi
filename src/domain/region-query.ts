import type { Point } from './types'

interface Region { polygon: Point[]; holes?: Point[][] }
/** A static geometric query index. Polygon vertices and their ray-cast arithmetic
 * remain unchanged, including strict endpoint comparisons. The bands only omit
 * edges that cannot cross a horizontal ray at the requested ordinate. */
function ringQuery(polygon: Point[], bandSize: number) {
  const bands = new Map<number, { a: Point; b: Point }[]>()
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!
    if (a.y === b.y) continue
    for (let band = Math.floor(Math.min(a.y, b.y) / bandSize); band <= Math.floor(Math.max(a.y, b.y) / bandSize); band++) {
      const edges = bands.get(band) ?? []
      edges.push({ a, b }); bands.set(band, edges)
    }
  }
  return (p: Point) => {
    let hit = false
    for (const { a, b } of bands.get(Math.floor(p.y / bandSize)) ?? []) if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit
    return hit
  }
}

/** Immutable water/land regions only; reconstruct this index after reclamation
 * or clipping changes the geometry. Overlaps retain union semantics and holes
 * exclude only their own parent region. No coordinate quantization is used. */
export function regionQuery(regions: readonly Region[], bandSize = 20): (p: Point) => boolean {
  if (!Number.isFinite(bandSize) || bandSize <= 0) throw new RangeError('Region query bands require a positive finite width')
  const indexed = regions.filter(a => a.polygon.length >= 3).map(a => ({ x0: Math.min(...a.polygon.map(p => p.x)), x1: Math.max(...a.polygon.map(p => p.x)), y0: Math.min(...a.polygon.map(p => p.y)), y1: Math.max(...a.polygon.map(p => p.y)), outer: ringQuery(a.polygon, bandSize), holes: (a.holes ?? []).map(p => ringQuery(p, bandSize)) }))
  return p => indexed.some(a => p.x >= a.x0 && p.x <= a.x1 && p.y >= a.y0 && p.y <= a.y1 && a.outer(p) && !a.holes.some(contains => contains(p)))
}
