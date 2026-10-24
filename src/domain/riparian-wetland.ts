import type { Point } from './types'
import type { TerrainModel } from './terrain'

type WetlandTerrain = Pick<TerrainModel, 'channelAt' | 'elevation' | 'slope' | 'wetness' | 'waterAt'>

/** Approximate persistently saturated bank ground, not the whole floodplain.
 * The seasonal stage allowance (0.35–0.7m) is an application assumption, not a
 * calibrated flood recurrence model. Actual relative bank height and slope
 * control its footprint: a close high terrace stays dry and a low flat swale
 * can extend further inland. No constant-distance ribbon is prescribed. */
export function riparianWetlandMargin(p: Point, terrain: WetlandTerrain): number {
  const channel = terrain.channelAt(p)
  if (!channel || terrain.waterAt(p)) return -1
  const relativeHeight = terrain.elevation(p) - channel.surfaceElevation
  const seasonalStage = .35 + Math.min(.35, channel.width * .006)
  return Math.min((.035 - terrain.slope(p)) * 4, (seasonalStage - relativeHeight) / 5, terrain.wetness(p) - .52)
}
