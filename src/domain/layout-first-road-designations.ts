import type { Point, Road } from './types'
import { controlledRoad, MinHeap } from './road-graph'

const key = (point: Point) => `${Math.round(point.x * 20)}:${Math.round(point.y * 20)}`
const edgeKey = (a: Point, b: Point) => { const x = key(a), y = key(b); return x < y ? `${x}|${y}` : `${y}|${x}` }

/** A through-route designation follows actual connected, surveyed pavement.
 * Assigning a national-road colour does not invent or widen its cross-section. */
export function designateLayoutThroughRoads(roads: Road[], width: number, height: number): Road[] {
  const nodes = new Map<string, number>(), links: { to: number; cost: number; edge: string }[][] = [], exits = new Set<number>()
  const node = (p: Point) => { const k = key(p), existing = nodes.get(k); if (existing !== undefined) return existing; const id = links.length; nodes.set(k, id); links.push([]); return id }
  for (const road of roads) {
    if (controlledRoad(road) || (road.level ?? 0) !== 0 || road.width < 6.8) continue
    for (let i = 1; i < road.points.length; i++) {
      const p = road.points[i - 1]!, q = road.points[i]!, a = node(p), b = node(q), edge = edgeKey(p, q), cost = Math.hypot(q.x - p.x, q.y - p.y) * (road.role === 'lane' ? 1.25 : 1)
      links[a]!.push({ to: b, cost, edge }); links[b]!.push({ to: a, cost, edge })
    }
    if (road.boundaryContinuation) for (const p of [road.points[0]!, road.points.at(-1)!]) if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) exits.add(node(p))
  }
  if (exits.size < 2) return roads
  const start = exits.values().next().value!, costs = new Float64Array(links.length).fill(Infinity), parents = new Int32Array(links.length).fill(-1), edges: string[] = [], heap = new MinHeap<number>()
  costs[start] = 0; heap.push(start, 0)
  while (heap.size) {
    const current = heap.pop()!, at = current.value
    if (current.priority > costs[at]!) continue
    for (const link of links[at]!) { const cost = costs[at]! + link.cost; if (cost >= costs[link.to]!) continue; costs[link.to] = cost; parents[link.to] = at; edges[link.to] = link.edge; heap.push(link.to, cost) }
  }
  const designated = new Set<string>()
  for (const exit of exits) if (Number.isFinite(costs[exit]!)) for (let at = exit; parents[at]! >= 0; at = parents[at]!) designated.add(edges[at]!)
  return roads.flatMap(road => {
    const flags = road.points.slice(1).map((p, i) => road.kind === 'arterial' || designated.has(edgeKey(road.points[i]!, p)))
    if (flags.every(flag => !flag)) return [road]
    if (flags.every(Boolean)) return [{ ...road, kind: 'arterial' as const }]
    const pieces: Road[] = []; let start = 0
    for (let i = 1; i <= flags.length; i++) if (i === flags.length || flags[i] !== flags[start]) {
      const through = flags[start]!, points = road.points.slice(start, i + 1)
      pieces.push({ ...road, id: `${road.id}-${through ? 'through' : 'local'}-${pieces.length + 1}`, points, kind: through ? 'arterial' : 'local' }); start = i
    }
    return pieces
  })
}
