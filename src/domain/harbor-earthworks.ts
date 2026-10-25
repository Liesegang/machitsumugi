import type { Point } from './types'
import type { TerrainModel } from './terrain'
import { boundsOf, intersectRegions, regionArea, subtractRegions } from './geometry'
import type { PolygonRegion } from './geometry'

/** The same10m quadrature defines the adopted earthwork inventory and price.
 * Exact clipped tile areas retain narrow shoulders/holes. Cut is reused first;
 * the remainder is an explicit imported fill or exported spoil boundary flux.
 * Cost coefficients are fictional public-works account units, not yen quotes.
 */
export function surveyHarborEarthworks(terrain: Pick<TerrainModel, 'elevation'>, pad: PolygonRegion, earlier: PolygonRegion[], deck: number, quayLength: number) {
  const delta = subtractRegions(pad, earlier), b = boundsOf(pad.polygon)
  let fillVolume = 0, cutVolume = 0, newGroundArea = 0
  for (let y = Math.floor(b.minY / 10) * 10; y < b.maxY; y += 10) for (let x = Math.floor(b.minX / 10) * 10; x < b.maxX; x += 10) {
    const cell = { polygon: [{ x, y }, { x: x + 10, y }, { x: x + 10, y: y + 10 }, { x, y: y + 10 }] }
    for (const region of delta.flatMap(r => intersectRegions(r, cell))) {
      const area = regionArea(region), p: Point = region.polygon.reduce((s, q) => ({ x: s.x + q.x / region.polygon.length, y: s.y + q.y / region.polygon.length }), { x: 0, y: 0 })
      const difference = deck - terrain.elevation(p)
      fillVolume += Math.max(0, difference) * area; cutVolume += Math.max(0, -difference) * area; newGroundArea += area
    }
  }
  const reusedCutVolume = Math.min(fillVolume, cutVolume), importedFillVolume = fillVolume - reusedCutVolume, exportedSpoilVolume = cutVolume - reusedCutVolume
  return { fillVolume, cutVolume, reusedCutVolume, importedFillVolume, exportedSpoilVolume, earthworkVolume: fillVolume + cutVolume, newGroundArea,
    solidBalanceError: fillVolume - cutVolume - importedFillVolume + exportedSpoilVolume,
    constructionCost: newGroundArea * .006 + (fillVolume + cutVolume) * .005 + quayLength * .9 }
}
