/** Solid-volume sediment routing. Geometry is not prescribed as a fan or delta.
 * The discharge/transport-length closure follows the erosion–deposition family
 * discussed by Carretier et al. (2016), not a full reproduction of Cidre/SPACE.
 * Rainfall, grain settling and porosity here are fictional scenario parameters.
 */
export interface SedimentInput {
  elevation: Float32Array
  hydroElevation: Float32Array
  flowTo: Int32Array
  order: Int32Array
  sourceVolume: Float64Array
  columns: number
  rows: number
  cellSize: number
  runoffMetresPerYear?: number
  transportLengthFactor?: number
  seaLevel?: number
}
export interface SedimentStep {
  deposition: Float64Array
  waterArea: Float64Array
  exportedVolume: number
  depositedVolume: number
  marineDepositedVolume: number
  terrestrialDepositedVolume: number
  lakeDepositedVolume: number
  sourceVolume: number
  massBalanceError: number
}

export function transportSediment(input: SedimentInput): SedimentStep {
  const { elevation, hydroElevation, flowTo, columns, rows, cellSize } = input
  const count = columns * rows, cellArea = cellSize ** 2, sea = input.seaLevel ?? 0
  const rank = new Int32Array(count), sorted = new Uint32Array(count)
  input.order.forEach((cell, i) => { rank[cell] = i })
  for (let i = 0; i < count; i++) sorted[i] = i
  sorted.sort((a, b) => hydroElevation[b]! - hydroElevation[a]! || rank[a]! - rank[b]!)
  const load = new Float64Array(input.sourceVolume), deposition = new Float64Array(count), waterArea = new Float64Array(count).fill(cellArea)
  const marine = new Uint8Array(count), queue = new Int32Array(count)
  let head = 0, tail = 0
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) if ((!x || !y || x === columns - 1 || y === rows - 1) && elevation[y * columns + x]! <= sea) { const i = y * columns + x; marine[i] = 1; queue[tail++] = i }
  while (head < tail) {
    const i = queue[head++]!, x = i % columns, y = Math.floor(i / columns)
    for (const j of [x ? i - 1 : -1, x + 1 < columns ? i + 1 : -1, y ? i - columns : -1, y + 1 < rows ? i + columns : -1]) if (j >= 0 && !marine[j] && elevation[j]! <= sea) { marine[j] = 1; queue[tail++] = j }
  }
  let sourceVolume = 0, exportedVolume = 0, depositedVolume = 0, marineDepositedVolume = 0, terrestrialDepositedVolume = 0, lakeDepositedVolume = 0
  const targets = new Int32Array(8), weights = new Float64Array(8)
  for (const i of sorted) {
    sourceVolume += input.sourceVolume[i]!
    const x = i % columns, y = Math.floor(i / columns), volume = load[i]!
    // Open boundary flux is retained in the budget; it is never silently lost.
    if (!x || !y || x === columns - 1 || y === rows - 1) { exportedVolume += volume; continue }
    let receivers = 0, sum = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const j = i + dy * columns + dx, gradient = (hydroElevation[i]! - hydroElevation[j]!) / (cellSize * (dx && dy ? Math.SQRT2 : 1))
      if (gradient <= 1e-10) continue
      targets[receivers] = j; weights[receivers++] = gradient; sum += gradient
    }
    if (!receivers && flowTo[i]! >= 0) { targets[0] = flowTo[i]!; weights[0] = 1; sum = 1; receivers = 1 }
    if (!receivers) { exportedVolume += volume; continue }
    // Confinement vanishes when flow leaves a valley and spreads over a plain.
    // MFD divides both water and sediment into the same downhill directions.
    // q = runoff*A/width, L = xi*q. In seawater the flow is dispersed across
    // the cell and the settling length is reduced: a simplified river plume.
    const lakeDepth = Math.max(0, hydroElevation[i]! - elevation[i]!), standing = !!marine[i] || lakeDepth > .01
    const channelWidth = Math.min(cellSize, Math.max(1, .0048 * Math.sqrt(waterArea[i]!)))
    const width = standing ? cellSize : channelWidth
    const dischargePerWidth = (input.runoffMetresPerYear ?? .7) * waterArea[i]! / width
    const length = Math.max(cellSize, (input.transportLengthFactor ?? .018) * dischargePerWidth * (standing ? .075 : 1))
    // Exact attenuation over one cell keeps all fractions bounded for any dx.
    // Submerged accommodation is finite; excess crosses the next cell rather
    // than forming an unbounded numerical mound in one long 250-year step.
    const attenuation = 1 - Math.exp(-cellSize / length)
    // Ponded cells use their actual water depth and dispersed flow. The old
    // channel-width closure let almost all sediment traverse a deep lake while
    // its underwater fictitious channel continued to erode. Filling a basin
    // now requires the incoming solid volume, up to its spill surface.
    // A steep fall into the sea is not extra terrestrial accommodation. Using
    // that drop as fill capacity let a newly emerged coast receive >100m in one
    // explicit step. Limit dry-cell aggradation per update; excess sediment
    // continues downstream and the next routing pass can move the mouth.
    const accommodation = !marine[i] && lakeDepth > .01 ? lakeDepth : Math.max(cellSize * .025, marine[i] ? sea - elevation[i]! + .15 : 0)
    const settled = Math.min(volume * attenuation, accommodation * cellArea)
    deposition[i] = settled / cellArea
    depositedVolume += settled
    if (marine[i]) marineDepositedVolume += settled; else { terrestrialDepositedVolume += settled; if (lakeDepth > .01) lakeDepositedVolume += settled }
    const transported = volume - settled
    for (let r = 0; r < receivers; r++) { const j = targets[r]!, fraction = weights[r]! / sum; load[j] += transported * fraction; waterArea[j] += waterArea[i]! * fraction }
  }
  return { deposition, waterArea, sourceVolume, exportedVolume, depositedVolume, marineDepositedVolume, terrestrialDepositedVolume, lakeDepositedVolume, massBalanceError: sourceVolume - depositedVolume - exportedVolume }
}
