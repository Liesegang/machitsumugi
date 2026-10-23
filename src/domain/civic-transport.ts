import type { Point, Railway, Road } from './types'
import { boundsOf, corridorPolygon, distance, intersectRegions, overlaps, polygonOverlapsRegion, regionArea } from './geometry'
import type { Bounds } from './geometry'

export interface CivicAcquisition { year: number; routeId: string; mode: 'road' | 'railway' }
/** Survey physical transport footprints once. A later road takes a dated civic
 * site; it cannot silently move the original site back in its founding year.
 */
export function civicTransportAcquisitions(roads: Road[], railways: Railway[], untilYear: number) {
  type Corridor = CivicAcquisition & { polygon: Point[]; bounds: Bounds }
  const buckets = new Map<string, Corridor[]>()
  const add = (item: Corridor) => {
    for (let y = Math.floor(item.bounds.minY / 150); y <= Math.floor(item.bounds.maxY / 150); y++) for (let x = Math.floor(item.bounds.minX / 150); x <= Math.floor(item.bounds.maxX / 150); x++) {
      const key = `${x}:${y}`, group = buckets.get(key) ?? []; group.push(item); buckets.set(key, group)
    }
  }
  for (const route of [
    ...roads.filter(road => !road.bridge && (road.level ?? 0) === 0).map(road => ({ ...road, mode: 'road' as const })),
    ...railways.map(railway => ({ ...railway, width: 15, mode: 'railway' as const })),
  ]) {
    const year = route.builtYear ?? (route.mode === 'road' ? 1650 : 1900)
    if (year > untilYear) continue
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1]!, b = route.points[i]!
      if (distance(a, b) < .01) continue
      const polygon = corridorPolygon(a, b, route.width / 2)
      add({ routeId: route.id, year, mode: route.mode, polygon, bounds: boundsOf(polygon) })
    }
  }
  return (campus: Point[], builtYear: number, accessRoadId: string): CivicAcquisition | null => {
    const bounds = boundsOf(campus), candidates = new Set<Corridor>()
    for (let y = Math.floor(bounds.minY / 150); y <= Math.floor(bounds.maxY / 150); y++) for (let x = Math.floor(bounds.minX / 150); x <= Math.floor(bounds.maxX / 150); x++) for (const item of buckets.get(`${x}:${y}`) ?? []) if (item.year >= builtYear && item.routeId !== accessRoadId && overlaps(bounds, item.bounds)) candidates.add(item)
    for (const item of [...candidates].sort((a, b) => a.year - b.year || a.routeId.localeCompare(b.routeId))) {
      if (!polygonOverlapsRegion(campus, item)) continue
      if (intersectRegions({ polygon: campus }, item).reduce((sum, region) => sum + regionArea(region), 0) > .05) return { year: item.year, routeId: item.routeId, mode: item.mode }
    }
    return null
  }
}
