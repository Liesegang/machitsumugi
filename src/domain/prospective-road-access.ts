import type { Point } from './types'
import type { PlanarRoadGraph } from './road-graph'

/** Survey reach for an unserved development opportunity. This is not a
 * frontage service band: recognizing a distant street does not provide access
 * or capacity until a separate physical, affordable street project is built. */
export const PROSPECTIVE_ROAD_REACH = 380

export function prospectiveRoadDistance(graph: Pick<PlanarRoadGraph, 'nearest'>, point: Point): number {
  return graph.nearest(point, PROSPECTIVE_ROAD_REACH)?.distance ?? Infinity
}
