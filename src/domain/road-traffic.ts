import type { Point, Road } from './types'
import { controlledRoad, projectOnRoadSegment, roadLevelAt, roadTravelSpeed } from './road-graph'

export interface TrafficSite { point: Point; households: number; roadId?: string }
export interface TrafficDestination { point: Point; weight: number; activeYear?: number }
export interface RoadLoad { roadId: string; peakVehicles: number; capacity: number; ratio: number; freeMinutes: number; loadedMinutes: number; dailyVehicleMinutes: number }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** Scenario vehicles/hour in BOTH directions. A narrow access street is not a
 * two-lane collector. These deliberately explicit fiction-setting coefficients
 * are used consistently in assignment and investment, not empirical forecasts. */
export function roadTrafficCapacity(road: Pick<Road, 'width' | 'role'>) {
  if (road.role === 'expressway') return Math.max(1200, Math.floor(road.width / 3.5) * 1200)
  if (road.width < 5.5) return Math.max(60, (road.width - 2.5) * 120)
  return Math.max(360, (road.width - 2) * (road.role === 'highway' ? 150 : 120))
}
export const congestionMultiplier = (volume: number, capacity: number) => 1 + .15 * Math.min(6, Math.max(0, volume / capacity)) ** 4

class Queue {
  private values: { node: number; cost: number }[] = []
  push(node: number, cost: number) {
    let i = this.values.length; this.values.push({ node, cost })
    while (i) { const p = (i - 1) >> 1; if (this.values[p]!.cost <= cost) break; this.values[i] = this.values[p]!; i = p }
    this.values[i] = { node, cost }
  }
  pop() {
    const result = this.values[0], last = this.values.pop()
    if (!result || !last || !this.values.length) return result
    let i = 0
    while (i * 2 + 1 < this.values.length) { let c = i * 2 + 1; if (c + 1 < this.values.length && this.values[c + 1]!.cost < this.values[c]!.cost) c++; if (last.cost <= this.values[c]!.cost) break; this.values[i] = this.values[c]!; i = c }
    this.values[i] = last; return result
  }
}

/** Bounded static OD assignment. Real shared vertices and levels define the
 * network; no line intersection invents a crossing. Three successive-average
 * assignments feed capacity/junction delay back into path choice. This is a
 * strategic road-flow model, not a car-following or signal-cycle simulation. */
export function assignRoadTraffic(input: { roads: readonly Road[]; cells: TrafficSite[]; destinations: TrafficDestination[]; year: number }) {
  const roads = input.roads.slice(), coordinates: Point[] = [], keys = new Map<string, number>()
  const node = (p: Point, r: Road) => { const surface = !controlledRoad(r) || r.role === 'ramp' && distance(p, r.points[0]!) < .04; const k = `${roadLevelAt(r, p)}:${surface ? 'street' : 'controlled'}:${Math.round(p.x * 20)}:${Math.round(p.y * 20)}`; let n = keys.get(k); if (n === undefined) { n = coordinates.length; keys.set(k, n); coordinates.push(p) } return n }
  type Segment = { road: Road; a: Point; b: Point; length: number; anchors: { t: number; node: number }[]; pieces: { lo: number; hi: number; edge: number }[] }
  const segments: Segment[] = [], bins = new Map<string, Segment[]>(), surfaceRoads = new Map<string, Segment[]>()
  for (const road of roads) for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]!, b = road.points[i]!
    if (distance(a, b) < .001) continue
    const s: Segment = { road, a, b, length: distance(a, b), anchors: [{ t: 0, node: node(a, road) }, { t: 1, node: node(b, road) }], pieces: [] }; segments.push(s)
    if (!controlledRoad(road)) {
      const owned = surfaceRoads.get(road.id) ?? []; owned.push(s); surfaceRoads.set(road.id, owned)
      for (let x = Math.floor(Math.min(a.x, b.x) / 180); x <= Math.floor(Math.max(a.x, b.x) / 180); x++) for (let y = Math.floor(Math.min(a.y, b.y) / 180); y <= Math.floor(Math.max(a.y, b.y) / 180); y++) { const k = `${x}:${y}`, group = bins.get(k) ?? []; group.push(s); bins.set(k, group) }
    }
  }
  type Anchor = { node: number; distance: number; segment: Segment; t: number; point: Point }
  const nearest = (p: Point, split: boolean, roadId?: string) => {
    let best: Anchor | undefined
    const consider = (s: Segment) => {
      const q = projectOnRoadSegment(p, s.a, s.b), d = distance(p, q.point)
      if (roadLevelAt(s.road, q.point) !== 0) return
      if (!best || d < best.distance) best = { node: -1, distance: d, segment: s, ...q }
    }
    const found = new Set<Segment>(), gx = Math.floor(p.x / 180), gy = Math.floor(p.y / 180)
    if (roadId !== undefined) for (const s of surfaceRoads.get(roadId) ?? []) consider(s)
    else for (let ring = 0; ring <= 3; ring++) {
      for (let x = gx - ring; x <= gx + ring; x++) for (let y = gy - ring; y <= gy + ring; y++) for (const s of bins.get(`${x}:${y}`) ?? []) {
        if (found.has(s)) continue; found.add(s)
        consider(s)
      }
      // Search beyond the nearest cell too: its edge is not a distance bound.
      if (best && best.distance < Math.max(0, ring - 1) * 180) break
    }
    if (!best || best.distance > 500) return undefined
    if (split) { best.node = node(best.point, best.segment.road); best.segment.anchors.push({ t: best.t, node: best.node }) }
    return best
  }
  // A map-space centroid can fall across a river, rail corridor or disconnected
  // street and erase its necessary detour. Anchor every occupied site first,
  // then aggregate only 40m chainage bins on the SAME physical straight segment.
  // Their weighted chainage stays on that segment and is never snapped again.
  const origins: { point: Point; households: number; anchor?: Anchor }[] = []
  const originSegments = new Map<Segment, Map<number, { weightedT: number; households: number }>>()
  for (const site of input.cells) if (site.households > 0) {
    const anchor = nearest(site.point, false, site.roadId)
    if (!anchor) { origins.push({ point: { ...site.point }, households: site.households }); continue }
    const bins = originSegments.get(anchor.segment) ?? new Map<number, { weightedT: number; households: number }>()
    const k = Math.floor(anchor.t * anchor.segment.length / 40), group = bins.get(k) ?? { weightedT: 0, households: 0 }
    group.weightedT += anchor.t * site.households; group.households += site.households
    bins.set(k, group); originSegments.set(anchor.segment, bins)
  }
  for (const [segment, bins] of originSegments) for (const group of bins.values()) {
    const t = group.weightedT / group.households, point = { x: segment.a.x + (segment.b.x - segment.a.x) * t, y: segment.a.y + (segment.b.y - segment.a.y) * t }
    const anchor = { point, t, segment, distance: 0, node: node(point, segment.road) }
    segment.anchors.push({ t, node: anchor.node }); origins.push({ point, households: group.households, anchor })
  }
  // A destination without physical access still attracts unmet demand. Dropping
  // it here would silently reallocate its trips, or report zero demand when all
  // destinations are inaccessible.
  const destinations = input.destinations.filter(d => (d.activeYear ?? 0) <= input.year && d.weight > 0).map(d => ({ ...d, anchor: nearest(d.point, true) }))
  type Edge = { a: number; b: number; road: Road; length: number; free: number; capacity: number; volume: number; time: number; junction: number }
  const edges: Edge[] = [], adjacency: { to: number; edge: number }[][] = coordinates.map(() => []), incident = coordinates.map(() => new Set<string>())
  const canonical = new Map<string, number>()
  for (const s of segments) {
    s.anchors.sort((a, b) => a.t - b.t)
    for (let i = 1; i < s.anchors.length; i++) {
      const a = s.anchors[i - 1]!, b = s.anchors[i]!, length = distance(s.a, s.b) * (b.t - a.t)
      if (a.node === b.node || length < .001) continue
      const key = `${Math.min(a.node, b.node)}:${Math.max(a.node, b.node)}`
      const existing = canonical.get(key)
      if (existing !== undefined) { s.pieces.push({ lo: a.t, hi: b.t, edge: existing }); continue }
      const free = length / roadTravelSpeed(s.road), e = edges.length
      canonical.set(key, e); s.pieces.push({ lo: a.t, hi: b.t, edge: e })
      edges.push({ a: a.node, b: b.node, road: s.road, length, free, capacity: roadTrafficCapacity(s.road), volume: 0, time: free, junction: 0 })
      adjacency[a.node]!.push({ to: b.node, edge: e }); adjacency[b.node]!.push({ to: a.node, edge: e }); incident[a.node]!.add(s.road.id); incident[b.node]!.add(s.road.id)
    }
  }
  // Virtual origin vertices and polyline bends have no junction penalty.
  const delays = adjacency.map((arms, i) => incident[i]!.size > 1 && arms.length >= 3 ? Math.min(.2, (arms.length - 2) * .045) : 0)
  for (const e of edges) e.junction = controlledRoad(e.road) ? 0 : (delays[e.a]! + delays[e.b]!) / 2
  const shortest = (goal: number) => {
    const costs = new Float64Array(coordinates.length).fill(Infinity), previous = new Int32Array(coordinates.length).fill(-1), queue = new Queue(); costs[goal] = 0; queue.push(goal, 0)
    for (let item = queue.pop(); item; item = queue.pop()) {
      if (item.cost !== costs[item.node]) continue
      for (const a of adjacency[item.node]!) { const cost = item.cost + edges[a.edge]!.time; if (cost < costs[a.to]!) { costs[a.to] = cost; previous[a.to] = a.edge; queue.push(a.to, cost) } }
    }
    return { costs, previous }
  }
  const motorTrips = input.year < 1970 ? .24 : .36, peakShare = .1
  const ods = origins.map(o => {
    const weights = destinations.map(d => d.weight * Math.exp(-distance(o.point, d.point) / 1800)), total = weights.reduce((s, w) => s + w, 0)
    return destinations.map((d, i) => ({ from: o.anchor?.node, to: d.anchor?.node, peak: total ? o.households * motorTrips * weights[i]! / total : 0 }))
  }).flat()
  let unserved = 0
  for (let pass = 0; pass < 3; pass++) {
    for (const e of edges) e.time = (e.free + e.junction) * congestionMultiplier(e.volume, e.capacity)
    const routes = new Map<number, ReturnType<typeof shortest>>(), assigned = new Float64Array(edges.length); unserved = 0
    for (const od of ods) {
      if (od.from === undefined || od.to === undefined) { unserved += od.peak; continue }
      let route = routes.get(od.to); if (!route) { route = shortest(od.to); routes.set(od.to, route) }
      if (!Number.isFinite(route.costs[od.from])) { unserved += od.peak; continue }
      let n = od.from
      while (n !== od.to) { const id = route.previous[n]!; if (id < 0) break; const e = edges[id]!; assigned[id]! += od.peak; n = e.a === n ? e.b : e.a }
    }
    for (const [i, e] of edges.entries()) e.volume = (e.volume * pass + assigned[i]!) / (pass + 1)
  }
  const loads = new Map<string, RoadLoad>()
  for (const e of edges) {
    e.time = (e.free + e.junction) * congestionMultiplier(e.volume, e.capacity)
    const r = loads.get(e.road.id) ?? { roadId: e.road.id, peakVehicles: 0, capacity: e.capacity, ratio: 0, freeMinutes: 0, loadedMinutes: 0, dailyVehicleMinutes: 0 }
    r.peakVehicles = Math.max(r.peakVehicles, e.volume); r.ratio = Math.max(r.ratio, e.volume / e.capacity); r.freeMinutes += e.free + e.junction; r.loadedMinutes += e.time; r.dailyVehicleMinutes += e.time * e.volume / peakShare; loads.set(e.road.id, r)
  }
  const queries = new Map<number, ReturnType<typeof shortest>>()
  const segmentTime = (s: Segment, a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b)
    return s.pieces.reduce((sum, p) => sum + Math.max(0, Math.min(hi, p.hi) - Math.max(lo, p.lo)) / (p.hi - p.lo) * edges[p.edge]!.time, 0)
  }
  const travelTime = (a: Point, b: Point) => {
    const first = nearest(a, false), last = nearest(b, false)
    if (!first || !last) return Infinity
    let best = first.segment === last.segment ? segmentTime(first.segment, first.t, last.t) : Infinity
    // Only the adjacent split vertices are needed. Every farther vertex is
    // already reachable through one of these same loaded edges.
    const bracket = (s: Segment, t: number) => {
      const i = s.anchors.findIndex(p => p.t >= t - 1e-10)
      if (i < 0) return [s.anchors.at(-1)!]
      if (Math.abs(s.anchors[i]!.t - t) < 1e-10 || i === 0) return [s.anchors[i]!]
      return [s.anchors[i - 1]!, s.anchors[i]!]
    }
    for (const end of bracket(last.segment, last.t)) {
      let route = queries.get(end.node); if (!route) { route = shortest(end.node); if (queries.size >= 64) queries.delete(queries.keys().next().value!); queries.set(end.node, route) }
      for (const start of bracket(first.segment, first.t)) best = Math.min(best, route.costs[start.node]! + segmentTime(first.segment, first.t, start.t) + segmentTime(last.segment, last.t, end.t))
    }
    return best + (first.distance + last.distance) / 75
  }
  // Hold the assigned flows fixed and appraise only their actual occupied edge
  // lengths. A road's peak flow cannot be applied to its unloaded tail.
  const upgradeDailyVehicleMinutes = (roadId: string, width: number, role: Road['role']) => {
    if (!Number.isFinite(width) || width <= 0) return 0
    const proposed = { width, role }, speed = roadTravelSpeed(proposed), capacity = roadTrafficCapacity(proposed)
    return edges.reduce((sum, edge) => edge.road.id !== roadId ? sum : sum + Math.max(0, edge.time - (edge.length / speed + edge.junction) * congestionMultiplier(edge.volume, capacity)) * edge.volume / peakShare, 0)
  }
  return { loads, travelTime, origins: origins.length, destinations: destinations.length, totalPeakTrips: ods.reduce((s, od) => s + od.peak, 0), unservedPeakTrips: unserved,
    upgradeDailyVehicleMinutes, totalDailyVehicleMinutes: edges.reduce((s, e) => s + e.time * e.volume / peakShare, 0) }
}
