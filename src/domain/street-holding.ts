import { seededRandom } from './geometry'

export type StreetStock = 'compact' | 'ordinary' | 'garden' | 'walkup' | 'mixed' | 'office' | 'retail'
export interface HoldingProfile {
  frontage: number
  depth: number
  coverage: number
  frontGap: number
  widthRatio: number
  sideBias: number
  /** Target roof width/depth ratio; actual fitting must retain site guards. */
  aspect: number
}
type Range = readonly [number, number]
interface StockProgramme {
  frontage: Range
  frontagePower: number
  depth: Range
  coverage: Range
  frontGap: Range
  aspect: Range
}
const programmes: Record<StreetStock, StockProgramme> = {
  compact: { frontage: [6.8, 15], frontagePower: 1.75, depth: [18, 31], coverage: [.44, .64], frontGap: [1, 3.8], aspect: [.62, 1.28] },
  ordinary: { frontage: [9, 22], frontagePower: 1.2, depth: [20, 35], coverage: [.34, .57], frontGap: [1.5, 6], aspect: [.65, 1.45] },
  garden: { frontage: [13, 29], frontagePower: 1.1, depth: [25, 40], coverage: [.28, .44], frontGap: [3, 8], aspect: [.8, 1.6] },
  walkup: { frontage: [18, 32], frontagePower: 1.35, depth: [21, 36], coverage: [.36, .59], frontGap: [2, 5], aspect: [1.35, 2.5] },
  mixed: { frontage: [15, 32], frontagePower: 1.28, depth: [20, 34], coverage: [.44, .65], frontGap: [.8, 2.5], aspect: [1.05, 2.1] },
  office: { frontage: [36, 70], frontagePower: 1.12, depth: [34, 60], coverage: [.52, .7], frontGap: [2, 5], aspect: [.95, 1.6] },
  retail: { frontage: [40, 76], frontagePower: 1.15, depth: [34, 62], coverage: [.4, .6], frontGap: [4, 9], aspect: [1.3, 2.2] },
}
const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value))
const between = ([low, high]: Range, fraction: number) => low + (high - low) * clamp(fraction)

/** Acquisition dimensions belong to an actual street holding, not a recursive
 * subdivision cell or a replacement building. A coherent street cohort shares
 * its building line and construction tendency while individual holdings retain
 * different frontage, depth and roof proportions. Caller-supplied spatial keys
 * must remain independent of parcel serials and road survey segmentation. */
export function streetHolding(seed: string, key: string, stock: StreetStock, intensity: number, cohortKey = key): HoldingProfile {
  const profile = programmes[stock], local = seededRandom(`${seed}:holding:${stock}:${key}`), cohort = seededRandom(`${seed}:street-cohort:${stock}:${cohortKey}`)
  const demand = Number.isFinite(intensity) ? clamp(intensity) : .5
  const widthTendency = cohort(), depthTendency = cohort(), setbackTendency = cohort(), roofTendency = cohort(), shapeTendency = cohort(), sideTendency = cohort()
  const width = clamp(.55 * widthTendency + .45 * local() + (.5 - demand) * .08)
  const depth = clamp(.55 * depthTendency + .45 * local())
  // Deep forecourts and gardens reserve acquired ground instead of merely
  // sliding an equally large roof to a random place in the title.
  const setback = clamp(.9 * setbackTendency + .1 * local())
  const coverage = clamp(.65 * roofTendency + .35 * local() + (demand - .5) * .08 - (setback - .5) * .12)
  const shape = clamp(.8 * shapeTendency + .2 * local())
  return {
    frontage: between(profile.frontage, width ** profile.frontagePower),
    depth: between(profile.depth, depth),
    coverage: between(profile.coverage, coverage),
    frontGap: between(profile.frontGap, setback),
    widthRatio: between([.65, .9], clamp(.6 * roofTendency + .4 * local())),
    sideBias: between([-.13, .13], clamp(.8 * sideTendency + .2 * local())),
    aspect: between(profile.aspect, shape),
  }
}
