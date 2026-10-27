/** A weakly developed fringe needs deeper serviced holdings and fewer local
 * streets. Dense central districts retain their existing walking distances;
 * the transition is continuous and follows the measured demand field. */
export function continuousLocalStreetDepth(intensity: number): number {
  const demand = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 0))
  const fringe = Math.max(0, (.45 - demand) / .45)
  return 20 + (1 - demand) * 12 + fringe * 24
}

export interface ContinuousStreetContext {
  intensity: number
  openingYear: number
  frontageYear: number
  frontageDistance: number
  slope: number
}

/** Inherited roadside holdings and later planned neighbourhoods have different
 * service depths. This uses the fixed public frame, before any local growth;
 * a newly added lane cannot change the character of its neighbours. */
export function continuousLocalStreetForm(context: ContinuousStreetContext) {
  const clamp = (x: number) => Math.max(0, Math.min(1, x))
  const inherited = context.frontageYear < 1900 ? 1 : context.frontageYear < 1955 ? .5 : 0
  const legacy = inherited * clamp(1 - context.frontageDistance / 180)
  const planned = clamp((context.openingYear - 1900) / 75) * (1 - legacy)
  const demand = clamp(context.intensity), hillside = clamp(context.slope / .08)
  return {
    depth: Math.min(60, continuousLocalStreetDepth(demand) + planned * (8 + 5 * demand) + hillside * 8),
    width: 4.8 + planned * .8,
    minimumLength: 50 + planned * 30,
    maximumLength: 130 + planned * 50,
  }
}

/** Stratified engineering probes cover every32m square without making a world
 * coordinate lattice the target of all street ends. These are survey points,
 * never boundaries or positions imposed on accepted pavement. */
export function continuousLocalAccessProbes(width: number, height: number, cellSize = 32) {
  const probes: { x: number; y: number }[] = []
  const fraction = (x: number) => x - Math.floor(x)
  for (let row = 0; row * cellSize < height; row++) for (let column = 0; column * cellSize < width; column++) {
    const x0 = column * cellSize, y0 = row * cellSize
    const u = .2 + .6 * fraction((column + 1) * .7548776662466927 + (row + 1) * .5698402909980532)
    const v = .2 + .6 * fraction((column + 1) * .5698402909980532 + (row + 1) * .7548776662466927)
    probes.push({ x: x0 + Math.min(cellSize, width - x0) * u, y: y0 + Math.min(cellSize, height - y0) * v })
  }
  return probes
}
