import { intersection } from 'polygon-clipping'
import type { PolygonRegion } from './geometry'
import { boundsOf, overlaps } from './geometry'
import { indexedPolygonOverlap } from './indexed-polygon-overlap'
import type { Point } from './types'

type Polygon = [number, number][][]
const clippingPolygon = (region: PolygonRegion): Polygon => [region.polygon, ...(region.holes ?? [])].map(ring => ring.map(point => [point.x, point.y]))

/** Cache static water boundaries once, then inspect only the outward half of
 * each square road cap. The inward half may legitimately be a bridge deck.
 * Rebuild this query whenever its source water geometry changes. */
export function continuousRoadEndcapsClear(waterRegions: readonly PolygonRegion[]): (points: readonly Point[], width: number) => boolean {
  const water = waterRegions.map(region => ({ bounds: boundsOf(region.polygon), overlaps: indexedPolygonOverlap(region), geometry: clippingPolygon(region) }))
  return (points, width) => {
    if (points.length < 2 || !Number.isFinite(width) || width <= 0 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false
    const first = points[0]!, last = points.at(-1)!
    const next = points.find(point => point.x !== first.x || point.y !== first.y)
    const previous = points.findLast(point => point.x !== last.x || point.y !== last.y)
    if (!next || !previous) return false
    const radius = width / 2
    for (const [tip, inside] of [[first, next], [last, previous]]) {
      const length = Math.hypot(tip!.x - inside!.x, tip!.y - inside!.y)
      const ux = (tip!.x - inside!.x) / length, uy = (tip!.y - inside!.y) / length
      const cap = [
        { x: tip!.x - uy * radius, y: tip!.y + ux * radius },
        { x: tip!.x + ux * radius - uy * radius, y: tip!.y + uy * radius + ux * radius },
        { x: tip!.x + ux * radius + uy * radius, y: tip!.y + uy * radius - ux * radius },
        { x: tip!.x + uy * radius, y: tip!.y - ux * radius },
      ]
      const bounds = boundsOf(cap)
      let geometry: Polygon | undefined
      for (const region of water) {
        if (!overlaps(bounds, region.bounds) || !region.overlaps(cap)) continue
        geometry ??= clippingPolygon({ polygon: cap })
        // A clipping intersection contains filled polygons only: an edge or
        // point contact produces no polygon. Keep original floating coordinates
        // and every positive area; the land-conversion helper rounds coordinates
        // and removes sub-.01m² polygons, which is inappropriate for this guard.
        if (intersection(geometry, region.geometry).length) return false
      }
    }
    return true
  }
}
