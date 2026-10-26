import type { Point } from './types'
import type { Bounds, PolygonRegion } from './geometry'
import { boundsOf, overlaps, pointInPolygon, polygonOverlapsRegion, segmentsCross } from './geometry'
import { regionQuery } from './region-query'

interface Edge { a: Point; b: Point; bounds: Bounds }
function boundaryIndex(polygon: Point[], size: number) {
  const cells = new Map<string, Edge[]>(), broad: Edge[] = []
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, bounds = boundsOf([a, b]), edge = { a, b, bounds }
    const minX = Math.floor(bounds.minX / size), maxX = Math.floor(bounds.maxX / size), minY = Math.floor(bounds.minY / size), maxY = Math.floor(bounds.maxY / size)
    // A long diagonal belongs to a small global list, avoiding thousands of
    // empty bins. It still receives the same final strict intersection tests.
    if ((maxX - minX + 1) * (maxY - minY + 1) > 4096) { broad.push(edge); continue }
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) { const key = `${x}:${y}`, entries = cells.get(key) ?? []; entries.push(edge); cells.set(key, entries) }
  }
  return (bounds: Bounds) => {
    const found = new Set<Edge>()
    for (const edge of broad) if (overlaps(bounds, edge.bounds)) found.add(edge)
    for (let x = Math.floor(bounds.minX / size); x <= Math.floor(bounds.maxX / size); x++) for (let y = Math.floor(bounds.minY / size); y <= Math.floor(bounds.maxY / size); y++) for (const edge of cells.get(`${x}:${y}`) ?? []) if (overlaps(bounds, edge.bounds)) found.add(edge)
    return [...found]
  }
}

/** Static equivalent of polygonOverlapsRegion. Vertices, ray-cast arithmetic,
 * proper-crossing comparisons and each individual hole's semantics remain
 * unchanged. Rebuild the index if its source geometry is ever edited. */
export function indexedPolygonOverlap(region: PolygonRegion, size = 80): (polygon: Point[]) => boolean {
  if (!Number.isFinite(size) || size <= 0) throw new RangeError('Positive finite index width required')
  const outerBounds = boundsOf(region.polygon), outerContains = regionQuery([{ polygon: region.polygon }]), outerEdges = boundaryIndex(region.polygon, size)
  const holes = (region.holes ?? []).map(polygon => ({ bounds: boundsOf(polygon), contains: regionQuery([{ polygon }]), edges: boundaryIndex(polygon, size) }))
  const degenerate = region.polygon.length < 3 || (region.holes ?? []).some(hole => hole.length < 3)
  return polygon => {
    if (degenerate || polygon.length < 3) return polygonOverlapsRegion(polygon, region)
    const bounds = boundsOf(polygon)
    if (!overlaps(bounds, outerBounds)) return false
    let outer = polygon.some(outerContains)
    if (!outer) outer = outerEdges(bounds).some(edge => pointInPolygon(edge.a, polygon) || pointInPolygon(edge.b, polygon) || polygon.some((a, i) => segmentsCross(a, polygon[(i + 1) % polygon.length]!, edge.a, edge.b)))
    if (!outer) return false
    for (const hole of holes) {
      // All query vertices inside a hole implies bbox containment. This only
      // omits impossible holes; the original all-vertices/proper-cross formula
      // decides whether a possible hole really excludes the entire query.
      if (hole.bounds.minX > bounds.minX || hole.bounds.minY > bounds.minY || hole.bounds.maxX < bounds.maxX || hole.bounds.maxY < bounds.maxY) continue
      if (!polygon.every(hole.contains)) continue
      const candidates = hole.edges(bounds)
      if (!polygon.some((a, i) => candidates.some(edge => segmentsCross(a, polygon[(i + 1) % polygon.length]!, edge.a, edge.b)))) return false
    }
    return true
  }
}
