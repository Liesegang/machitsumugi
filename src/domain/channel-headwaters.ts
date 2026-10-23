/** Uniform effective runoff is a boundary assumption, not simulated groundwater.
 * Multiplying accumulated contributing area by one rate conserves water exactly
 * at D8 confluences (including the receiving cell's own runoff). */
export function runoffSourceModel(options: { effectiveRunoffMetresPerYear?: number; drySeasonFraction?: number; mappedBaseflowM3s?: number } = {}) {
  const effectiveRunoffMetresPerYear = options.effectiveRunoffMetresPerYear ?? .6
  const drySeasonFraction = options.drySeasonFraction ?? .25
  const mappedBaseflowM3s = options.mappedBaseflowM3s ?? .001
  const specificBaseflow = effectiveRunoffMetresPerYear * drySeasonFraction / (365.25 * 24 * 3600)
  if (!(specificBaseflow > 0) || !(mappedBaseflowM3s > 0)) throw new Error('Positive runoff and source discharge are required')
  const sourceArea = mappedBaseflowM3s / specificBaseflow
  return { effectiveRunoffMetresPerYear, drySeasonFraction, mappedBaseflowM3s, sourceArea,
    baseflow: (area: number) => Math.max(0, area) * specificBaseflow,
    // Bankfull width remains an explicit regional empirical proxy. The onset
    // factor continuously joins the fine runoff-fed head, with no 5m floor.
    width: (area: number) => Math.min(130, 4.8 * (Math.max(0, area) / 1_000_000) ** .46) * Math.sqrt(Math.max(0, 1 - sourceArea / Math.max(sourceArea, area))),
  }
}

/** Extend an already selected trunk's head along its actual strongest D8 feeder.
 * This preserves the physical drainage tree; it never draws an arbitrary tail or
 * creates a disconnected spring. The final source cell brackets the discharge
 * onset, or is an actual regional boundary/source cell. */
export function extendHeadwaterPath(input: { cells: number[]; flowTo: Int32Array; accumulatedArea: Float64Array; ocean: Uint8Array; columns: number; rows: number; sourceArea: number }): number[] {
  if (!input.cells.length) return []
  const prefix: number[] = [], visited = new Set(input.cells)
  let current = input.cells[0]!
  while (input.accumulatedArea[current]! > input.sourceArea) {
    const x = current % input.columns, y = Math.floor(current / input.columns)
    let next = -1
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy
      if ((!dx && !dy) || nx < 0 || nx >= input.columns || ny < 0 || ny >= input.rows) continue
      const candidate = ny * input.columns + nx
      if (input.flowTo[candidate] !== current || input.ocean[candidate] || visited.has(candidate)) continue
      if (next < 0 || input.accumulatedArea[candidate]! > input.accumulatedArea[next]!) next = candidate
    }
    if (next < 0) break
    prefix.push(next); visited.add(next); current = next
  }
  return prefix.reverse().concat(input.cells)
}
