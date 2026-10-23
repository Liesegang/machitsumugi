/** Nondispersive drainage with accumulated transverse error (Orlandini et al.,
 * 2003, D8-LTD, lambda=1). A triangular-facet gradient is continuous; each raster
 * step chooses the adjacent receiver whose cumulative cross-stream error is
 * smaller. At a confluence, memory follows the largest upstream contributing
 * path. No random direction or synthetic channel is introduced.
 */
export function routeLeastTransverse(input: { elevation: Float32Array; columns: number; rows: number; cellSize: number; floodRank: Int32Array; fallback: Int32Array }) {
  const { elevation: z, columns, rows, cellSize, floodRank, fallback } = input, count = z.length
  const order = new Int32Array(count), flowTo = new Int32Array(count), area = new Float64Array(count).fill(cellSize ** 2)
  const inherited = new Float64Array(count), largest = new Float64Array(count)
  for (let i = 0; i < count; i++) order[count - 1 - floodRank[i]!] = i
  const facets = [
    [1, 0, 1, 1], [0, 1, 1, 1], [0, 1, -1, 1], [-1, 0, -1, 1],
    [-1, 0, -1, -1], [0, -1, -1, -1], [0, -1, 1, -1], [1, 0, 1, -1],
  ]
  let outletArea = 0
  for (const i of order) {
    const x = i % columns, y = Math.floor(i / columns), height = z[i]!
    let bestSlope = 0, cardinal = -1, diagonal = -1, ux = 0, uy = 0
    let cdx = 0, cdy = 0, ddx = 0, ddy = 0
    for (const facet of facets) {
      const [cx, cy, dx, dy] = facet as [number, number, number, number]
      if (x + cx < 0 || x + cx >= columns || y + cy < 0 || y + cy >= rows || x + dx < 0 || x + dx >= columns || y + dy < 0 || y + dy >= rows) continue
      const a = i + cy * columns + cx, b = i + dy * columns + dx
      const s1 = height - z[a]!, s2 = z[a]! - z[b]!
      let slope: number, vx: number, vy: number, ca = a, cb = b
      if (s2 <= 0) { slope = s1; vx = cx; vy = cy; cb = a }
      else if (s2 >= s1) { slope = (height - z[b]!) / Math.SQRT2; vx = dx / Math.SQRT2; vy = dy / Math.SQRT2; ca = b }
      else { slope = Math.hypot(s1, s2); vx = (s1 * cx + s2 * (dx - cx)) / slope; vy = (s1 * cy + s2 * (dy - cy)) / slope }
      if (slope > bestSlope + 1e-8) { bestSlope = slope; cardinal = ca; diagonal = cb; ux = vx; uy = vy; cdx = ca === a ? cx : dx; cdy = ca === a ? cy : dy; ddx = cb === b ? dx : cx; ddy = cb === b ? dy : cy }
    }
    let receiver = fallback[i]!, residual = 0
    const lower = (j: number) => j >= 0 && (z[j]! < height || z[j] === height && floodRank[j]! < floodRank[i]!)
    if (bestSlope > 1e-8 && lower(cardinal) && lower(diagonal)) {
      const firstError = inherited[i]! + (ux * cdy - uy * cdx) * cellSize
      const secondError = inherited[i]! + (ux * ddy - uy * ddx) * cellSize
      if (Math.abs(firstError) <= Math.abs(secondError)) { receiver = cardinal; residual = firstError }
      else { receiver = diagonal; residual = secondError }
    }
    flowTo[i] = receiver
    if (receiver < 0) outletArea += area[i]!
    else {
      area[receiver] += area[i]!
      if (area[i]! > largest[receiver]!) { largest[receiver] = area[i]!; inherited[receiver] = residual }
    }
  }
  return { flowTo, accumulatedArea: area, order, processedCells: count, outletArea }
}
