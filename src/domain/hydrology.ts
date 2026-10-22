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
export function routeDrainage(raw: Float32Array, columns: number, rows: number, cellSize: number): DrainageResult {
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

/** Few geomorphic relaxation steps, not a calibrated geologic clock or flood simulation. */
export function erodeTerrain(raw: Float32Array, columns: number, rows: number, cellSize: number, passes = 2) {
  let terrain = new Float32Array(raw), drainage = routeDrainage(terrain, columns, rows, cellSize)
  const initial = new Float32Array(raw)
  for (let pass = 0; pass < passes; pass++) {
    const next = new Float32Array(terrain)
    for (let y = 1; y < rows - 1; y++) for (let x = 1; x < columns - 1; x++) {
      const i = y * columns + x, downstream = drainage.flowTo[i]!
      if (terrain[i]! <= 0 || downstream < 0) continue
      const horizontal = (i % columns === downstream % columns || Math.floor(i / columns) === Math.floor(downstream / columns)) ? cellSize : cellSize * Math.SQRT2
      const slope = Math.max(0, (drainage.hydroDEM[i]! - drainage.hydroDEM[downstream]!) / horizontal)
      const catchmentKm2 = drainage.accumulatedArea[i]! / 1_000_000
      const incision = Math.min(3.5, 24 * Math.pow(catchmentKm2, .45) * slope)
      const mean = (terrain[i - 1]! + terrain[i + 1]! + terrain[i - columns]! + terrain[i + columns]!) / 4
      const diffusion = Math.max(-.8, Math.min(.8, (mean - terrain[i]!) * .10))
      next[i] = Math.max(.01, terrain[i]! - incision + diffusion)
    }
    terrain = next; drainage = routeDrainage(terrain, columns, rows, cellSize)
  }
  return { rawDEM: terrain, initialDEM: initial, ...drainage }
}
