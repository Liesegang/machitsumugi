import type { Point, Road } from './types'
import type { RoadRole } from './road-graph'

export interface RailwayCorridor { id: string; points: Point[]; builtYear?: number; mode?: 'surface' | 'subway' }
type RailSegment = { a: Point; b: Point; id: string; chainage: number }
export interface SurfaceRailCrossing { point: Point; railwayId: string; chainage: number; along: number; angle: number }
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y)
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const crossing = (a: Point, b: Point, c: Point, d: Point) => {
  const x = b.x - a.x, y = b.y - a.y, u = d.x - c.x, v = d.y - c.y, det = x * v - y * u
  if (Math.abs(det) < 1e-8) return null
  const t = ((c.x - a.x) * v - (c.y - a.y) * u) / det, s = ((c.x - a.x) * y - (c.y - a.y) * x) / det
  return t >= -1e-7 && t <= 1 + 1e-7 && s >= -1e-7 && s <= 1 + 1e-7 ? { t: Math.max(0, Math.min(1, t)), point: lerp(a, b, Math.max(0, Math.min(1, t))) } : null
}
const angle = (a: Point, b: Point, segment: RailSegment) => Math.acos(Math.min(1, Math.abs(((b.x - a.x) * (segment.b.x - segment.a.x) + (b.y - a.y) * (segment.b.y - segment.a.y)) / (distance(a, b) * distance(segment.a, segment.b) || 1))))
const separated = (role: RoadRole) => role === 'expressway' || role === 'ramp'

/** Relative construction credits: at-grade protection, railway land purchase,
 * and a separate grade-crossing structure. These are scenario costs, not yen. */
export class RailwayRoadConstraints {
  private buckets = new Map<string, RailSegment[]>()
  private existing: SurfaceRailCrossing[] = []
  private inventoryKey = ''
  constructor(corridors: RailwayCorridor[]) {
    for (const corridor of corridors) {
    if (corridor.mode === 'subway') continue
    let chainage = 0
    for (let i = 1; i < corridor.points.length; i++) {
      const segment = { a: corridor.points[i - 1]!, b: corridor.points[i]!, id: corridor.id, chainage }
      chainage += distance(segment.a, segment.b)
      if (distance(segment.a, segment.b) < .001) continue
      for (let x = Math.floor(Math.min(segment.a.x, segment.b.x) / 100); x <= Math.floor(Math.max(segment.a.x, segment.b.x) / 100); x++) for (let y = Math.floor(Math.min(segment.a.y, segment.b.y) / 100); y <= Math.floor(Math.max(segment.a.y, segment.b.y) / 100); y++) { const key = `${x}:${y}`, bucket = this.buckets.get(key) ?? []; bucket.push(segment); this.buckets.set(key, bucket) }
    }
    }
  }
  /** Fictional crossing consolidation: retain inherited crossings, but new
   * local streets use that network rather than opening another gate next door. */
  updateExistingRoads(roads: readonly Road[]) {
    const crossings: SurfaceRailCrossing[] = []
    for (const road of roads) if (!road.controlledAccess && (road.level ?? 0) === 0 && !separated(road.role ?? 'lane')) {
      for (const hit of this.crossings(road.points)) if (!crossings.some(other => other.railwayId === hit.railwayId && Math.abs(other.chainage - hit.chainage) < .5)) crossings.push(hit)
    }
    crossings.sort((a, b) => a.railwayId.localeCompare(b.railwayId) || a.chainage - b.chainage)
    const key = crossings.map(hit => `${hit.railwayId}:${hit.chainage.toFixed(1)}`).join('|')
    this.existing = crossings
    if (key === this.inventoryKey) return false
    this.inventoryKey = key
    return true
  }
  private consolidated(segment: RailSegment, point: Point) {
    const at = segment.chainage + distance(segment.a, point)
    if (this.existing.some(hit => hit.railwayId === segment.id && distance(hit.point, point) <= 2)) return true
    return this.existing.every(hit => hit.railwayId !== segment.id || Math.abs(hit.chainage - at) >= 320 || distance(hit.point, point) <= 2)
  }
  private nearby(a: Point, b: Point, padding = 0) {
    const segments = new Set<RailSegment>()
    for (let x = Math.floor((Math.min(a.x, b.x) - padding) / 100); x <= Math.floor((Math.max(a.x, b.x) + padding) / 100); x++) for (let y = Math.floor((Math.min(a.y, b.y) - padding) / 100); y <= Math.floor((Math.max(a.y, b.y) + padding) / 100); y++) for (const segment of this.buckets.get(`${x}:${y}`) ?? []) segments.add(segment)
    return segments
  }
  private parallelCost(a: Point, b: Point, segments: Set<RailSegment>) {
    const middle = lerp(a, b, .5)
    let nearest = Infinity
    for (const segment of segments) {
      if (angle(a, b, segment) > Math.PI / 9) continue
      const x = segment.b.x - segment.a.x, y = segment.b.y - segment.a.y, t = Math.max(0, Math.min(1, ((middle.x - segment.a.x) * x + (middle.y - segment.a.y) * y) / (x * x + y * y)))
      nearest = Math.min(nearest, distance(middle, lerp(segment.a, segment.b, t)))
    }
    if (nearest < 3) return Infinity // A surface street cannot occupy the running track.
    return distance(a, b) * Math.max(0, 1 - nearest / 14) * 6
  }
  /** Search-edge cost; a crossing at a lattice vertex is charged half per edge. */
  edgeCost(a: Point, b: Point, role: RoadRole) {
    const nearby = this.nearby(a, b, 14), hits: Point[] = []
    let cost = separated(role) ? 0 : this.parallelCost(a, b, nearby)
    for (const segment of nearby) {
      const hit = crossing(a, b, segment.a, segment.b)
      if (!hit || hits.some(p => distance(p, hit.point) < .05)) continue
      hits.push(hit.point)
      if (!separated(role) && angle(a, b, segment) < Math.PI / 6) return Infinity
      if (!separated(role) && !this.consolidated(segment, hit.point)) return Infinity
      cost += (separated(role) ? 1800 : 600) * (hit.t < 1e-6 || hit.t > 1 - 1e-6 ? .5 : 1)
    }
    return cost
  }
  crossings(path: Point[]): SurfaceRailCrossing[] {
    if (path.length < 2) return []
    const along = [0], hits: { point: Point; along: number; segment: RailSegment }[] = []
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, length = distance(a, b), nearby = this.nearby(a, b)
      along.push(along[i - 1]! + length)
      for (const segment of nearby) { const hit = crossing(a, b, segment.a, segment.b); if (hit && !hits.some(other => other.segment.id === segment.id && Math.abs(other.along - along[i - 1]! - hit.t * length) < .05)) hits.push({ ...hit, along: along[i - 1]! + hit.t * length, segment }) }
    }
    const total = along.at(-1) ?? 0, at = (chainage: number) => {
      let low = 0, high = along.length - 1
      while (low + 1 < high) { const middle = (low + high) >> 1; if (along[middle]! <= chainage) low = middle; else high = middle }
      return lerp(path[low]!, path[high]!, (chainage - along[low]!) / (along[high]! - along[low]! || 1))
    }
    const result: SurfaceRailCrossing[] = []
    for (const hit of hits.sort((a, b) => a.along - b.along)) {
      if (hit.along < .2 || hit.along > total - .2) continue // A forecourt ending at a platform is not a level crossing.
      const a = at(Math.max(0, hit.along - 2)), b = at(Math.min(total, hit.along + 2)), rail = hit.segment
      const side = (p: Point) => (rail.b.x - rail.a.x) * (p.y - rail.a.y) - (rail.b.y - rail.a.y) * (p.x - rail.a.x)
      if (side(a) * side(b) >= -1e-8) continue
      result.push({ point: hit.point, railwayId: rail.id, chainage: rail.chainage + distance(rail.a, hit.point), along: hit.along, angle: angle(a, b, rail) })
    }
    return result
  }
  pathCost(path: Point[], role: RoadRole) {
    let cost = 0
    if (!separated(role)) for (let i = 1; i < path.length; i++) cost += this.parallelCost(path[i - 1]!, path[i]!, this.nearby(path[i - 1]!, path[i]!, 14))
    const previous = new Map<string, SurfaceRailCrossing>()
    for (const hit of this.crossings(path)) {
      if (!separated(role) && hit.angle < Math.PI / 6) return Infinity
      const reusesExisting = this.existing.some(other => other.railwayId === hit.railwayId && distance(other.point, hit.point) <= 2)
      if (!separated(role) && !reusesExisting && this.existing.some(other => other.railwayId === hit.railwayId && Math.abs(other.chainage - hit.chainage) < 320)) return Infinity
      cost += separated(role) ? 1800 : 600
      const last = previous.get(hit.railwayId)
      if (!separated(role) && last && (hit.along - last.along < 600 || Math.abs(hit.chainage - last.chainage) < 450)) return Infinity
      previous.set(hit.railwayId, hit)
    }
    return cost
  }
}
