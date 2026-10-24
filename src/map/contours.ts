import type { Point, TerrainSurface } from '../domain/types'
export interface ContourLine { elevation: number; points: Point[]; index: boolean }
const cache = new WeakMap<TerrainSurface, Map<boolean, ContourLine[]>>()
/** Isolines interpolate the same saved DEM used by relief and the 3D mesh.
 * Ambiguous saddle cells use their centre elevation to select connectivity. */
export function terrainContours(surface: TerrainSurface, includeSubsea = false): ContourLine[] {
  let variants = cache.get(surface)
  if (!variants) { variants = new Map(); cache.set(surface, variants) }
  const cached = variants.get(includeSubsea)
  if (cached) return cached
  const { columns, rows, cellSize, elevations: z } = surface, lines: ContourLine[] = []
  let minimum = Infinity, maximum = -Infinity
  for (const value of z) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value) }
  const interval = maximum - minimum > 1500 ? 50 : maximum - minimum > 750 ? 20 : 10
  const levels = includeSubsea ? [-1000, -500, -200, -100, -50, -20, -10, -5].filter(h => h >= minimum && h <= maximum) : []
  for (let h = Math.max(interval, Math.ceil(minimum / interval) * interval); h <= maximum; h += interval) levels.push(h)
  for (const h of levels) {
    const edges: { a: Point; b: Point; used: boolean }[] = [], nodes = new Map<string, number[]>()
    const key = (p: Point) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`
    const add = (a: Point, b: Point) => {
      if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-7) return
      const id = edges.length; edges.push({ a, b, used: false })
      for (const p of [a, b]) { const k = key(p), group = nodes.get(k) ?? []; group.push(id); nodes.set(k, group) }
    }
    for (let y = 0; y < rows - 1; y++) for (let x = 0; x < columns - 1; x++) {
      const i = y * columns + x, values = [z[i]!, z[i + 1]!, z[i + columns + 1]!, z[i + columns]!]
      if (Math.min(...values) > h || Math.max(...values) < h) continue
      const corners = [{ x: x * cellSize, y: y * cellSize }, { x: (x + 1) * cellSize, y: y * cellSize }, { x: (x + 1) * cellSize, y: (y + 1) * cellSize }, { x: x * cellSize, y: (y + 1) * cellSize }]
      const hits: { edge: number; point: Point }[] = []
      for (let a = 0; a < 4; a++) {
        const b = (a + 1) % 4
        if ((values[a]! >= h) === (values[b]! >= h)) continue
        const t = (h - values[a]!) / (values[b]! - values[a]!), p = corners[a]!, q = corners[b]!
        hits.push({ edge: a, point: { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t } })
      }
      if (hits.length === 2) add(hits[0]!.point, hits[1]!.point)
      else if (hits.length === 4) {
        const centreHigh = values.reduce((a, b) => a + b, 0) / 4 >= h
        const firstHigh = values[0]! >= h
        const pairing = centreHigh === firstHigh ? [[0, 1], [2, 3]] : [[0, 3], [1, 2]]
        for (const [a, b] of pairing) add(hits[a!]!.point, hits[b!]!.point)
      }
    }
    const trace = (edgeId: number, start: Point) => {
      const points = [start]; let id: number | undefined = edgeId, p = start
      while (id !== undefined && !edges[id]!.used) {
        const edge = edges[id]!; edge.used = true
        const next = key(edge.a) === key(p) ? edge.b : edge.a
        points.push(next); p = next
        id = nodes.get(key(p))?.find(index => !edges[index]!.used)
      }
      if (points.length >= 2) lines.push({ elevation: h, index: h % (interval * 5) === 0, points })
    }
    for (const [k, ids] of nodes) if (ids.length === 1 && !edges[ids[0]!]!.used) { const edge = edges[ids[0]!]!; trace(ids[0]!, key(edge.a) === k ? edge.a : edge.b) }
    for (let i = 0; i < edges.length; i++) if (!edges[i]!.used) trace(i, edges[i]!.a)
  }
  variants.set(includeSubsea, lines)
  return lines
}
