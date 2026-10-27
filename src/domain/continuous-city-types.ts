import type { CityConfig, Point, Road, Railway, Station } from './types'
import type { PolygonRegion } from './geometry'
import type { PlanningEnvironment } from './road-planner'
import type { TerrainModel } from './terrain'

export const CONTINUOUS_GENERATOR_VERSION = '2.7.0-continuous.6'

/** Development is a continuous accessibility field. Its contours are never
 * street boundaries or privately owned neighbourhood stamps. */
export interface ContinuousCityDemand {
  center: Point
  regions: PolygonRegion[]
  at(point: Point): number
  costAt(point: Point): number
  openingAt(point: Point): number
  metrics: { cellSize: number; reachableLandArea: number; targetUrbanArea: number; selectedUrbanArea: number }
}
export interface ContinuousCityBlock extends PolygonRegion { id: string }
export interface ContinuousCityAccessTarget { id: string; point: Point; builtYear: number; endHeading?: number }
export interface ContinuousCityRoadInput {
  config: CityConfig
  environment: PlanningEnvironment
  demand: ContinuousCityDemand
  center: Point
  reservedRegions: readonly PolygonRegion[]
  railways: Railway[]
  initialRoads?: Road[]
  accessTargets?: readonly ContinuousCityAccessTarget[]
  onProgress?: (label: string) => void
}
export interface ContinuousCityLandInput {
  config: CityConfig
  width: number
  height: number
  roads: Road[]
  blocks: ContinuousCityBlock[]
  demand: ContinuousCityDemand
  stations: Station[]
  /** An acquired public approach is the centre anchor when its landmark is
   * inside reserved grounds. This never grants a shortcut through those grounds. */
  centerAccess?: { point: Point; builtYear: number }
  reserves: readonly PolygonRegion[]
  terrain: Pick<TerrainModel, 'areas' | 'elevation' | 'slope' | 'waterAt'>
}
