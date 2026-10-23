import type { Point } from './types'

interface SeaContourInput { width: number; height: number; step?: number; columns?: number; rows?: number; origin?: Point; elevation(p: Point): number; regionalOcean(p: Point): boolean }
export interface SeaPolygon { polygon: Point[]; holes: Point[][] }
const signedArea = (p: Point[]) => p.reduce((sum, a, i) => { const b = p[(i + 1) % p.length]!; return sum + a.x * b.y - b.x * a.y }, 0) / 2
function inside(p: Point, polygon: Point[]) {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i]!, b = polygon[j]!; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit }
  return hit
}
function simplify(path: Point[], tolerance: number): Point[] {
  if (path.length < 3) return path
  const a = path[0]!, b = path.at(-1)!, dx = b.x - a.x, dy = b.y - a.y
  let index = 0, maximum = tolerance
  for (let i = 1; i < path.length - 1; i++) { const p = path[i]!, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))), d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); if (d > maximum) { index = i; maximum = d } }
  return index ? [...simplify(path.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(path.slice(index), tolerance)] : [a, b]
}

/** Interpolated zero-isobath, with connectivity and island holes; no binary-cell outline smoothing. */
export function contourConnectedSea(input: SeaContourInput): SeaPolygon[] {
  const cols = input.columns ?? Math.ceil(input.width / (input.step ?? 12)), rows = input.rows ?? Math.ceil(input.height / (input.step ?? 12)), sx = input.width / cols, sy = input.height / rows, stride = cols + 1, origin = input.origin ?? { x: 0, y: 0 }
  const values = new Float32Array(stride * (rows + 1)), connected = new Uint8Array(values.length), queue = new Int32Array(values.length)
  let head = 0, tail = 0
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= cols; x++) {
    const i = y * stride + x, p = { x: origin.x + x * sx, y: origin.y + y * sy }
    values[i] = input.elevation(p)
    if ((!x || !y || x === cols || y === rows) && values[i]! < 0 && input.regionalOcean(p)) { connected[i] = 1; queue[tail++] = i }
  }
  while (head < tail) {
    const i = queue[head++]!, x = i % stride, y = Math.floor(i / stride)
    for (const j of [x ? i - 1 : -1, x < cols ? i + 1 : -1, y ? i - stride : -1, y < rows ? i + stride : -1]) if (j >= 0 && !connected[j] && values[j]! < 0) { connected[j] = 1; queue[tail++] = j }
  }
  // Disconnected below-sea-level depressions are inland basins, not painted sea.
  for (let i = 0; i < values.length; i++) if (values[i]! < 0 && !connected[i]) values[i] = Math.max(.001, -values[i]!)
  const vertices = new Map<string, Point>(), edges = new Map<string, string[]>(), used = new Set<string>()
  const add = (a: string, b: string) => { if (a === b) return; const left = edges.get(a) ?? [], right = edges.get(b) ?? []; left.push(b); right.push(a); edges.set(a, left); edges.set(b, right) }
  const node = (x: number, y: number) => { const key = `n${x}:${y}`; if (!vertices.has(key)) vertices.set(key, { x: origin.x + x * sx, y: origin.y + y * sy }); return key }
  const crossing = (x: number, y: number, horizontal: boolean) => {
    const key = `${horizontal ? 'h' : 'v'}${x}:${y}`
    if (!vertices.has(key)) {
      const i = y * stride + x, a = values[i]!, b = values[i + (horizontal ? 1 : stride)]!, t = a / (a - b)
      vertices.set(key, { x: origin.x + (x + (horizontal ? t : 0)) * sx, y: origin.y + (y + (horizontal ? 0 : t)) * sy })
    }
    return key
  }
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const i = y * stride + x, v = [values[i]!, values[i + 1]!, values[i + stride + 1]!, values[i + stride]!]
    const keys: (string | null)[] = [(v[0]! < 0) !== (v[1]! < 0) ? crossing(x, y, true) : null, (v[1]! < 0) !== (v[2]! < 0) ? crossing(x + 1, y, false) : null, (v[2]! < 0) !== (v[3]! < 0) ? crossing(x, y + 1, true) : null, (v[3]! < 0) !== (v[0]! < 0) ? crossing(x, y, false) : null]
    const found = keys.filter((k): k is string => k !== null)
    if (found.length === 2) add(found[0]!, found[1]!)
    else if (found.length === 4) {
      // Bilinear saddle/asymptotic decision, instead of a fixed diagonal bias.
      const denominator = v[0]! + v[2]! - v[1]! - v[3]!, saddle = denominator ? (v[0]! * v[2]! - v[1]! * v[3]!) / denominator : v.reduce((a, b) => a + b, 0) / 4
      if ((saddle < 0) === (v[0]! < 0)) { add(keys[0]!, keys[1]!); add(keys[2]!, keys[3]!) }
      else { add(keys[0]!, keys[3]!); add(keys[1]!, keys[2]!) }
    }
  }
  const border = (x: number, y: number, horizontal: boolean) => {
    const i = y * stride + x, j = i + (horizontal ? 1 : stride), a = values[i]! < 0, b = values[j]! < 0
    if (a && b) add(node(x, y), node(x + Number(horizontal), y + Number(!horizontal)))
    else if (a || b) add(a ? node(x, y) : node(x + Number(horizontal), y + Number(!horizontal)), crossing(x, y, horizontal))
  }
  for (let x = 0; x < cols; x++) { border(x, 0, true); border(x, rows, true) }
  for (let y = 0; y < rows; y++) { border(0, y, false); border(cols, y, false) }
  const loops: { polygon: Point[]; area: number; parent: number; depth: number }[] = []
  for (const [start, neighbors] of edges) for (const next of neighbors) {
    const key = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`
    if (used.has(key(start, next))) continue
    const polygon = [vertices.get(start)!]
    let previous = start, current = next
    for (let guard = 0; guard <= edges.size + 1; guard++) {
      used.add(key(previous, current))
      if (current === start) break
      polygon.push(vertices.get(current)!)
      const following = (edges.get(current) ?? []).find(n => n !== previous && !used.has(key(current, n)))
      if (!following) break
      previous = current; current = following
    }
    if (current !== start || polygon.length < 3 || Math.abs(signedArea(polygon)) < 100) continue
    const split = Math.floor(polygon.length / 2), reduced = [...simplify(polygon.slice(0, split + 1), 1.2).slice(0, -1), ...simplify([...polygon.slice(split), polygon[0]!], 1.2).slice(0, -1)]
    loops.push({ polygon: reduced, area: Math.abs(signedArea(reduced)), parent: -1, depth: 0 })
  }
  loops.sort((a, b) => b.area - a.area)
  for (let i = 0; i < loops.length; i++) for (let j = i - 1; j >= 0; j--) if (inside(loops[i]!.polygon[0]!, loops[j]!.polygon)) { loops[i]!.parent = j; loops[i]!.depth = loops[j]!.depth + 1; break }
  return loops.flatMap((loop, i) => loop.depth % 2 ? [] : [{ polygon: loop.polygon, holes: loops.filter(hole => hole.parent === i && hole.depth % 2 === 1).map(hole => hole.polygon) }])
}
