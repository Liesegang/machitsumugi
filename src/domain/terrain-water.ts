import polygonClipping from 'polygon-clipping'
import type { Point } from './types'

export interface WaterRegion { polygon: Point[]; holes?: Point[][] }
/** Clip complete physical water polygons; retain disjoint parts and island holes. */
export function clipWaterRegion(region: WaterRegion, width: number, height: number): WaterRegion[] {
  const ring = (points: Point[]): [number, number][] => [...points, points[0]!].map(p => [p.x, p.y])
  const result = polygonClipping.intersection([ring(region.polygon), ...(region.holes ?? []).map(ring)], [[[0, 0], [width, 0], [width, height], [0, height], [0, 0]]])
  return result.map(polygon => {
    // The clipping library merges nearly equal intersection coordinates and
    // can retain a source vertex one ULP beyond the clipping rectangle. Return
    // the exact mathematical crop bounds shared by rendering and placement.
    const rings = polygon.map(r => r.slice(0, -1).map(([x, y]) => ({ x: Math.max(0, Math.min(width, x)), y: Math.max(0, Math.min(height, y)) })))
    return { polygon: rings[0]!, holes: rings.slice(1) }
  })
}
