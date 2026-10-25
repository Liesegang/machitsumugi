import type { Point, Road, TimelineVersion } from './types'
import { controlledRoad, MinHeap } from './road-graph'

const key = (point: Point) => `${Math.round(point.x * 1000000)}:${Math.round(point.y * 1000000)}`
const edgeKey = (a: Point, b: Point) => { const x = key(a), y = key(b); return x < y ? `${x}|${y}` : `${y}|${x}` }
const routeEdgeKey = (road: Road, a: Point, b: Point) => `${road.throughRouteId ?? ''}:${edgeKey(a, b)}`
const classify = (road: Road, through: boolean): Road => through ? { ...road, kind: 'arterial' } : { ...road, kind: 'local', ...(road.role === 'highway' ? { role: 'collector', reason: road.boundaryContinuation ? '地区から周辺地域へ続く道路' : '地区内を結ぶ広幅員道路' } : {}) }

/** A through-route designation follows actual connected, surveyed pavement.
 * Assigning a national-road colour does not invent or widen its cross-section. */
export function designateLayoutThroughRoads(roads: Road[], width: number, height: number): Road[] {
  const nodes = new Map<string, number>(), links: { to: number; cost: number; edge: string }[][] = [], exits = new Map<number, string>()
  const node = (p: Point, routeId: string) => { const k = `${routeId}:${key(p)}`, existing = nodes.get(k); if (existing !== undefined) return existing; const id = links.length; nodes.set(k, id); links.push([]); return id }
  const publicGround = (road: Road) => !controlledRoad(road) && (road.level ?? 0) === 0
  const boundarySide = (point: Point) => {
    const candidates = [{ side: 'west', beyond: -point.x }, { side: 'east', beyond: point.x - width }, { side: 'north', beyond: -point.y }, { side: 'south', beyond: point.y - height }]
    return candidates.filter(value => value.beyond > 0).sort((a, b) => b.beyond - a.beyond)[0]?.side
  }
  for (const road of roads) {
    if (!road.throughRouteId || controlledRoad(road) || (road.level ?? 0) !== 0 || road.width < 6.8) continue
    for (let i = 1; i < road.points.length; i++) {
      const p = road.points[i - 1]!, q = road.points[i]!, a = node(p, road.throughRouteId), b = node(q, road.throughRouteId), edge = routeEdgeKey(road, p, q), cost = Math.hypot(q.x - p.x, q.y - p.y)
      links[a]!.push({ to: b, cost, edge }); links[b]!.push({ to: a, cost, edge })
    }
    if (road.boundaryContinuation) for (const p of [road.points[0]!, road.points.at(-1)!]) { const side = boundarySide(p); if (side) exits.set(node(p, road.throughRouteId), side) }
  }
  const designated = new Set<string>()
  const visited = new Set<number>()
  for (const start of exits.keys()) {
    if (visited.has(start)) continue
    const costs = new Float64Array(links.length).fill(Infinity), parents = new Int32Array(links.length).fill(-1), edges: string[] = [], heap = new MinHeap<number>()
    costs[start] = 0; heap.push(start, 0)
    while (heap.size) {
      const current = heap.pop()!, at = current.value
      if (current.priority > costs[at]!) continue
      visited.add(at)
      for (const link of links[at]!) { const cost = costs[at]! + link.cost; if (cost >= costs[link.to]!) continue; costs[link.to] = cost; parents[link.to] = at; edges[link.to] = link.edge; heap.push(link.to, cost) }
    }
    // Two nearby continuations on the same crop edge do not establish a
    // through route. A disconnected component is assessed independently.
    for (const [exit, side] of exits) if (side !== exits.get(start) && Number.isFinite(costs[exit]!)) for (let at = exit; parents[at]! >= 0; at = parents[at]!) designated.add(edges[at]!)
  }
  return roads.flatMap(road => {
    if (!publicGround(road)) return [road]
    const flags = road.points.slice(1).map((p, i) => !!road.throughRouteId && designated.has(routeEdgeKey(road, road.points[i]!, p)))
    if (flags.every(flag => !flag)) return [road.kind === 'arterial' || road.role === 'highway' ? classify(road, false) : road]
    if (flags.every(Boolean)) return [classify(road, true)]
    const pieces: Road[] = []; let start = 0
    for (let i = 1; i <= flags.length; i++) if (i === flags.length || flags[i] !== flags[start]) {
      const through = flags[start]!, points = road.points.slice(start, i + 1)
      pieces.push(classify({ ...road, id: `${road.id}-${through ? 'through' : 'local'}-${pieces.length + 1}`, points }, through)); start = i
    }
    return pieces
  })
}

/** Reclassify the same surveyed pavement only when a road actually opens.
 * Stable physical pieces span all designation phases; a later connection can
 * update their kind, never manufacture another construction/opening event. */
export function layoutThroughRoadHistory(roads: readonly Road[], width: number, height: number, throughYear = 2025): TimelineVersion<Road>[] {
  const phases = [...new Set(roads.map(road => road.builtYear ?? 1650).filter(year => year <= throughYear))].sort((a, b) => a - b)
  const atPhase = new Map<number, Set<string>>()
  for (const phase of phases) {
    const through = new Set<string>()
    for (const road of designateLayoutThroughRoads(roads.filter(road => (road.builtYear ?? 1650) <= phase), width, height)) if (road.kind === 'arterial' && !controlledRoad(road) && (road.level ?? 0) === 0) {
      for (let i = 1; i < road.points.length; i++) through.add(routeEdgeKey(road, road.points[i - 1]!, road.points[i]!))
    }
    atPhase.set(phase, through)
  }
  const result: TimelineVersion<Road>[] = []
  for (const road of roads) {
    const opening = road.builtYear ?? 1650, activePhases = phases.filter(phase => phase >= opening), count = road.points.length - 1
    if (!activePhases.length || count < 1) continue
    if (controlledRoad(road) || (road.level ?? 0) !== 0) { result.push({ from: opening, value: road }); continue }
    const flags = activePhases.map(phase => road.points.slice(1).map((point, i) => !!road.throughRouteId && atPhase.get(phase)!.has(routeEdgeKey(road, road.points[i]!, point))))
    const cuts = [0]
    for (let i = 1; i < count; i++) if (flags.some(values => values[i] !== values[i - 1])) cuts.push(i)
    cuts.push(count)
    for (let piece = 1; piece < cuts.length; piece++) {
      const start = cuts[piece - 1]!, end = cuts[piece]!, id = cuts.length === 2 ? road.id : `${road.id}-designation-${piece}`
      const physical = { ...road, id, points: road.points.slice(start, end + 1) }
      let current: TimelineVersion<Road> | undefined
      for (const [index, phase] of activePhases.entries()) {
        const value = classify(physical, flags[index]![start]!)
        if (current?.value.kind === value.kind && current.value.role === value.role) continue
        if (current) current.to = phase
        current = { from: phase, value: { ...value, ...(current ? { modifiedYear: phase, reason: '開通済み道路の接続に応じて通過道路の指定を更新' } : {}) } }
        result.push(current)
      }
    }
  }
  return result
}
