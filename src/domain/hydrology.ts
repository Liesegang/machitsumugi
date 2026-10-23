import { transportSediment } from './sediment-transport.ts'
import { routeLeastTransverse } from './flow-directions.ts'
import { transportHillslope } from './hillslope-transport.ts'
/** DEM conditioning and single-flow drainage. Distances/elevations are metres; area is m². */
export interface DrainageResult {
  hydroDEM: Float32Array
  flowTo: Int32Array
  accumulatedArea: Float64Array
  order: Int32Array
  processedCells: number
  outletArea: number
  fillVolume: number
}

/** Priority-Flood fills accidental pits; equal-height flats drain using the flood ordering. */
export function routeDrainage(raw: Float32Array, columns: number, rows: number, cellSize: number, method: 'd8' | 'd8-ltd' = 'd8-ltd'): DrainageResult {
  const count = columns * rows, hydroDEM = new Float32Array(raw), visited = new Uint8Array(count)
  const heap = new Int32Array(count), rank = new Int32Array(count), floodParent = new Int32Array(count)
  floodParent.fill(-1)
  let heapSize = 0
  const less = (a: number, b: number) => hydroDEM[a]! < hydroDEM[b]! || hydroDEM[a] === hydroDEM[b] && a < b
  const push = (cell: number) => {
    let i = heapSize++
    while (i > 0) { const parent = (i - 1) >>> 1; if (!less(cell, heap[parent]!)) break; heap[i] = heap[parent]!; i = parent }
    heap[i] = cell
  }
  const pop = () => {
    const first = heap[0]!, last = heap[--heapSize]!
    let i = 0
    while (i * 2 + 1 < heapSize) {
      let child = i * 2 + 1
      if (child + 1 < heapSize && less(heap[child + 1]!, heap[child]!)) child++
      if (!less(heap[child]!, last)) break
      heap[i] = heap[child]!; i = child
    }
    heap[i] = last
    return first
  }
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) if (!x || !y || x === columns - 1 || y === rows - 1) {
    const i = y * columns + x; visited[i] = 1; push(i)
  }
  let popped = 0, fillVolume = 0
  while (heapSize) {
    const i = pop(), x = i % columns, y = Math.floor(i / columns)
    rank[i] = popped++
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue
      const j = ny * columns + nx
      if (visited[j]) continue
      visited[j] = 1; floodParent[j] = i
      if (hydroDEM[j]! < hydroDEM[i]!) { fillVolume += (hydroDEM[i]! - hydroDEM[j]!) * cellSize * cellSize; hydroDEM[j] = hydroDEM[i]! }
      push(j)
    }
  }
  const flowTo = new Int32Array(count), indegree = new Uint8Array(count), accumulatedArea = new Float64Array(count)
  flowTo.fill(-1); accumulatedArea.fill(cellSize * cellSize)
  for (let i = 0; i < count; i++) {
    const x = i % columns, y = Math.floor(i / columns)
    let best = -1, bestSlope = 0, flatRank = rank[i]!
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue
      const j = ny * columns + nx, drop = hydroDEM[i]! - hydroDEM[j]!, slope = drop / (dx && dy ? Math.SQRT2 : 1)
      if (slope > bestSlope + 1e-8) { bestSlope = slope; best = j }
      else if (bestSlope < 1e-8 && Math.abs(drop) < 1e-6 && rank[j]! < flatRank) { flatRank = rank[j]!; best = j }
    }
    if (best < 0 && floodParent[i]! >= 0) best = floodParent[i]!
    flowTo[i] = best
    if (best >= 0) indegree[best]++
  }
  if (method === 'd8-ltd') return { hydroDEM, fillVolume, ...routeLeastTransverse({ elevation: hydroDEM, columns, rows, cellSize, floodRank: rank, fallback: flowTo }) }
  const order = new Int32Array(count)
  let head = 0, tail = 0, outletArea = 0
  for (let i = 0; i < count; i++) if (!indegree[i]) order[tail++] = i
  while (head < tail) {
    const i = order[head++]!, next = flowTo[i]!
    if (next < 0) outletArea += accumulatedArea[i]!
    else { accumulatedArea[next] += accumulatedArea[i]!; if (--indegree[next] === 0) order[tail++] = next }
  }
  return { hydroDEM, flowTo, accumulatedArea, order, processedCells: tail, outletArea, fillVolume }
}

export interface LandscapeOptions {
  passes?: number
  timeStepYears?: number
  uplift?: Float32Array
  erodibility?: Float32Array
  diffusivity?: number
  sediment?: boolean
  seaLevel?: (iteration: number, iterations: number) => number
  onStep?: (state: { elevation: Float32Array; iteration: number; iterations: number; alluvium: Float64Array; seaLevel: number }) => void
}
export interface SedimentDiagnostics {
  erodedSourceVolume: number; depositedVolume: number; exportedVolume: number
  sedimentReentrainedVolume: number; marineDepositedVolume: number; terrestrialDepositedVolume: number; lakeDepositedVolume: number
  hillslopeBedrockVolume: number; hillslopeTransferredVolume: number
  storedVolume: number; massBalanceError: number
}
export interface ErosionDiagnostics {
  iterations: number; timeStepYears: number; elapsedYears: number
  erodedVolume: number; upliftVolume: number; maxIncision: number; maxCumulativeIncision: number; maxRaising: number
  rmsElevationChange: number; meanAbsoluteChange: number; changedCells: number
  finalStepRms: number; flowReorganization: number; rmsHistory: number[]
  initialTerrainVolume: number; finalTerrainVolume: number; diffusionNetVolume: number; terrainBalanceError: number
}

/**
 * Detachment-limited stream-power landscape evolution, m=.5, n=1. Receiver-first
 * implicit integration follows the equation used by Cordonnier et al. (2016),
 * after Braun & Willett (2013). The raster routing/initial relief here differ
 * from that paper's triangulated graph and flat-start convergence experiment.
 * Optional conservative multi-flow sediment routing follows each incision step.
 * This is not SPACE: bedrock/alluvium share erodibility, runoff is time-averaged,
 * and marine waves, grain sorting and 2-D water momentum are not solved.
 */
export function erodeTerrain(raw: Float32Array, columns: number, rows: number, cellSize: number, options: number | LandscapeOptions = 32) {
  const settings = typeof options === 'number' ? { passes: options } : options
  const passes = settings.passes ?? 32, dt = settings.timeStepYears ?? 250
  const diffusion = Math.min(.2, (settings.diffusivity ?? .2) * dt / (cellSize * cellSize))
  let terrain = new Float32Array(raw), drainage = routeDrainage(terrain, columns, rows, cellSize)
  const initial = new Float32Array(raw)
  const firstFlow = new Int32Array(drainage.flowTo), cumulativeIncision = new Float32Array(raw.length)
  let alluvium = new Float64Array(raw.length)
  const sediment: SedimentDiagnostics = { erodedSourceVolume: 0, depositedVolume: 0, exportedVolume: 0, sedimentReentrainedVolume: 0, marineDepositedVolume: 0, terrestrialDepositedVolume: 0, lakeDepositedVolume: 0, hillslopeBedrockVolume: 0, hillslopeTransferredVolume: 0, storedVolume: 0, massBalanceError: 0 }
  let erodedVolume = 0, upliftVolume = 0, diffusionNetVolume = 0
  const rmsHistory: number[] = []
  settings.onStep?.({ elevation: terrain, iteration: 0, iterations: passes, alluvium, seaLevel: settings.seaLevel?.(0, passes) ?? 0 })
  for (let pass = 0; pass < passes; pass++) {
    const seaLevel = settings.seaLevel?.(pass + 1, passes) ?? 0
    const next = new Float32Array(terrain)
    const detached = new Float64Array(raw.length)
    const incisionArea = drainage.accumulatedArea
    // order is sources→outlets; reversal makes every updated receiver available.
    for (let index = drainage.processedCells - 1; index >= 0; index--) {
      const i = drainage.order[index]!, x = i % columns, y = Math.floor(i / columns), downstream = drainage.flowTo[i]!
      if (!x || !y || x === columns - 1 || y === rows - 1) continue
      const uplift = (settings.uplift?.[i] ?? 0) * dt, raised = terrain[i]! + uplift
      next[i] = raised; upliftVolume += uplift * cellSize ** 2
      // Tectonic uplift applies to the prescribed crust field under the sea as
      // well as exposed land. The absence of a marine erosion model must not
      // suppress submarine uplift until sediment happens to expose the cell.
      if (terrain[i]! <= seaLevel || downstream < 0) continue
      const horizontal = (i % columns === downstream % columns || Math.floor(i / columns) === Math.floor(downstream / columns)) ? cellSize : cellSize * Math.SQRT2
      // A conditioned depression is standing water at its spill level. Routing
      // across its surface must not excavate a fictitious river in its bed, or
      // let an inflowing channel incise below that receiving water surface.
      // Uplift still applies to the submerged bed; lake filling is handled by
      // the supplied sediment, never by turning hydroDEM into solid ground.
      const receiverLake = drainage.hydroDEM[downstream]! - terrain[downstream]! > .01
      const receiver = Math.max(seaLevel, next[downstream]!, receiverLake ? drainage.hydroDEM[downstream]! : -Infinity), k = settings.erodibility?.[i] ?? 2.5e-5
      const coefficient = dt * k * Math.sqrt(incisionArea[i]!) / horizontal
      const submerged = drainage.hydroDEM[i]! - terrain[i]! > .01
      const eroded = !submerged && raised > receiver ? (raised + coefficient * receiver) / (1 + coefficient) : raised
      const incision = raised - eroded
      const reentrained = Math.min(alluvium[i]!, incision)
      alluvium[i] -= reentrained
      sediment.sedimentReentrainedVolume += reentrained * cellSize ** 2
      sediment.erodedSourceVolume += (incision - reentrained) * cellSize ** 2
      if (settings.sediment) detached[i] = incision * cellSize ** 2
      else sediment.exportedVolume += incision * cellSize ** 2 // Detachment-limited boundary: no fluvial redeposition.
      next[i] = eroded
      cumulativeIncision[i] += incision
      erodedVolume += incision * cellSize * cellSize
    }
    const creep = transportHillslope({ elevation: next, alluvium, columns, rows, cellSize, coefficient: diffusion, seaLevel })
    const relaxed = creep.elevation
    alluvium = creep.alluvium
    diffusionNetVolume += creep.netTerrainVolume
    sediment.erodedSourceVolume += creep.bedrockSourceVolume
    sediment.hillslopeBedrockVolume += creep.bedrockSourceVolume
    sediment.hillslopeTransferredVolume += creep.transferredVolume
    let squares = 0
    if (settings.sediment) {
      const routed = routeDrainage(relaxed, columns, rows, cellSize)
      const transported = transportSediment({ elevation: relaxed, hydroElevation: routed.hydroDEM, flowTo: routed.flowTo, order: routed.order, sourceVolume: detached, columns, rows, cellSize, seaLevel })
      for (let i = 0; i < relaxed.length; i++) { relaxed[i] += transported.deposition[i]!; alluvium[i] += transported.deposition[i]! }
      sediment.depositedVolume += transported.depositedVolume
      sediment.exportedVolume += transported.exportedVolume
      sediment.marineDepositedVolume += transported.marineDepositedVolume
      sediment.terrestrialDepositedVolume += transported.terrestrialDepositedVolume
      sediment.lakeDepositedVolume += transported.lakeDepositedVolume
    }
    for (let i = 0; i < raw.length; i++) squares += (relaxed[i]! - terrain[i]!) ** 2
    rmsHistory.push(Math.sqrt(squares / raw.length))
    terrain = relaxed; drainage = routeDrainage(terrain, columns, rows, cellSize)
    if ((pass + 1) % 4 === 0 || pass + 1 === passes) settings.onStep?.({ elevation: terrain, iteration: pass + 1, iterations: passes, alluvium, seaLevel })
  }
  let squares = 0, absolute = 0, changedCells = 0, reorganized = 0, maxIncision = 0, maxCumulativeIncision = 0, maxRaising = 0
  for (let i = 0; i < raw.length; i++) {
    const change = terrain[i]! - raw[i]!
    squares += change * change; absolute += Math.abs(change)
    if (Math.abs(change) > .01) changedCells++
    if (firstFlow[i] !== drainage.flowTo[i]) reorganized++
    maxIncision = Math.max(maxIncision, -change); maxRaising = Math.max(maxRaising, change)
    maxCumulativeIncision = Math.max(maxCumulativeIncision, cumulativeIncision[i]!)
  }
  const initialTerrainVolume = raw.reduce((sum, value) => sum + value * cellSize ** 2, 0), finalTerrainVolume = terrain.reduce((sum, value) => sum + value * cellSize ** 2, 0)
  const terrainBalanceError = finalTerrainVolume - initialTerrainVolume - upliftVolume + erodedVolume - sediment.depositedVolume - diffusionNetVolume
  const erosion: ErosionDiagnostics = { iterations: passes, timeStepYears: dt, elapsedYears: passes * dt, erodedVolume, upliftVolume, maxIncision, maxCumulativeIncision, maxRaising, rmsElevationChange: Math.sqrt(squares / raw.length), meanAbsoluteChange: absolute / raw.length, changedCells, finalStepRms: rmsHistory.at(-1) ?? 0, flowReorganization: reorganized / raw.length, rmsHistory, initialTerrainVolume, finalTerrainVolume, diffusionNetVolume, terrainBalanceError }
  sediment.storedVolume = alluvium.reduce((sum, thickness) => sum + thickness * cellSize ** 2, 0)
  sediment.massBalanceError = sediment.erodedSourceVolume - sediment.storedVolume - sediment.exportedVolume
  return { rawDEM: terrain, initialDEM: initial, alluvium: Float32Array.from(alluvium), sediment, erosion, ...drainage }
}
