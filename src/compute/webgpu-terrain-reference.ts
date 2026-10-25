import { routeDrainageJs } from '../domain/hydrology'
import type { DrainageResult, LandscapeOptions } from '../domain/hydrology'
import { routeLeastTransverse } from '../domain/flow-directions'
import { transportHillslope } from '../domain/hillslope-transport'
import { transportSediment } from '../domain/sediment-transport'

/** GPU model's independent CPU reference. Depression spill heights are the
 * exact Priority-Flood solution; equal-height lake surfaces use shortest
 * spill-distance instead of incidental heap-pop rank. LTD still inherits the
 * largest tributary's transverse error, rather than choosing raw D8 slopes. */
export function routeTerrainReference(raw: Float32Array, columns: number, rows: number, cellSize: number): DrainageResult & { flatDistance: Uint32Array } {
  const original = routeDrainageJs(raw, columns, rows, cellSize, 'd8'), z = original.hydroDEM, n = raw.length
  const distance = new Uint32Array(n).fill(0x3fffffff), queue = new Uint32Array(n)
  let head = 0, tail = 0
  const neighbors = (i: number, visit: (j: number) => void) => {
    const x = i % columns, y = Math.floor(i / columns)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy || x + dx < 0 || x + dx >= columns || y + dy < 0 || y + dy >= rows) continue
      visit(i + dy * columns + dx)
    }
  }
  for (let i = 0; i < n; i++) {
    const x = i % columns, y = Math.floor(i / columns)
    let outlet = x === 0 || y === 0 || x === columns - 1 || y === rows - 1
    neighbors(i, j => { if (z[j]! < z[i]!) outlet = true })
    if (outlet) { distance[i] = 0; queue[tail++] = i }
  }
  while (head < tail) { const i = queue[head++]!; neighbors(i, j => { if (z[j] === z[i] && distance[j]! > distance[i]! + 1) { distance[j] = distance[i]! + 1; queue[tail++] = j } }) }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => z[b]! - z[a]! || distance[b]! - distance[a]! || b - a)
  const rank = new Int32Array(n), fallback = new Int32Array(n).fill(-1)
  order.forEach((i, index) => { rank[i] = n - 1 - index })
  for (let i = 0; i < n; i++) {
    let best = -1, bestSlope = 0, flat = distance[i]!
    neighbors(i, j => {
      const diagonal = i % columns !== j % columns && Math.floor(i / columns) !== Math.floor(j / columns)
      const slope = (z[i]! - z[j]!) / (diagonal ? Math.SQRT2 : 1)
      if (slope > bestSlope + 1e-8) { bestSlope = slope; best = j }
      else if (bestSlope < 1e-8 && z[j] === z[i] && distance[j]! < flat) { flat = distance[j]!; best = j }
    })
    fallback[i] = best
  }
  return { hydroDEM: z, fillVolume: original.fillVolume, ...routeLeastTransverse({ elevation: z, columns, rows, cellSize, floodRank: rank, fallback }), flatDistance: distance }
}

/** Same stream-power, hillslope and sediment closures as the legacy solver;
 * only the explicitly documented flat routing differs. Kept outside the GPU
 * implementation so shader mistakes cannot manufacture their own reference. */
export function erodeTerrainReference(raw: Float32Array, columns: number, rows: number, cellSize: number, settings: LandscapeOptions = {}) {
  const passes = settings.passes ?? 32, dt = settings.timeStepYears ?? 250, cellArea = cellSize ** 2
  const diffusion = Math.min(.2, (settings.diffusivity ?? .2) * dt / cellArea)
  let terrain = new Float32Array(raw), drainage = routeTerrainReference(terrain, columns, rows, cellSize), alluvium = new Float64Array(raw.length)
  const firstFlow = drainage.flowTo.slice(), cumulative = new Float32Array(raw.length), rmsHistory: number[] = []
  const sediment = { erodedSourceVolume: 0, depositedVolume: 0, exportedVolume: 0, sedimentReentrainedVolume: 0, marineDepositedVolume: 0, terrestrialDepositedVolume: 0, lakeDepositedVolume: 0, hillslopeBedrockVolume: 0, hillslopeTransferredVolume: 0, storedVolume: 0, massBalanceError: 0 }
  let erodedVolume = 0, upliftVolume = 0, diffusionNetVolume = 0
  settings.onStep?.({ elevation: terrain.slice(), iteration: 0, iterations: passes, alluvium: alluvium.slice(), seaLevel: settings.seaLevel?.(0, passes) ?? 0 })
  for (let pass = 0; pass < passes; pass++) {
    const sea = settings.seaLevel?.(pass + 1, passes) ?? 0, next = terrain.slice(), detached = new Float64Array(raw.length)
    for (let k = drainage.order.length - 1; k >= 0; k--) {
      const i = drainage.order[k]!, receiver = drainage.flowTo[i]!, raised = terrain[i]! + (settings.uplift?.[i] ?? 0) * dt
      upliftVolume += (settings.uplift?.[i] ?? 0) * dt * cellArea; next[i] = raised
      if (i % columns === 0 || i % columns === columns - 1 || i < columns || i >= raw.length - columns || terrain[i]! <= sea || receiver < 0 || drainage.hydroDEM[i]! - terrain[i]! > .01) continue
      const length = i % columns === receiver % columns || Math.floor(i / columns) === Math.floor(receiver / columns) ? cellSize : cellSize * Math.SQRT2
      const level = Math.max(sea, next[receiver]!, drainage.hydroDEM[receiver]! - terrain[receiver]! > .01 ? drainage.hydroDEM[receiver]! : -Infinity)
      const coefficient = dt * (settings.erodibility?.[i] ?? 2.5e-5) * Math.sqrt(drainage.accumulatedArea[i]!) / length
      const incision = raised > level ? raised - (raised + coefficient * level) / (1 + coefficient) : 0
      const reentrained = Math.min(alluvium[i]!, incision)
      alluvium[i] -= reentrained; next[i] = raised - incision; cumulative[i] += incision
      sediment.sedimentReentrainedVolume += reentrained * cellArea; sediment.erodedSourceVolume += (incision - reentrained) * cellArea; erodedVolume += incision * cellArea
      if (settings.sediment) detached[i] = incision * cellArea; else sediment.exportedVolume += incision * cellArea
    }
    const creep = transportHillslope({ elevation: next, alluvium, columns, rows, cellSize, coefficient: diffusion, seaLevel: sea })
    const relaxed = creep.elevation; alluvium = creep.alluvium
    diffusionNetVolume += creep.netTerrainVolume; sediment.erodedSourceVolume += creep.bedrockSourceVolume; sediment.hillslopeBedrockVolume += creep.bedrockSourceVolume; sediment.hillslopeTransferredVolume += creep.transferredVolume
    if (settings.sediment) {
      const routed = routeTerrainReference(relaxed, columns, rows, cellSize)
      const material = transportSediment({ elevation: relaxed, hydroElevation: routed.hydroDEM, flowTo: routed.flowTo, order: routed.order, sourceVolume: detached, columns, rows, cellSize, seaLevel: sea })
      for (let i = 0; i < raw.length; i++) { relaxed[i] += material.deposition[i]!; alluvium[i] += material.deposition[i]! }
      sediment.depositedVolume += material.depositedVolume; sediment.exportedVolume += material.exportedVolume; sediment.marineDepositedVolume += material.marineDepositedVolume; sediment.terrestrialDepositedVolume += material.terrestrialDepositedVolume; sediment.lakeDepositedVolume += material.lakeDepositedVolume
    }
    rmsHistory.push(Math.sqrt(relaxed.reduce((s, z, i) => s + (z - terrain[i]!) ** 2, 0) / raw.length))
    terrain = relaxed; drainage = routeTerrainReference(terrain, columns, rows, cellSize)
    if ((pass + 1) % 4 === 0 || pass + 1 === passes) settings.onStep?.({ elevation: terrain.slice(), iteration: pass + 1, iterations: passes, alluvium: alluvium.slice(), seaLevel: sea })
  }
  let squares = 0, absolute = 0, changedCells = 0, reorganized = 0, maxIncision = 0, maxCumulativeIncision = 0, maxRaising = 0
  for (let i = 0; i < raw.length; i++) { const change = terrain[i]! - raw[i]!; squares += change * change; absolute += Math.abs(change); changedCells += Number(Math.abs(change) > .01); reorganized += Number(firstFlow[i] !== drainage.flowTo[i]); maxIncision = Math.max(maxIncision, -change); maxCumulativeIncision = Math.max(maxCumulativeIncision, cumulative[i]!); maxRaising = Math.max(maxRaising, change) }
  const initialTerrainVolume = raw.reduce((s, z) => s + z * cellArea, 0), finalTerrainVolume = terrain.reduce((s, z) => s + z * cellArea, 0)
  sediment.storedVolume = alluvium.reduce((s, z) => s + z * cellArea, 0); sediment.massBalanceError = sediment.erodedSourceVolume - sediment.storedVolume - sediment.exportedVolume
  const erosion = { iterations: passes, timeStepYears: dt, elapsedYears: passes * dt, erodedVolume, upliftVolume, maxIncision, maxCumulativeIncision, maxRaising, rmsElevationChange: Math.sqrt(squares / raw.length), meanAbsoluteChange: absolute / raw.length, changedCells, finalStepRms: rmsHistory.at(-1) ?? 0, flowReorganization: reorganized / raw.length, rmsHistory, initialTerrainVolume, finalTerrainVolume, diffusionNetVolume, terrainBalanceError: finalTerrainVolume - initialTerrainVolume - upliftVolume + erodedVolume - sediment.depositedVolume - diffusionNetVolume }
  return { rawDEM: terrain, initialDEM: raw.slice(), alluvium: Float32Array.from(alluvium), alluvium64: alluvium, sediment, erosion, ...drainage }
}
