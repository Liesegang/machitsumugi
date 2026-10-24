import type { Point } from '../domain/types'
import { regionQuery } from '../domain/region-query'

export interface ComputeRegion { polygon: Point[]; holes?: Point[][] }
export interface RegionGridBounds { minX: number; minY: number; maxX: number; maxY: number; cellSize: number }
export interface PreparedRegionGrid {
  bounds: RegionGridBounds
  columns: number
  rows: number
  /** 0=dry, 1=occupied, 2=exact CPU query required. */
  mask: Uint32Array
  exact: (point: Point) => boolean
  coordinateError: number
  regions: Uint32Array
  rings: ArrayBuffer
  edges: Float32Array
  bands: Uint32Array
  edgeIndices: Uint32Array
  boundaryCells: number
}

const MAX_CELLS = 8_000_000

function clipEdge(a: Point, b: Point, bounds: RegionGridBounds): [Point, Point] | null {
  const dx = b.x - a.x, dy = b.y - a.y, pad = bounds.cellSize * 2
  let first = 0, last = 1
  for (const [p, q] of [[-dx, a.x - bounds.minX + pad], [dx, bounds.maxX + pad - a.x], [-dy, a.y - bounds.minY + pad], [dy, bounds.maxY + pad - a.y]]) {
    if (p === 0) { if (q! < 0) return null; continue }
    const t = q! / p!
    if (p! < 0) first = Math.max(first, t); else last = Math.min(last, t)
    if (first > last) return null
  }
  return [{ x: a.x + first * dx, y: a.y + first * dy }, { x: a.x + last * dx, y: a.y + last * dy }]
}

/** A double-precision supercover walk, padded by a whole cell. It is deliberately
 * conservative at corners and grid lines. A long diagonal does not mark its
 * entire bounding rectangle as uncertain. No polygon coordinates are rounded. */
function markBoundary(mask: Uint32Array, columns: number, rows: number, bounds: RegionGridBounds, a: Point, b: Point) {
  const clipped = clipEdge(a, b, bounds)
  if (!clipped) return
  const [first, last] = clipped, size = bounds.cellSize
  let x = Math.floor((first.x - bounds.minX) / size), y = Math.floor((first.y - bounds.minY) / size)
  const endX = Math.floor((last.x - bounds.minX) / size), endY = Math.floor((last.y - bounds.minY) / size)
  const dx = last.x - first.x, dy = last.y - first.y, sx = Math.sign(dx), sy = Math.sign(dy)
  const deltaX = dx ? size / Math.abs(dx) : Infinity, deltaY = dy ? size / Math.abs(dy) : Infinity
  let nextX = dx ? (bounds.minX + (x + Number(sx > 0)) * size - first.x) / dx : Infinity
  let nextY = dy ? (bounds.minY + (y + Number(sy > 0)) * size - first.y) / dy : Infinity
  const limit = Math.abs(endX - x) + Math.abs(endY - y) + 4
  for (let i = 0; i < limit; i++) {
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const px = x + ox, py = y + oy
      if (px >= 0 && py >= 0 && px < columns && py < rows) mask[py * columns + px] = 2
    }
    if (x === endX && y === endY) return
    // The final endpoint can lie within a few f64 ULPs of a grid line. Once
    // its terminal cell is reached on one axis, rounding must not advance that
    // axis past the endpoint while the other axis catches up.
    if (x === endX) nextX = Infinity
    if (y === endY) nextY = Infinity
    if (nextX < nextY) { x += sx; nextX += deltaX }
    else if (nextY < nextX) { y += sy; nextY += deltaY }
    else { x += sx; y += sy; nextX += deltaX; nextY += deltaY }
  }
  // Fail closed if a pathological edge defeats the traversal guard.
  mask.fill(2)
}

export function prepareRegionGrid(regions: readonly ComputeRegion[], bounds: RegionGridBounds): PreparedRegionGrid {
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, bounds.cellSize].every(Number.isFinite) || bounds.cellSize <= 0 || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) throw new RangeError('A region grid requires finite, positive bounds and cell size')
  const columns = Math.ceil((bounds.maxX - bounds.minX) / bounds.cellSize), rows = Math.ceil((bounds.maxY - bounds.minY) / bounds.cellSize)
  if (columns * rows > MAX_CELLS) throw new RangeError(`A region grid is limited to ${MAX_CELLS.toLocaleString('en-US')} cells`)
  const valid = regions.filter(region => region.polygon.length >= 3)
  const sourceRings = valid.flatMap(region => [region.polygon, ...(region.holes ?? [])])
  let maxCoordinate = Math.max(Math.abs(bounds.minX), Math.abs(bounds.minY), Math.abs(bounds.maxX), Math.abs(bounds.maxY))
  for (const ring of sourceRings) for (const point of ring) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 10_000_000 || Math.abs(point.y) > 10_000_000) throw new RangeError('Region grid vertices must be finite coordinates within 10,000km')
    maxCoordinate = Math.max(maxCoordinate, Math.abs(point.x), Math.abs(point.y))
  }
  // Covers input conversion, grid-centre construction and multiple f32 ULPs.
  // The shader applies a further determinant error bound. Uncertain results
  // are never used to approve or reject land/water at a requested point.
  const coordinateError = (maxCoordinate + bounds.cellSize * Math.max(columns, rows)) * 2 ** -19 + 1e-5
  if (coordinateError > bounds.cellSize / 4) throw new RangeError('Region grid coordinates require excessive f32 precision; use exact CPU queries')
  const mask = new Uint32Array(columns * rows)
  const regionWords = new Uint32Array(valid.length * 2), ringBytes = new ArrayBuffer(sourceRings.length * 32)
  const ringFloats = new Float32Array(ringBytes), ringUnsigned = new Uint32Array(ringBytes), ringSigned = new Int32Array(ringBytes)
  const edgeData: number[] = [], bandData: number[] = [], edgeIndices: number[] = []
  let ringIndex = 0
  for (let r = 0; r < valid.length; r++) {
    const rings = [valid[r]!.polygon, ...(valid[r]!.holes ?? [])]
    regionWords[r * 2] = ringIndex; regionWords[r * 2 + 1] = rings.length
    for (const ring of rings) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y) }
      const firstRow = Math.max(0, Math.ceil((y0 - coordinateError - bounds.minY) / bounds.cellSize - .5))
      const lastRow = Math.min(rows - 1, Math.floor((y1 + coordinateError - bounds.minY) / bounds.cellSize - .5))
      const rowCount = Math.max(0, lastRow - firstRow + 1), rowEdges: number[][] = Array.from({ length: rowCount }, () => [])
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!, b = ring[j]!
        markBoundary(mask, columns, rows, bounds, a, b)
        if (a.y === b.y) continue
        const edgeIndex = edgeData.length / 4
        edgeData.push(a.x, a.y, b.x, b.y)
        const lo = Math.max(firstRow, Math.ceil((Math.min(a.y, b.y) - coordinateError - bounds.minY) / bounds.cellSize - .5))
        const hi = Math.min(lastRow, Math.floor((Math.max(a.y, b.y) + coordinateError - bounds.minY) / bounds.cellSize - .5))
        for (let row = lo; row <= hi; row++) rowEdges[row - firstRow]!.push(edgeIndex)
      }
      const word = ringIndex * 8
      ringFloats[word] = x0; ringFloats[word + 1] = y0; ringFloats[word + 2] = x1; ringFloats[word + 3] = y1
      ringUnsigned[word + 4] = bandData.length / 2; ringSigned[word + 5] = firstRow; ringUnsigned[word + 6] = rowCount
      for (const edges of rowEdges) { bandData.push(edgeIndices.length, edges.length); edgeIndices.push(...edges) }
      ringIndex++
    }
  }
  let boundaryCells = 0
  for (const value of mask) if (value === 2) boundaryCells++
  return { bounds: { ...bounds }, columns, rows, mask, exact: regionQuery(valid), coordinateError, regions: regionWords, rings: ringBytes, edges: Float32Array.from(edgeData), bands: Uint32Array.from(bandData), edgeIndices: Uint32Array.from(edgeIndices), boundaryCells }
}

export function fillRegionGridCPU(grid: PreparedRegionGrid) {
  for (let y = 0; y < grid.rows; y++) for (let x = 0; x < grid.columns; x++) {
    const index = y * grid.columns + x
    if (grid.mask[index] === 2) continue
    grid.mask[index] = Number(grid.exact({ x: grid.bounds.minX + (x + .5) * grid.bounds.cellSize, y: grid.bounds.minY + (y + .5) * grid.bounds.cellSize }))
  }
  return grid.mask
}

export function regionGridIndex(grid: Pick<PreparedRegionGrid, 'bounds' | 'columns' | 'rows'>, point: Point) {
  const { bounds } = grid
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < bounds.minX || point.y < bounds.minY || point.x >= bounds.maxX || point.y >= bounds.maxY) return -1
  return Math.floor((point.y - bounds.minY) / bounds.cellSize) * grid.columns + Math.floor((point.x - bounds.minX) / bounds.cellSize)
}
