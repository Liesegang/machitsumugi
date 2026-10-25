import type { Point, Road } from './types'
import { controlledRoad } from './road-graph'

const key = (point: Point) => `${Math.round(point.x * 20)}:${Math.round(point.y * 20)}`
/** Certify actual centreline contacts at each opening date. Nearby pavement or
 * a future subdivision cannot stand in for an open public route to the region. */
export function certifyLayoutAccess(input: { width: number; height: number; roads: readonly Road[]; targets: readonly { id: string; point: Point; builtYear: number }[] }) {
  const unserved: string[] = []
  const byYear = new Map<number, Set<string>>()
  const years = [...new Set(input.targets.map(target => target.builtYear))]
  for (const year of years) {
    const edges = new Map<string, Set<string>>(), roots: string[] = []
    for (const road of input.roads) {
      if (controlledRoad(road) || (road.level ?? 0) !== 0 || (road.builtYear ?? 1650) > year) continue
      for (let i = 1; i < road.points.length; i++) {
        const a = key(road.points[i - 1]!), b = key(road.points[i]!)
        if (!edges.has(a)) edges.set(a, new Set()); if (!edges.has(b)) edges.set(b, new Set())
        edges.get(a)!.add(b); edges.get(b)!.add(a)
      }
      if (road.boundaryContinuation) for (const p of [road.points[0]!, road.points.at(-1)!]) if (p.x < 0 || p.y < 0 || p.x > input.width || p.y > input.height) roots.push(key(p))
    }
    const reached = new Set(roots), pending = [...roots]
    for (let i = 0; i < pending.length; i++) for (const next of edges.get(pending[i]!) ?? []) if (!reached.has(next)) { reached.add(next); pending.push(next) }
    byYear.set(year, reached)
  }
  for (const target of input.targets) if (!byYear.get(target.builtYear)?.has(key(target.point))) unserved.push(target.id)
  return { unserved, certified: input.targets.length - unserved.length }
}
