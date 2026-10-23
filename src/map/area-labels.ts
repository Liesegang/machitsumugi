import type { Area, Point } from '../domain/types'
import { boundsOf, distanceToSegment, pointInRegion, regionArea } from '../domain/geometry'
import type { PolygonRegion } from '../domain/geometry'
import { waterGeometry } from './water-surfaces'

const cache = new WeakMap<PolygonRegion, { polygon: Point[]; holes: Point[][] | undefined; point: Point | null }>()

/** Find a well-inside label point rather than the vertex average, which can
 * fall on a peninsula or an island. Scanline intervals also find narrow valid
 * regions that a fixed raster would miss; bounded refinement favours open
 * water. This is a label-placement approximation, never a change to geography. */
export function interiorLabelPoint(region: PolygonRegion): Point | null {
  const previous = cache.get(region)
  if (previous?.polygon === region.polygon && previous.holes === region.holes) return previous.point
  const rings = [region.polygon, ...(region.holes ?? [])], bounds = boundsOf(region.polygon)
  let best: Point | null = null, clearance = -Infinity
  const consider = (point: Point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !pointInRegion(point, region)) return
    let distance = Infinity
    for (const ring of rings) for (let i = 0; i < ring.length; i++) distance = Math.min(distance, distanceToSegment(point, ring[i]!, ring[(i + 1) % ring.length]!))
    if (distance > clearance) { best = point; clearance = distance }
  }
  if (region.polygon.length >= 3 && bounds.maxX > bounds.minX && bounds.maxY > bounds.minY) {
    consider(region.polygon.reduce((sum, p) => ({ x: sum.x + p.x / region.polygon.length, y: sum.y + p.y / region.polygon.length }), { x: 0, y: 0 }))
    for (let row = 0; row < 24; row++) {
      const y = bounds.minY + (bounds.maxY - bounds.minY) * (row + .5) / 24, crossings: number[] = []
      for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!, b = ring[j]!
        if ((a.y > y) !== (b.y > y)) crossings.push(a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y))
      }
      crossings.sort((a, b) => a - b)
      for (let i = 1; i < crossings.length; i += 2) if (crossings[i]! > crossings[i - 1]!) consider({ x: (crossings[i]! + crossings[i - 1]!) / 2, y })
    }
    for (let step = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 12, pass = 0; best && pass < 5; pass++, step /= 3) {
      const center: Point = best
      for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) consider({ x: center.x + x * step, y: center.y + y * step })
    }
  }
  cache.set(region, { polygon: region.polygon, holes: region.holes, point: best })
  return best
}

/** The hydrologic river can continue beneath the sea or a lake; place its name
 * on its largest visible water surface instead of on the submerged channel. */
export function areaLabelPoint(area: Area, areas: readonly Area[]): Point | null {
  if (area.kind !== 'water') return interiorLabelPoint(area)
  const visible = waterGeometry(areas).surfaces.filter(surface => surface.id === area.id || surface.id.startsWith(`${area.id}-surface-`)).sort((a, b) => regionArea(b) - regionArea(a))
  for (const region of visible) { const point = interiorLabelPoint(region); if (point) return point }
  return null
}
