import { streetHolding } from './street-holding'
import type { HoldingProfile, StreetStock } from './street-holding'

export type ParcelNeighbourhoodForm = 'inherited' | 'planned' | 'hillside' | 'edge'

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/** Street cohorts describe acquisitions, rather than adding noise to a finished
 * rectangle. Old frontages retain narrow, deep titles; later residential
 * extensions acquire deeper house-and-garden sites. A grouped apartment
 * acquisition retains an actual service court within its own boundary. */
export function neighbourhoodHolding(seed: string, key: string, stock: StreetStock, intensity: number, cohortKey: string, form: ParcelNeighbourhoodForm, court = false, depthTarget?: number): HoldingProfile {
  const holding = streetHolding(seed, key, stock, intensity, cohortKey)
  if (stock === 'office' || stock === 'retail' || stock === 'mixed') return holding
  if (court) return {
    ...holding,
    frontage: clamp(holding.frontage * 1.42, 28, 46),
    depth: clamp(holding.depth * 1.35, 32, 46),
    coverage: clamp(holding.coverage * .82, .31, .47),
    frontGap: clamp(holding.frontGap + 4.5, 7, 10),
    widthRatio: .86,
    aspect: clamp(holding.aspect * 1.2, 1.8, 3.1),
  }
  if (stock === 'walkup') return holding
  if (form === 'inherited') return holding
  if (form === 'planned') return {
    ...holding,
    frontage: holding.frontage * 1.1,
    depth: clamp((depthTarget ?? 35) * (.88 + (holding.depth - 18) / 22 * .22), 29, 44),
    frontGap: Math.max(3.2, holding.frontGap),
    coverage: holding.coverage * .94,
  }
  if (form === 'hillside') return {
    ...holding,
    frontage: holding.frontage * 1.12,
    depth: clamp(holding.depth * .8, 18, 27),
    aspect: Math.max(1.15, holding.aspect),
  }
  return {
    ...holding,
    frontage: holding.frontage * 1.12,
    depth: clamp((depthTarget ?? 42) * (.86 + (holding.depth - 18) / 22 * .22), 32, 48),
    frontGap: Math.max(4, holding.frontGap),
    coverage: holding.coverage * .94,
  }
}
