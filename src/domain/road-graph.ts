import type { Point, Road } from './types'

export type RoadRole = 'highway' | 'collector' | 'lane' | 'access' | 'bridge' | 'farm'
export interface SimulatedRoad extends Road { builtYear: number; role: RoadRole; reason: string; bridge?: boolean; phase: string; constructionCost: number }
export interface RoadMetadata { id: string; builtYear: number; role: RoadRole; reason: string; phase: string; width: number; kind: Road['kind']; constructionCost: number; bridge?: boolean; preserveEndpoint?: boolean }
export interface RoadProjection { point: Point; distance: number; road: SimulatedRoad; a: Point; b: Point; t: number }
/** Generalized modern travel speed in m/min; historical impedance is applied by year. */
export const roadTravelSpeed = (road: { role?: string; kind?: Road['kind'] }) => road.role === 'highway' || (!road.role && road.kind === 'arterial') ? 450 : road.role === 'collector' ? 330 : road.role === 'farm' ? 100 : 220
const key = (p: Point) => `${Math.round(p.x * 20)},${Math.round(p.y * 20)}`
export const roadLength = (points: Point[]) => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y), 0)
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const at = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
export function projectOnRoadSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return { point: at(a, b, t), t }
}
function intersect(a: Point, b: Point, c: Point, d: Point) {
  const x = b.x - a.x, y = b.y - a.y, u = d.x - c.x, v = d.y - c.y, det = x * v - y * u
  if (Math.abs(det) < 1e-8) return null
  const t = ((c.x - a.x) * v - (c.y - a.y) * u) / det, s = ((c.x - a.x) * y - (c.y - a.y) * x) / det
  return t >= -.00001 && t <= 1.00001 && s >= -.00001 && s <= 1.00001 ? { point: at(a, b, Math.max(0, Math.min(1, t))), t: Math.max(0, Math.min(1, t)) } : null
}
type Segment = { a: Point; b: Point; road: SimulatedRoad }

/** Mutable planar graph; inserting a junction only subdivides an existing immutable route. */
export class PlanarRoadGraph {
  readonly roads: SimulatedRoad[] = []
  private segments: Segment[] = []
  private buckets = new Map<string, Segment[]>()
  private revision = 0
  private routingRevision = -1
  private routing: { points: Point[]; nodes: Map<string, number>; adjacency: { to: number; time: number; length: number }[][] } | null = null
  private keys(a: Point, b: Point, pad = 0) {
    const keys: string[] = []
    for (let x = Math.floor((Math.min(a.x, b.x) - pad) / 100); x <= Math.floor((Math.max(a.x, b.x) + pad) / 100); x++) for (let y = Math.floor((Math.min(a.y, b.y) - pad) / 100); y <= Math.floor((Math.max(a.y, b.y) + pad) / 100); y++) keys.push(`${x}:${y}`)
    return keys
  }
  private nearby(a: Point, b: Point, pad = 0) {
    const found = new Set<Segment>()
    for (const k of this.keys(a, b, pad)) for (const s of this.buckets.get(k) ?? []) found.add(s)
    return found
  }
  nearest(p: Point, radius = Infinity): RoadProjection | null {
    const candidates = Number.isFinite(radius) ? this.nearby(p, p, radius) : this.segments
    let nearest: RoadProjection | null = null, best = radius
    for (const s of candidates) { const projection = projectOnRoadSegment(p, s.a, s.b), distance = dist(p, projection.point); if (distance > best) continue; best = distance; nearest = { ...projection, distance, road: s.road, a: s.a, b: s.b } }
    return nearest
  }
  projections(p: Point, radius: number, count = 12): RoadProjection[] {
    const candidates = Number.isFinite(radius) ? this.nearby(p, p, radius) : this.segments
    const hits: RoadProjection[] = []
    for (const s of candidates) {
      const projection = projectOnRoadSegment(p, s.a, s.b), distance = dist(p, projection.point)
      if (distance > radius) continue
      hits.push({ ...projection, distance, road: s.road, a: s.a, b: s.b })
    }
    hits.sort((a, b) => a.distance - b.distance || a.road.id.localeCompare(b.road.id))
    const selected: RoadProjection[] = []
    for (const hit of hits) {
      // A later street can close a loop against two distant points on the SAME old route.
      // Keeping only one projection per named road incorrectly forces tree growth.
      if (selected.some(other => dist(other.point, hit.point) < 65)) continue
      selected.push(hit); if (selected.length >= count) break
    }
    return selected
  }
  private insert(road: SimulatedRoad, point: Point) {
    if (road.points.some(p => dist(p, point) < .04)) return
    for (let i = 1; i < road.points.length; i++) {
      const projection = projectOnRoadSegment(point, road.points[i - 1]!, road.points[i]!)
      if (dist(point, projection.point) < .04 && projection.t > .00001 && projection.t < .99999) { road.points.splice(i, 0, point); return }
    }
  }
  /** Mark an exactly on-street transport entrance without shifting the old road. */
  ensureJunction(point: Point) {
    const near = this.nearest(point, 1e-7)
    if (!near) return false
    if (!near.road.points.some(p => dist(p, point) < 1e-7)) for (let i = 1; i < near.road.points.length; i++) if (dist(projectOnRoadSegment(point, near.road.points[i - 1]!, near.road.points[i]!).point, point) < 1e-7) { near.road.points.splice(i, 0, { ...point }); break }
    this.revision++; return true
  }
  /** All crossings are real shared vertices; a road may connect two older roads to close a loop. */
  add(path: Point[], metadata: RoadMetadata, requireConnection = true): SimulatedRoad | null {
    if (path.length < 2 || roadLength(path) < (metadata.preserveEndpoint ? 1e-7 : metadata.role === 'bridge' ? 4 : 20)) return null
    path = path.map(p => ({ ...p }))
    for (const i of [0, path.length - 1]) { if (i === path.length - 1 && metadata.preserveEndpoint) continue; const near = this.nearest(path[i]!, 1); if (near) path[i] = near.point }
    if (requireConnection && this.roads.length && !this.nearest(path[0]!, .15)) return null
    const normalized: Point[] = [path[0]!], junctions: { road: SimulatedRoad; point: Point }[] = []
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, hits: { point: Point; t: number }[] = []
      for (const s of this.nearby(a, b, .05)) {
        const cross = intersect(a, b, s.a, s.b)
        if (!cross) continue
        hits.push(cross); junctions.push({ road: s.road, point: cross.point })
      }
      hits.sort((x, y) => x.t - y.t)
      for (const hit of hits) if (dist(normalized.at(-1)!, hit.point) > .04) normalized.push(hit.point)
      if (dist(normalized.at(-1)!, b) > (metadata.preserveEndpoint && i === path.length - 1 ? 1e-8 : .04)) normalized.push(b)
    }
    if (normalized.length < 2) return null
    // An already existing corridor is maintenance, not a second newly built parallel street.
    let covered = 0, samples = 0
    for (let i = 1; i < normalized.length; i++) {
      const middle = at(normalized[i - 1]!, normalized[i]!, .5)
      samples++; if (this.nearest(middle, metadata.width * .5 + 2)) covered++
    }
    if (samples > 3 && covered / samples > .72) return null
    const road: SimulatedRoad = { id: metadata.id, points: normalized, kind: metadata.kind, width: metadata.width, builtYear: metadata.builtYear, role: metadata.role, phase: metadata.phase, reason: metadata.reason, constructionCost: metadata.constructionCost, ...(metadata.bridge ? { bridge: true } : {}) }
    for (const junction of junctions) this.insert(junction.road, junction.point)
    // Explicit endpoint snaps also split old curves even if the new path is tangent at the connection.
    for (const endpoint of [normalized[0]!, normalized.at(-1)!]) {
      const near = this.nearest(endpoint, .15)
      if (near) this.insert(near.road, endpoint)
    }
    this.roads.push(road)
    for (let i = 1; i < normalized.length; i++) {
      const segment = { a: normalized[i - 1]!, b: normalized[i]!, road }
      this.segments.push(segment)
      for (const k of this.keys(segment.a, segment.b)) { const bucket = this.buckets.get(k) ?? []; bucket.push(segment); this.buckets.set(k, bucket) }
    }
    this.revision++
    return road
  }
  private buildRouting() {
    if (this.routing && this.routingRevision === this.revision) return this.routing
    const membership = new Map<string, Set<string>>(), endpoints = new Set<string>()
    for (const road of this.roads) {
      endpoints.add(key(road.points[0]!)); endpoints.add(key(road.points.at(-1)!))
      for (const p of road.points) { const k = key(p), found = membership.get(k) ?? new Set<string>(); found.add(road.id); membership.set(k, found) }
    }
    const points: Point[] = [], nodes = new Map<string, number>(), adjacency: { to: number; time: number; length: number }[][] = []
    const node = (point: Point) => { const k = key(point); if (!nodes.has(k)) { nodes.set(k, points.length); points.push(point); adjacency.push([]) } return nodes.get(k)! }
    for (const road of this.roads) {
      let previous = node(road.points[0]!), length = 0
      const speed = roadTravelSpeed(road)
      for (let i = 1; i < road.points.length; i++) {
        const p = road.points[i]!, k = key(p); length += dist(road.points[i - 1]!, p)
        if (!endpoints.has(k) && (membership.get(k)?.size ?? 0) < 2) continue
        const next = node(p)
        if (next !== previous) { adjacency[previous]!.push({ to: next, time: length / speed, length }); adjacency[next]!.push({ to: previous, time: length / speed, length }) }
        previous = next; length = 0
      }
    }
    this.routingRevision = this.revision
    return this.routing = { points, nodes, adjacency }
  }
  /** Minutes over the street network; off-road access is walking at 75m/min. */
  accessibilityFrom(origin: Point): (point: Point) => number {
    const graph = this.buildRouting(), times = new Float64Array(graph.points.length).fill(Infinity)
    const checkpoints = new Map<SimulatedRoad, { point: Point; along: number; index: number }[]>()
    const positions = (near: RoadProjection) => {
      let along = 0, projectionAlong = 0
      for (let i = 1; i < near.road.points.length; i++) { const a = near.road.points[i - 1]!, b = near.road.points[i]!, n = dist(a, b); if (dist(projectOnRoadSegment(near.point, a, b).point, near.point) < .05) { projectionAlong = along + dist(a, near.point); break } along += n }
      let nodes = checkpoints.get(near.road)
      if (!nodes) {
        nodes = []; along = 0
        for (let i = 0; i < near.road.points.length; i++) { const p = near.road.points[i]!, index = graph.nodes.get(key(p)); if (index !== undefined) nodes.push({ point: p, along, index }); if (i + 1 < near.road.points.length) along += dist(p, near.road.points[i + 1]!) }
        checkpoints.set(near.road, nodes)
      }
      return { nodes, projectionAlong, speed: roadTravelSpeed(near.road) }
    }
    const originProjection = this.nearest(origin)
    if (!originProjection) return () => Infinity
    const source = positions(originProjection), heap = new MinHeap<number>()
    for (const node of source.nodes) { times[node.index] = Math.abs(node.along - source.projectionAlong) / source.speed + originProjection.distance / 75; heap.push(node.index, times[node.index]!) }
    while (heap.size) {
      const item = heap.pop()!, n = item.value
      if (item.priority > times[n]!) continue
      for (const edge of graph.adjacency[n]!) { const value = times[n]! + edge.time; if (value >= times[edge.to]!) continue; times[edge.to] = value; heap.push(edge.to, value) }
    }
    return (point: Point) => {
      const nearest = this.nearest(point, 450), nearby = nearest ? [nearest] : []
      let best = Infinity
      for (const near of nearby) {
        const road = positions(near)
        for (const node of road.nodes) best = Math.min(best, times[node.index]! + Math.abs(node.along - road.projectionAlong) / road.speed + near.distance / 75)
        if (near.road === originProjection.road) best = Math.min(best, originProjection.distance / 75 + Math.abs(road.projectionAlong - source.projectionAlong) / road.speed + near.distance / 75)
      }
      return best
    }
  }
  travelTime(a: Point, b: Point) {
    const graph = this.buildRouting(), from = this.nearest(a), to = this.nearest(b)
    if (!from || !to) return Infinity
    const checkpoints = (projection: RoadProjection) => {
      const points = projection.road.points, nodes: { index: number; along: number }[] = []
      let along = 0, at = 0
      for (let i = 0; i < points.length; i++) {
        const index = graph.nodes.get(key(points[i]!)); if (index !== undefined) nodes.push({ index, along })
        if (i + 1 < points.length) { const next = points[i + 1]!, hit = projectOnRoadSegment(projection.point, points[i]!, next); if (dist(hit.point, projection.point) < .05) at = along + dist(points[i]!, hit.point); along += dist(points[i]!, next) }
      }
      const speed = roadTravelSpeed(projection.road)
      return { nodes: nodes.map(node => ({ index: node.index, cost: Math.abs(node.along - at) / speed + projection.distance / 75 })), at, speed }
    }
    const source = checkpoints(from), destination = checkpoints(to), exits = new Map(destination.nodes.map(node => [node.index, node.cost]))
    let answer = from.road === to.road ? Math.abs(source.at - destination.at) / source.speed + (from.distance + to.distance) / 75 : Infinity
    const times = new Float64Array(graph.points.length).fill(Infinity), queue = new MinHeap<number>()
    for (const node of source.nodes) { times[node.index] = node.cost; queue.push(node.index, node.cost + dist(graph.points[node.index]!, b) / 450) }
    while (queue.size) {
      const next = queue.pop()!, node = next.value
      if (next.priority >= answer) break
      const exit = exits.get(node); if (exit !== undefined) answer = Math.min(answer, times[node]! + exit)
      for (const edge of graph.adjacency[node]!) { const time = times[node]! + edge.time; if (time >= times[edge.to]!) continue; times[edge.to] = time; queue.push(edge.to, time + dist(graph.points[edge.to]!, b) / 450) }
    }
    return answer
  }
}

export class MinHeap<T> {
  private items: { value: T; priority: number }[] = []
  get size() { return this.items.length }
  push(value: T, priority: number) { const item = { value, priority }; this.items.push(item); let i = this.items.length - 1; while (i) { const p = (i - 1) >> 1; if (this.items[p]!.priority <= priority) break; this.items[i] = this.items[p]!; i = p } this.items[i] = item }
  pop() { if (!this.items.length) return null; const first = this.items[0]!, last = this.items.pop()!; if (this.items.length) { let i = 0; while (i * 2 + 1 < this.items.length) { let c = i * 2 + 1; if (c + 1 < this.items.length && this.items[c + 1]!.priority < this.items[c]!.priority) c++; if (this.items[c]!.priority >= last.priority) break; this.items[i] = this.items[c]!; i = c } this.items[i] = last } return first }
}

/** Half-edge left-face walk of the actual normalized street graph, not a land tessellation. */
export function extractStreetBlocks(roads: Road[]): Point[][] {
  type Edge = { from: string; to: string; a: Point; b: Point; angle: number; reverse: Edge | null; used: boolean }
  const outgoing = new Map<string, Edge[]>(), edges: Edge[] = [], unique = new Set<string>()
  for (const road of roads) for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]!, b = road.points[i]!, ka = key(a), kb = key(b), pair = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
    if (ka === kb || unique.has(pair)) continue
    unique.add(pair)
    const forward: Edge = { from: ka, to: kb, a, b, angle: Math.atan2(b.y - a.y, b.x - a.x), reverse: null, used: false }
    const reverse: Edge = { from: kb, to: ka, a: b, b: a, angle: Math.atan2(a.y - b.y, a.x - b.x), reverse: forward, used: false }; forward.reverse = reverse
    for (const edge of [forward, reverse]) { const list = outgoing.get(edge.from) ?? []; list.push(edge); outgoing.set(edge.from, list); edges.push(edge) }
  }
  for (const list of outgoing.values()) list.sort((a, b) => a.angle - b.angle)
  const faces: Point[][] = []
  for (const first of edges) {
    if (first.used) continue
    let edge = first
    const polygon: Point[] = []
    for (let steps = 0; steps <= edges.length; steps++) {
      if (edge.used) break
      edge.used = true; polygon.push(edge.a)
      const options = outgoing.get(edge.to)!, reverseIndex = options.indexOf(edge.reverse!)
      edge = options[(reverseIndex + options.length - 1) % options.length]!
      if (edge === first) break
    }
    if (edge !== first || polygon.length < 3) continue
    // Remove dead-end excursions which retrace the same road within an otherwise closed face.
    let changed = true
    while (changed && polygon.length > 3) { changed = false; for (let i = 0; i < polygon.length; i++) if (key(polygon[(i + polygon.length - 1) % polygon.length]!) === key(polygon[(i + 1) % polygon.length]!)) { polygon.splice(i, 1); changed = true; break } }
    const area = polygon.reduce((sum, p, i) => sum + p.x * polygon[(i + 1) % polygon.length]!.y - polygon[(i + 1) % polygon.length]!.x * p.y, 0) / 2
    if (area > 150) faces.push(polygon)
  }
  return faces
}
