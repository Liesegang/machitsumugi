/** Conservative linear hillslope creep on cell faces. Only faces outside the
 * domain have zero flux; perimeter cells still exchange with interior neighbours.
 * Fluvial export is handled by sediment transport.
 * Marine beds do not erode through this closure, but receive land-derived soil.
 * The loose layer moves with the solid material instead of staying behind at
 * the old coordinate when the terrain is diffused.
 */
export function transportHillslope(input: { elevation: Float32Array; alluvium: Float64Array; columns: number; rows: number; cellSize: number; coefficient: number; seaLevel: number }) {
  const { elevation, alluvium, columns, rows, cellSize, seaLevel } = input
  const coefficient = Math.max(0, Math.min(.2, input.coefficient)), outgoing = new Float64Array(elevation.length), incoming = new Float64Array(elevation.length)
  const face = (a: number, b: number) => {
    const from = elevation[a]! > elevation[b]! ? a : b, to = from === a ? b : a
    if (elevation[from]! <= seaLevel) return
    const transfer = coefficient * (elevation[from]! - elevation[to]!)
    outgoing[from] += transfer; incoming[to] += transfer
  }
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const i = y * columns + x
    if (x + 1 < columns) face(i, i + 1)
    if (y + 1 < rows) face(i, i + columns)
  }
  const next = new Float32Array(elevation), loose = new Float64Array(alluvium)
  let bedrockSourceVolume = 0, transferredVolume = 0, netTerrainVolume = 0
  for (let i = 0; i < next.length; i++) {
    const removedLoose = Math.min(alluvium[i]!, outgoing[i]!)
    loose[i] = alluvium[i]! - removedLoose + incoming[i]!
    bedrockSourceVolume += (outgoing[i]! - removedLoose) * cellSize ** 2
    transferredVolume += outgoing[i]! * cellSize ** 2
    next[i] = elevation[i]! + incoming[i]! - outgoing[i]!
    netTerrainVolume += (next[i]! - elevation[i]!) * cellSize ** 2
  }
  return { elevation: next, alluvium: loose, bedrockSourceVolume, transferredVolume, netTerrainVolume }
}
