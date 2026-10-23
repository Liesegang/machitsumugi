import polygonClipping from 'polygon-clipping'
import type { Area, Point } from '../domain/types'
import { subtractRegions } from '../domain/geometry'
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
  const standing = water.filter(area => area.waterLevel !== undefined)
  const surfaces = water.flatMap(area => area.waterLevel !== undefined ? [area] : subtractRegions(area, standing).map((part, i) => ({ ...area, ...part, holes: part.holes, id: i ? `${area.id}-surface-${i}` : area.id })))
  const polygon = (area: Area): polygonClipping.Polygon => [area.polygon, ...(area.holes ?? [])].map(ring => ring.map(p => [p.x, p.y]))
  const [first, ...rest] = water.map(polygon)
  const shorelines: PolygonRegion[] = first ? polygonClipping.union(first, ...rest).map(rings => ({ polygon: rings[0]!.slice(0, -1).map(([x, y]) => ({ x, y })), holes: rings.slice(1).map(ring => ring.slice(0, -1).map(([x, y]) => ({ x, y }))) })) : []
  const geometry = { surfaces, shorelines }
  cache.set(areas, { water, polygons: water.map(area => area.polygon), holes: water.map(area => area.holes), levels: water.map(area => area.waterLevel), geometry })
  return geometry
}

/** Standing waters share one hydraulic surface instead of following the bed. */
export function waterSurfaceElevation(area: Area, point: Point, elevation: (p: Point) => number): number {
  return area.waterLevel !== undefined ? area.waterLevel + .5 : area.id === 'sea' || area.id.startsWith('sea-') ? .5 : elevation(point) + .7
}
