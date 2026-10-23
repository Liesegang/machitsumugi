import type { Area, Point, Road } from './types'
import type { RailwayPlan, RailwayStructure } from './railway-planner'
import { railwayRoadCost } from './railway-road-cost.ts'

export interface RailBranchInput {
  width: number; height: number
  terrain: { areas: Area[]; elevation(p: Point): number; waterAt(p: Point): boolean }
  core?: Point[] | null
  /** Existing tracks remain obstacles after the shared turnout approach. */
  avoidTracks?: Point[][]
  start: { point: Point; heading: number; elevation: number; grade?: number; curvature?: number }
  goal: Point
  maxNodes?: number
  inheritedRoads?: Road[]
}
export interface RailwayBranchPlan extends RailwayPlan { constructionCost: number; length: number; junction: RailBranchInput['start'] }
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y)
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const turn = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
function inside(p: Point, polygon: Point[]) {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}
function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y, t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1)
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy })
}
type Node = { point: Point; heading: number; curvature: number; lower: number; upper: number; wetRun: number; cost: number; length: number; parent: number; arc: Point[]; priority: number }

/** A bounded curvature-state search, not a decorative bend applied after planning.
 * Each 60m edge linearly changes curvature (Euler-spiral approximation sampled at
 * 5m); grade-feasible height intervals propagate along every edge. A final exact
 * profile retains the parent track's elevation and its first 60m vertical tangent.
 * These are fictional regional-rail assumptions, not a surveyed engineering design. */
export function planRailBranch(input: RailBranchInput): RailwayBranchPlan | null {
  const streetCost = railwayRoadCost(input.inheritedRoads ?? [])
  const grade = input.start.grade ?? 0, startCurvature = input.start.curvature ?? 0
  if (Math.abs(grade) > .035 || Math.abs(startCurvature) > .005 || distance(input.start.point, input.goal) < 350) return null
  const occupied = (p: Point, area: Area) => inside(p, area.polygon) && !area.holes?.some(hole => inside(p, hole))
  const seas = input.terrain.areas.filter(a => a.kind === 'water' && a.id.startsWith('sea'))
  const reserves = input.terrain.areas.filter(a => a.id === 'historic-core' || a.id.startsWith('moat-'))
  const forests = input.terrain.areas.filter(a => a.kind === 'forest'), fieldCache = new Map<string, { ground: number; wet: boolean; forest: boolean; blocked: boolean }>()
  const field = (p: Point, exact = false) => {
    const key = `${Math.round(p.x / 5)},${Math.round(p.y / 5)}`
    const previous = exact ? undefined : fieldCache.get(key)
    if (previous) return previous
    const core = input.core, trackCollision = distance(p, input.start.point) > 200 && input.avoidTracks?.some(track => track.slice(1).some((b, i) => segmentDistance(p, track[i]!, b) < 12))
    const blocked = p.x < 12 || p.y < 12 || p.x > input.width - 12 || p.y > input.height - 12 || seas.some(a => occupied(p, a)) || reserves.some(a => occupied(p, a)) || !!trackCollision || !!core && (inside(p, core) || core.some((a, i) => segmentDistance(p, a, core[(i + 1) % core.length]!) < 18))
    const value = { ground: input.terrain.elevation(p), wet: input.terrain.waterAt(p), forest: forests.some(a => occupied(p, a)), blocked }
    if (!exact) fieldCache.set(key, value)
    return value
  }
  const first = field(input.start.point, true)
  if (first.blocked || first.wet || Math.abs(input.start.elevation - first.ground) > 12) return null
  const nodes: Node[] = [], heap: number[] = [], best = new Map<string, number>()
  const keyOf = (node: Node) => `${Math.round(node.point.x / 22)},${Math.round(node.point.y / 22)},${Math.round(turn(node.heading) * 36 / Math.PI)},${Math.round(node.curvature * 1000)},${Math.round(node.lower / 2)},${Math.round(node.upper / 2)}`
  const push = (node: Node) => {
    const id = nodes.length; nodes.push(node); heap.push(id)
    let child = heap.length - 1
    while (child) { const parent = Math.floor((child - 1) / 2); if (nodes[heap[parent]!]!.priority <= node.priority) break; heap[child] = heap[parent]!; child = parent }
    heap[child] = id
  }
  const pop = () => {
    const first = heap[0]!, last = heap.pop()!
    if (heap.length) {
      let parent = 0
      while (parent * 2 + 1 < heap.length) {
        let child = parent * 2 + 1
        if (child + 1 < heap.length && nodes[heap[child + 1]!]!.priority < nodes[heap[child]!]!.priority) child++
        if (nodes[last]!.priority <= nodes[heap[child]!]!.priority) break
        heap[parent] = heap[child]!; parent = child
      }
      heap[parent] = last
    }
    return first
  }
  const direct = distance(input.start.point, input.goal), maxLength = direct * 2.3 + 600
  push({ point: input.start.point, heading: input.start.heading, curvature: startCurvature, lower: input.start.elevation, upper: input.start.elevation, wetRun: 0, cost: 0, length: 0, parent: -1, arc: [input.start.point], priority: direct * 2 })
  best.set(keyOf(nodes[0]!), 0)
  const reconstruct = (id: number) => {
    const arcs: Point[][] = []
    while (id >= 0) { arcs.push(nodes[id]!.arc); id = nodes[id]!.parent }
    return arcs.reverse().flatMap((arc, i) => i ? arc.slice(1) : arc)
  }
  let visits = 0
  while (heap.length && visits++ < (input.maxNodes ?? 18_000)) {
    const id = pop(), node = nodes[id]!
    if (node.cost > (best.get(keyOf(node)) ?? Infinity) + 1e-6) continue
    if (node.length >= 400 && distance(node.point, input.goal) < 90 && Math.abs(node.curvature) < 1e-8 && !field(node.point).wet) {
      const result = validateBranch(reconstruct(id), input, field, node.cost)
      if (result) return result
    }
    for (const change of [-1, 0, 1]) {
      const targetCurvature = clamp(Math.round(node.curvature * 1000 + change) / 1000, -.005, .005)
      if (change && targetCurvature === node.curvature) continue
      let p = node.point, heading = node.heading, lower = node.lower, upper = node.upper, wetRun = node.wetRun, cost = node.cost, invalid = false
      const arc: Point[] = [p]
      for (let sample = 0; sample < 12; sample++) {
        const k = node.curvature + (targetCurvature - node.curvature) * (sample + .5) / 12, mid = heading + k * 2.5
        const previousPoint = p
        p = { x: p.x + Math.cos(mid) * 5, y: p.y + Math.sin(mid) * 5 }; heading += k * 5
        const f = field(p), along = node.length + (sample + 1) * 5
        const bottom = along <= 60 ? input.start.elevation + grade * along : f.ground + (f.wet ? 4.2 : -11)
        const top = along <= 60 ? bottom : f.ground + (f.wet ? 17 : 11)
        lower = Math.max(bottom, lower - .035 * 5); upper = Math.min(top, upper + .035 * 5)
        wetRun = f.wet ? wetRun + 5 : 0
        if (f.blocked || lower > upper + 1e-8 || wetRun > 160 || along > maxLength) { invalid = true; break }
        const earthwork = clamp(f.ground, lower, upper) - f.ground
        cost += 5 * (1 + (f.forest ? .6 : 0) + (f.wet ? 5 : 0) + earthwork * earthwork * .018 + k * k * 16000 + streetCost.pointCost(p)) + streetCost.edgeCost(previousPoint, p)
        arc.push(p)
      }
      if (invalid) continue
      // Weighted A* bounds work in an interactive generator. It returns a valid
      // affordable corridor, not a proof of the global construction-cost minimum.
      const next = { point: p, heading: turn(heading), curvature: targetCurvature, lower, upper, wetRun, cost, length: node.length + 60, parent: id, arc, priority: cost + distance(p, input.goal) * 2 }
      const key = keyOf(next)
      if (cost >= (best.get(key) ?? Infinity)) continue
      best.set(key, cost); push(next)
    }
  }
  return null
}

function validateBranch(points: Point[], input: RailBranchInput, field: (p: Point, exact?: boolean) => { ground: number; wet: boolean; blocked: boolean }, constructionCost: number): RailwayBranchPlan | null {
  // A bounded search is not permission to form a railway loop crossing itself.
  // Nonadjacent segment intersections have no surveyed junction or overpass.
  for (let i = 1; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
    const a = points[i - 1]!, b = points[i]!, c = points[j - 1]!, d = points[j]!
    if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) continue
    const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y, determinant = dx * ey - dy * ex
    if (Math.abs(determinant) < 1e-9) continue
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / determinant, u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / determinant
    if (t > 0 && t < 1 && u > 0 && u < 1) return null
  }
  const samples = points.map(p => field(p, true)), lengths = [0]
  for (let i = 1; i < points.length; i++) lengths.push(lengths.at(-1)! + distance(points[i - 1]!, points[i]!))
  const lower = samples.map((f, i) => i === 0 ? input.start.elevation : f.ground + (f.wet ? 4.2 : -11)), upper = samples.map((f, i) => i === 0 ? input.start.elevation : f.ground + (f.wet ? 17 : 11))
  for (let i = 1; i < points.length; i++) {
    if (lengths[i]! <= 60.001) lower[i] = upper[i] = input.start.elevation + (input.start.grade ?? 0) * lengths[i]!
    const change = (lengths[i]! - lengths[i - 1]!) * .035
    lower[i] = Math.max(lower[i]!, lower[i - 1]! - change); upper[i] = Math.min(upper[i]!, upper[i - 1]! + change)
    if (samples[i]!.blocked || lower[i]! > upper[i]! + 1e-8) return null
  }
  const elevations = new Array<number>(points.length)
  elevations[elevations.length - 1] = clamp(samples.at(-1)!.ground, lower.at(-1)!, upper.at(-1)!)
  for (let i = points.length - 2; i >= 0; i--) { const delta = (lengths[i + 1]! - lengths[i]!) * .035; elevations[i] = clamp(samples[i]!.ground, Math.max(lower[i]!, elevations[i + 1]! - delta), Math.min(upper[i]!, elevations[i + 1]! + delta)) }
  for (let pass = 0; pass < 4; pass++) for (let i = 1; i < points.length - 1; i++) {
    if (lengths[i]! <= 60.001) continue
    const before = (lengths[i]! - lengths[i - 1]!) * .035, after = (lengths[i + 1]! - lengths[i]!) * .035
    const lo = Math.max(lower[i]!, elevations[i - 1]! - before, elevations[i + 1]! - after), hi = Math.min(upper[i]!, elevations[i - 1]! + before, elevations[i + 1]! + after)
    elevations[i] = clamp((elevations[i - 1]! + elevations[i]! * 2 + elevations[i + 1]!) / 4, lo, hi)
  }
  let maxGroundGrade = 0, maxTrackGrade = 0, maxCurvature = 0, maxEarthwork = 0, bridgeLength = 0, maxBridgeLength = 0
  for (let i = 0; i < points.length; i++) {
    const f = samples[i]!, p = points[i]!, earthwork = elevations[i]! - f.ground
    if (f.blocked || (f.wet ? earthwork < 3 : Math.abs(earthwork) > 12)) return null
    if (!f.wet) maxEarthwork = Math.max(maxEarthwork, Math.abs(earthwork))
    const angle = i ? Math.atan2(p.y - points[i - 1]!.y, p.x - points[i - 1]!.x) : input.start.heading
    for (const side of [-5, 5]) if (field({ x: p.x - Math.sin(angle) * side, y: p.y + Math.cos(angle) * side }, true).blocked) return null
    if (i) { const d = lengths[i]! - lengths[i - 1]!; maxGroundGrade = Math.max(maxGroundGrade, Math.abs(f.ground - samples[i - 1]!.ground) / d); maxTrackGrade = Math.max(maxTrackGrade, Math.abs(elevations[i]! - elevations[i - 1]!) / d) }
    if (i && i + 1 < points.length) { const a = points[i - 1]!, b = points[i + 1]!, cross = Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)); maxCurvature = Math.max(maxCurvature, 2 * cross / (distance(a, p) * distance(p, b) * distance(a, b) || 1)) }
  }
  if (maxTrackGrade > .035 + 1e-6 || maxCurvature > 1 / 150 + 1e-6) return null
  const kinds = samples.map((f, i): RailwayStructure['kind'] | null => f.wet ? 'bridge' : elevations[i]! - f.ground > 1.5 ? 'embankment' : f.ground - elevations[i]! > 1.5 ? 'cutting' : null), structures: RailwayStructure[] = []
  for (let i = 0; i < kinds.length;) {
    const kind = kinds[i], first = i
    while (i + 1 < kinds.length && kinds[i + 1] === kind) i++
    if (kind) {
      const from = Math.max(0, first - 1), to = Math.min(points.length - 1, i + 1), length = lengths[to]! - lengths[from]!
      if (kind === 'bridge') { if (first === 0 || i === points.length - 1 || length > 180) return null; bridgeLength += length; maxBridgeLength = Math.max(maxBridgeLength, length) }
      structures.push({ kind, from: points[from]!, to: points[to]!, length, maxHeight: Math.max(...elevations.slice(from, to + 1).map((z, j) => Math.abs(z - samples[from + j]!.ground))) })
    }
    i++
  }
  return { points, elevations, structures, terminus: points.at(-1)!, length: lengths.at(-1)!, constructionCost, junction: input.start, diagnostics: { maxGroundGrade, maxTrackGrade, maxCurvature, minCurveRadius: maxCurvature ? 1 / maxCurvature : Infinity, maxEarthwork, bridgeLength, maxBridgeLength } }
}
