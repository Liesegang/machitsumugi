import type { Point } from './types'
import { corridorPolygon, distance, regionArea, subtractRegions } from './geometry'

/** Keep the complete private approach outside the actual facade, including
 * square pavement caps and a small construction clearance. Moving the bend
 * and terminal together preserves its surveyed side passage and road source.
 */
export function rearPrivateAccess(source: Point, bend: Point, terminal: Point, building: Point[], title?: Point[], width = 2.8): Point[] {
  const length = distance(source, bend), ux = (bend.x - source.x) / (length || 1), uy = (bend.y - source.y) / (length || 1)
  const chainage = (p: Point) => (p.x - source.x) * ux + (p.y - source.y) * uy
  const radius = width / 2 + .05
  const forward = Math.max(...corridorPolygon(source, bend, radius).map(chainage), ...corridorPolygon(bend, terminal, radius).map(chainage))
  const facade = Math.min(...building.map(chainage))
  const retreat = Math.max(0, forward - facade + .01)
  const shifted = (p: Point) => ({ x: p.x - ux * retreat, y: p.y - uy * retreat })
  const path = [{ ...source }, shifted(bend), shifted(terminal)]
  if (title) {
    const existingGround = [{ polygon: title }, { polygon: corridorPolygon(source, bend, width / 2) }, { polygon: corridorPolygon(bend, terminal, width / 2) }]
    const extendsGround = path.slice(1).some((b, i) => subtractRegions({ polygon: corridorPolygon(path[i]!, b, width / 2) }, existingGround).reduce((sum, region) => sum + regionArea(region), 0) > 0)
    // A rounded narrow flag stem may leave no space for the transverse turn.
    // Stop the existing straight passage before the facade instead: this is
    // an exact subset of its old paving, without taking a neighbour's land.
    if (extendsGround) return path.slice(0, 2)
  }
  return path
}
