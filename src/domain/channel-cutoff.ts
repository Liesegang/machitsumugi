import type { Point } from './types'

export interface NeckCutoff { first: number; last: number; separation: number; oldLength: number }
export interface AbandonedChannel { points: Point[]; widths: number[]; formedAtStep: number; neck: [Point, Point] }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** Bank contact, not an independently placed crescent-shaped lake. All river
 * junctions inside a loop forbid its cutoff until their topology is resolved. */
export function findNeckCutoff(input: { points: Point[]; widths: number[]; pinned: number[]; elevation(p: Point): number; alluvium(p: Point): number }): NeckCutoff | null {
  const along = [0], cells = new Map<string, number[]>(), cellSize = Math.max(20, ...input.widths)
  for (let i = 1; i < input.points.length; i++) along.push(along.at(-1)! + distance(input.points[i - 1]!, input.points[i]!))
  let best: NeckCutoff | null = null
  for (const [i, point] of input.points.entries()) {
    const x = Math.floor(point.x / cellSize), y = Math.floor(point.y / cellSize)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of cells.get(`${x + dx},${y + dy}`) ?? []) {
      const other = input.points[j]!, width = (input.widths[i]! + input.widths[j]!) / 2, oldLength = along[i]! - along[j]!, separation = distance(point, other)
      if (width < 8 || oldLength < width * 8 || separation > width * .95 || input.pinned.some(index => index > j && index < i)) continue
      if (input.alluvium(point) < 1 || input.alluvium(other) < 1 || Math.abs(input.elevation(point) - input.elevation(other)) / oldLength > .005) continue
      const level = Math.max(input.elevation(point), input.elevation(other)), softThickness = Math.min(input.alluvium(point), input.alluvium(other))
      const steps = Math.max(1, Math.ceil(separation / 5))
      if (Array.from({ length: steps + 1 }, (_, k) => ({ x: other.x + (point.x - other.x) * k / steps, y: other.y + (point.y - other.y) * k / steps })).some(p => input.elevation(p) > level + softThickness)) continue
      if (!best || separation / width < best.separation / ((input.widths[best.first]! + input.widths[best.last]!) / 2)) best = { first: j, last: i, separation, oldLength }
    }
    const key = `${x},${y}`, bucket = cells.get(key) ?? []
    bucket.push(i); cells.set(key, bucket)
  }
  return best
}

export function severChannelNeck(points: Point[], widths: number[], pinned: number[], neck: NeckCutoff, formedAtStep: number) {
  const a = points[neck.first]!, b = points[neck.last]!, dx = b.x - a.x, dy = b.y - a.y
  const awayFromNeck = (p: Point, width: number) => {
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) > width * 1.35
  }
  let first = neck.first + 1, last = neck.last - 1
  while (first < last && !awayFromNeck(points[first]!, widths[first]!)) first++
  while (last > first && !awayFromNeck(points[last]!, widths[last]!)) last--
  const abandoned: AbandonedChannel | null = last - first >= 3 ? { points: points.slice(first, last + 1).map(p => ({ ...p })), widths: widths.slice(first, last + 1).map((w, i, array) => w * .65 * Math.min(1, (i + 1) / 3, (array.length - i) / 3)), formedAtStep, neck: [{ ...a }, { ...b }] } : null
  const kept = [...points.slice(0, neck.first + 1), ...points.slice(neck.last)]
  const keptWidths = [...widths.slice(0, neck.first + 1), ...widths.slice(neck.last)]
  const removed = neck.last - neck.first - 1
  return { points: kept, widths: keptWidths, pinned: pinned.map(index => index >= neck.last ? index - removed : index), abandoned }
}
