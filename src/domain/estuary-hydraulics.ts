import type { CityConfig, Point } from './types'

/** A bounded tidal hydraulic prior, not a water polygon or a tide solver.
 * Only a centreline that actually reaches boundary-connected ocean receives
 * the additional bidirectional-flow capacity. The valley/bank survey still
 * constrains every section; subsequent bed reconstruction books excavation.
 * Tide ranges and attenuation lengths are explicit fictional scenarios.
 */
export function estuarineWidthPriors(input: {
  points: Point[]; referenceWidths: number[]; surfaceElevation: number[]
  oceanAt(point: Point): boolean; coastType?: CityConfig['coastType']
}) {
  const { points, referenceWidths, surfaceElevation } = input
  if (points.length !== referenceWidths.length || points.length !== surfaceElevation.length) throw new Error('Estuary attributes must match the surveyed centreline')
  const mouth = points.findIndex(input.oceanAt)
  if (mouth < 1 || !referenceWidths[mouth]) return [...referenceWidths]
  const kind = input.coastType ?? 'bay', tideRange = kind === 'delta' ? .55 : kind === 'ria' ? 1.6 : kind === 'peninsula' ? .9 : 1.5
  const reference = referenceWidths[mouth]!, attenuation = Math.max(300, Math.min(1800, reference * 28)), strength = kind === 'delta' ? .7 : kind === 'peninsula' ? 1.8 : 3.8
  const along = new Float64Array(points.length)
  for (let i = 1; i < points.length; i++) along[i] = along[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y)
  return referenceWidths.map((width, i) => {
    if (!width || i < mouth && surfaceElevation[i]! > tideRange * 3) return width
    const inland = Math.max(0, along[mouth]! - along[i]!), submerged = Math.max(0, Math.min(1, 1 - Math.max(0, surfaceElevation[i]!) / (tideRange * 3)))
    // A finite tidal reach leaves headwaters/inland grades and tributary
    // catchment/discharge metadata untouched. Delta mouths remain bar-prone
    // rather than forcing every coastal setting into the same funnel.
    const taper = inland >= attenuation * 3 ? 0 : Math.exp(-inland / attenuation) * (1 - (inland / (attenuation * 3)) ** 2)
    return Math.min(500, width * (1 + strength * taper * submerged))
  })
}
