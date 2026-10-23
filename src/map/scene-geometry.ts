import type { Point, Road, TerrainSurface } from '../domain/types'
import polygonClipping from 'polygon-clipping'
import { subtractRegions } from '../domain/geometry'
import type { PolygonRegion } from '../domain/geometry'

export interface HeightPoint extends Point { elevation: number }

/** The displayed DEM consists of two planes per cell, separated by the B–C
 * diagonal. Bilinear interpolation is a different surface on a saddle cell. */
export function terrainMeshGrid(surface: TerrainSurface | undefined, width: number, height: number) {
  const valid = surface && surface.columns >= 2 && surface.rows >= 2 && surface.elevations.length === surface.columns * surface.rows
  const columns = valid ? surface.columns : 81, rows = valid ? surface.rows : 61, dx = width / (columns - 1), dy = height / (rows - 1)
  const point = (column: number, row: number): Point => ({ x: column * dx, y: row * dy })
  const at = (column: number, row: number) => valid ? surface.elevations[row * columns + column]! : 0
  const elevation = (p: Point) => {
    const x = Math.max(0, Math.min(columns - 1, p.x / dx)), y = Math.max(0, Math.min(rows - 1, p.y / dy)), c = Math.min(columns - 2, Math.floor(x)), r = Math.min(rows - 2, Math.floor(y)), u = x - c, v = y - r
    return u + v <= 1 ? at(c, r) * (1 - u - v) + at(c + 1, r) * u + at(c, r + 1) * v : at(c + 1, r + 1) * (u + v - 1) + at(c, r + 1) * (1 - u) + at(c + 1, r) * (1 - v)
  }
  const triangle = (column: number, row: number, upper: boolean): Point[] => upper ? [point(column + 1, row), point(column + 1, row + 1), point(column, row + 1)] : [point(column, row), point(column + 1, row), point(column, row + 1)]
  const key = (column: number, row: number, upper: boolean) => ((row * (columns - 1) + column) * 2) + Number(upper)
  return { columns, rows, width, height, dx, dy, point, elevation, triangle, key }
}
export type TerrainMeshGrid = ReturnType<typeof terrainMeshGrid>

export interface TerrainWaterFragment extends PolygonRegion { level: number | undefined }
/** One visible water surface and no hidden ground below it. Standing water
 * levels take precedence over flowing water; true island holes remain dry. */
export function partitionTerrainWater(ground: Point[], fragments: TerrainWaterFragment[]) {
  const groups = new Map<number | undefined, TerrainWaterFragment[]>()
  for (const fragment of fragments) { const list = groups.get(fragment.level) ?? []; list.push(fragment); groups.set(fragment.level, list) }
  const occupied: PolygonRegion[] = [], surfaces: TerrainWaterFragment[] = []
  for (const [level, regions] of [...groups].sort(([a], [b]) => (b ?? -Infinity) - (a ?? -Infinity))) {
    const inputs = regions.map(region => [region.polygon, ...region.holes ?? []].map(ring => ring.map(p => [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6])) as polygonClipping.Polygon)
    const union = polygonClipping.union(inputs[0]!, ...inputs.slice(1))
    for (const rings of union) {
      const region = { polygon: rings[0]!.slice(0, -1).map(([x, y]) => ({ x, y })), holes: rings.slice(1).map(ring => ring.slice(0, -1).map(([x, y]) => ({ x, y }))) }
      for (const visible of subtractRegions(region, occupied)) { surfaces.push({ ...visible, level }); occupied.push(visible) }
    }
  }
  return { surfaces, dry: subtractRegions({ polygon: ground }, occupied) }
}

function clipPolygonToTriangle(polygon: Point[], triangle: Point[]): Point[] {
  let result = polygon
  for (let i = 0; i < 3; i++) {
    const a = triangle[i]!, b = triangle[(i + 1) % 3]!, side = (p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    const input = result; result = []
    for (let j = 0; j < input.length; j++) {
      const p = input[j]!, q = input[(j + 1) % input.length]!, sp = side(p), sq = side(q), pIn = sp >= -1e-8, qIn = sq >= -1e-8
      if (pIn) result.push(p)
      if (pIn !== qIn) { const t = sp / (sp - sq); result.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }) }
    }
    if (result.length < 3) return []
  }
  const area = result.reduce((sum, p, i) => { const q = result[(i + 1) % result.length]!; return sum + p.x * q.y - q.x * p.y }, 0)
  return Math.abs(area) > 1e-8 ? result : []
}

/** Subdivide a convex overlay at every displayed DEM triangle. Sampling only
 * its boundary cannot stop the interior of a long road/water face cutting soil. */
export function* splitTerrainFace(polygon: Point[], grid: TerrainMeshGrid): Generator<{ key: number; polygon: Point[]; ground: Point[] }> {
  if (polygon.length < 3) return
  const minX = Math.min(...polygon.map(p => p.x)), maxX = Math.max(...polygon.map(p => p.x)), minY = Math.min(...polygon.map(p => p.y)), maxY = Math.max(...polygon.map(p => p.y))
  if (maxX < 0 || maxY < 0 || minX > grid.width || minY > grid.height) return
  const firstX = Math.max(0, Math.min(grid.columns - 2, Math.floor(minX / grid.dx))), lastX = Math.max(0, Math.min(grid.columns - 2, Math.floor(maxX / grid.dx)))
  const firstY = Math.max(0, Math.min(grid.rows - 2, Math.floor(minY / grid.dy))), lastY = Math.max(0, Math.min(grid.rows - 2, Math.floor(maxY / grid.dy)))
  for (let y = firstY; y <= lastY; y++) for (let x = firstX; x <= lastX; x++) for (const upper of [false, true]) {
    const ground = grid.triangle(x, y, upper), part = clipPolygonToTriangle(polygon, ground)
    if (part.length >= 3) yield { key: grid.key(x, y, upper), polygon: part, ground }
  }
}

/** Trim canonical off-map routes before sampling the finite saved DEM. */
export function clipSegmentToMap(a: Point, b: Point, width: number, height: number, padding = 0) {
  const dx = b.x - a.x, dy = b.y - a.y
  let start = 0, end = 1
  for (const [p, q] of [[-dx, a.x + padding], [dx, width + padding - a.x], [-dy, a.y + padding], [dy, height + padding - a.y]]) {
    if (Math.abs(p!) < 1e-12) { if (q! < 0) return null; continue }
    const t = q! / p!
    if (p! < 0) start = Math.max(start, t); else end = Math.min(end, t)
    if (start > end) return null
  }
  const point = (t: number) => ({ x: Math.max(-padding, Math.min(width + padding, a.x + dx * t)), y: Math.max(-padding, Math.min(height + padding, a.y + dy * t)) })
  return { from: point(start), to: point(end), start, end }
}

/** Convex surface clipping preserves deck elevation at each crop intersection. */
export function clipSurfaceToMap(vertices: HeightPoint[], width: number, height: number): HeightPoint[] {
  let result = vertices
  for (const [axis, bound, sign] of [['x', 0, 1], ['x', width, -1], ['y', 0, 1], ['y', height, -1]] as const) {
    const input = result; result = []
    if (!input.length) break
    for (let i = 0; i < input.length; i++) {
      const a = input[i]!, b = input[(i + 1) % input.length]!, aIn = (a[axis] - bound) * sign >= 0, bIn = (b[axis] - bound) * sign >= 0
      if (aIn) result.push(a)
      if (aIn !== bIn) {
        const t = (bound - a[axis]) / (b[axis] - a[axis])
        const intersection = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, elevation: a.elevation + (b.elevation - a.elevation) * t }
        intersection[axis] = bound; result.push(intersection)
      }
    }
  }
  return result
}

/** Level is a display assumption of six metres, with ramps graded by chainage. */
export function roadDeckOffsets(road: Road): number[] {
  const chainage = [0]
  for (let i = 1; i < road.points.length; i++) chainage[i] = chainage[i - 1]! + Math.hypot(road.points[i]!.x - road.points[i - 1]!.x, road.points[i]!.y - road.points[i - 1]!.y)
  const elevation = (road.level ?? (road.role === 'expressway' ? 1 : 0)) * 6, total = chainage.at(-1) ?? 0
  return chainage.map(d => road.role === 'ramp' ? elevation * d / (total || 1) : elevation)
}

/** Centimetres of visible surfacing, not artificial metre-scale levitation.
 * Different pavement classes have a stable paint/depth order at junctions. */
export function roadSurfaceClearance(road: Road): number {
  return road.role === 'farm' ? .16 : road.role === 'expressway' ? .28 : road.role === 'ramp' ? .26 : road.kind === 'arterial' ? .24 : .20
}
