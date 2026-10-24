import type { CityConfig, Point } from './types'
import { contourNaturalLand } from './land-use'
import { terrainNoise, terrainSeed } from './regional-terrain'

/** A candidate natural cover, clipped against dated acquisitions by the
 * generator. It never reserves land against settlement or claims a farm/site.
 * Sparse woods favour uncultivated slopes and moist hollows; broad stand
 * variation represents heterogeneous vegetation rather than building parcels. */
export function naturalWoodlandContours(input: {
  width: number; height: number; seed: string; forest: number
  settlement: CityConfig['settlement']; origin: Point
  elevation(p: Point): number; slope(p: Point): number; wetness(p: Point): number
}) {
  if (input.forest <= 0) return []
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  const seed = terrainSeed(`${input.seed}:natural-woodland-v1`), reference = input.elevation(input.origin)
  const settlementPressure = input.settlement === 'metropolis' ? .08 : input.settlement === 'village' ? -.08 : input.settlement === 'rural-town' ? -.025 : 0
  const threshold = .9 - clamp(input.forest / 100) * .65 + settlementPressure
  return contourNaturalLand(input.width, input.height, p => {
    const stands = terrainNoise(seed, p.x / 520, p.y / 520) * .7 + terrainNoise(seed + 1, p.x / 1350, p.y / 1350) * .3
    return .35 + clamp(input.slope(p) / .12) * .45 + clamp((input.elevation(p) - reference) / 180) * .15 + clamp(input.wetness(p)) * .15 + (stands - .5) * .6 - threshold
  }, 48)
}
