import type { Point } from './types'

export interface ChannelHydraulicGeometryInput {
  points: Point[]
  /** Discharge/catchment-derived width prior, including the zero-width source. */
  referenceWidths: number[]
  surfaceElevation: number[]
  groundElevation(p: Point): number
  alluvium?(p: Point): number
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/** Reach-scale hydraulic geometry, not a width noise texture or a flow solver.
 *
 * The contributing-area width relation is a regional prior. At equal discharge
 * and width:depth ratio, Manning's relation gives W proportional to S^(-3/16).
 * Apply that bounded correction to the surveyed longitudinal water slope, then
 * constrain the section by the actual valley walls and erodible bank inventory.
 * The reference slope (1 m/km), correction bounds and bankfull-depth relation
 * are explicit uncalibrated regional assumptions. No runoff, drainage edge or
 * confluence is changed. Subsequent bed reconstruction accounts excavation.
 */
export function surveyChannelWidths(input: ChannelHydraulicGeometryInput): number[] {
  const { points, referenceWidths, surfaceElevation } = input, count = points.length
  if (referenceWidths.length !== count || surfaceElevation.length !== count) throw new Error('Channel section attributes must match its centreline')
  if (!count) return []
  const along = new Float64Array(count)
  for (let i = 1; i < count; i++) along[i] = along[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y)
  const proposed = new Float64Array(count), limits = new Float64Array(count)
  let left = 0, right = 0
  for (let i = 0; i < count; i++) {
    const reference = referenceWidths[i]!
    if (!Number.isFinite(reference) || reference < 0 || !Number.isFinite(surfaceElevation[i]!)) throw new Error('Channel width and water level must be finite')
    if (!reference) continue
    // Resolve slope over several physical channel widths; single D8 elevation
    // steps must not alternate the width at each 25 m centreline sample.
    const reach = Math.max(180, reference * 8)
    while (left < i && along[i]! - along[left]! > reach / 2) left++
    while (left > 0 && along[i]! - along[left - 1]! <= reach / 2) left--
    right = Math.max(i, right)
    while (right + 1 < count && along[right]! - along[i]! < reach / 2) right++
    while (right > i && along[right - 1]! - along[i]! >= reach / 2) right--
    const run = along[right]! - along[left]!, grade = Math.max(0, (surfaceElevation[left]! - surfaceElevation[right]!) / Math.max(1, run))
    const target = reference * clamp((.001 / Math.max(.0001, grade)) ** (3 / 16), .55, 1.55)
    const a = points[left]!, b = points[right]!, length = Math.hypot(b.x - a.x, b.y - a.y)
    if (!length) { proposed[i] = limits[i] = target; continue }
    const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length }, centre = points[i]!, ground = input.groundElevation(centre)
    // The existing channel-bed stage uses this same bankfull depth. A soft
    // deposit can be cut, whereas a high resistant valley side confines water.
    const depth = 1.2 + reference * .035
    let maximum = target
    for (const side of [-1, 1]) {
      const at = (distance: number) => ({ x: centre.x + normal.x * distance * side, y: centre.y + normal.y * distance * side })
      const barrier = (distance: number) => { const p = at(distance); return input.groundElevation(p) - ground - depth - Math.min(depth, Math.max(0, input.alluvium?.(p) ?? 0)) }
      // A finite section survey detects an intervening bank even when the
      // opposite end of the sample lies in a neighbouring low tributary.
      const steps = Math.max(4, Math.ceil(target / 2 / 4))
      let previous = 0
      for (let step = 1; step <= steps; step++) {
        const distance = target / 2 * step / steps
        if (barrier(distance) > 0) {
          let low = previous, high = distance
          for (let search = 0; search < 8; search++) { const middle = (low + high) / 2; if (barrier(middle) > 0) high = middle; else low = middle }
          maximum = Math.min(maximum, low * 2); break
        }
        previous = distance
      }
    }
    limits[i] = maximum; proposed[i] = Math.min(target, maximum)
  }
  // Spatial averaging is tied to reach distance, not vertex count. Keep every
  // local hard-bank limit and source onset after averaging.
  const widths = points.map((_, i) => {
    const reference = referenceWidths[i]!
    if (!reference) return 0
    const radius = Math.max(50, reference * 2), sigma = radius / 2
    let sum = 0, total = 0
    for (let j = i; j >= 0 && along[i]! - along[j]! <= radius; j--) { const weight = Math.exp(-(((along[i]! - along[j]!) / sigma) ** 2) / 2); sum += proposed[j]! * weight; total += weight }
    for (let j = i + 1; j < count && along[j]! - along[i]! <= radius; j++) { const weight = Math.exp(-(((along[j]! - along[i]!) / sigma) ** 2) / 2); sum += proposed[j]! * weight; total += weight }
    return Math.min(limits[i]!, reference * 1.55, sum / total)
  })
  // A narrow rock section also controls its approach. Propagate its limit
  // upstream/downstream with a gradual contraction/expansion (each bank below
  // a 1:16 lateral slope), rather than drawing a sudden notch at one vertex.
  for (let i = 1; i < count; i++) widths[i] = Math.min(widths[i]!, widths[i - 1]! + (along[i]! - along[i - 1]!) * .12)
  for (let i = count - 2; i >= 0; i--) widths[i] = Math.min(widths[i]!, widths[i + 1]! + (along[i + 1]! - along[i]!) * .12)
  return widths
}
