import { unionWaterContours } from '../domain/channel-footprint'
import type { Area, Point } from '../domain/types'
import { partitionWaterAreas } from '../domain/water-partition'
import type { PolygonRegion } from '../domain/geometry'

interface WaterGeometry { surfaces: Area[]; shorelines: PolygonRegion[] }
const cache = new WeakMap<readonly Area[], { water: Area[]; polygons: Point[][]; holes: (Point[][] | undefined)[]; levels: (number | undefined)[]; geometry: WaterGeometry }>()

/** A drainage path may cross a lake in the hydrology graph. Its submerged
 * banks are not shorelines, and its river mesh must not rise above the lake.
 * Keep the source geography unchanged for placement/save files; all drawing
 * modes use these same visible surfaces and the union's external shoreline. */
export function waterGeometry(areas: readonly Area[]): WaterGeometry {
  const water = areas.filter(area => area.kind === 'water' && area.polygon.length >= 3), previous = cache.get(areas)
  if (previous && water.length === previous.water.length && water.every((area, i) => area === previous.water[i] && area.polygon === previous.polygons[i] && area.holes === previous.holes[i] && area.waterLevel === previous.levels[i])) return previous.geometry
  const surfaces = partitionWaterAreas(water)
  const shorelines: PolygonRegion[] = unionWaterContours(water)
  const geometry = { surfaces, shorelines }
  cache.set(areas, { water, polygons: water.map(area => area.polygon), holes: water.map(area => area.holes), levels: water.map(area => area.waterLevel), geometry })
  return geometry
}

/** Standing waters share one hydraulic surface instead of following the bed. */
export function waterSurfaceElevation(area: Area, point: Point, elevation: (p: Point) => number): number {
  return area.waterLevel !== undefined ? area.waterLevel + .5 : area.id === 'sea' || area.id.startsWith('sea-') ? .5 : elevation(point) + .7
}
