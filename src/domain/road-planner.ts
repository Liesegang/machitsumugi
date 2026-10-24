import type { Area, Point, Railway, Road } from './types'
import { MinHeap, roadLength } from './road-graph'
import type { RoadRole } from './road-graph'
import { alignmentDiagnostics, resampleAlignment, splineAlignment, tangentAlignment } from './road-alignment'
import { routeAcrossBridges } from './bridge-routing'
import { RailwayRoadConstraints } from './railway-road-constraints'
import type { RailwayCorridor } from './railway-road-constraints'
import { regionQuery } from './region-query'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'

export interface PlanningTerrain {
  elevation(point: Point): number
  slope(point: Point): number
  waterAt(point: Point): boolean
  seaAt?: (point: Point) => boolean
  /** Real regional samples outside the displayed crop, never edge-clamped land. */
  continuationTerrain?: { elevation(point: Point): number; slope(point: Point): number; waterAt(point: Point): boolean; seaAt?: (point: Point) => boolean; contains?: (point: Point) => boolean; bounds?: { minX: number; minY: number; maxX: number; maxY: number } }
  bridgeSites: Point[]
  bridgeCandidates?: { point: Point; bankA: Point; bankB: Point; width: number; cost: number }[]
  rivers?: { id: string; points: Point[] }[]
  wetness?: (point: Point) => number
  terrainCost?: (point: Point) => number
  bankDistance?: (point: Point) => number
  channelAt?: (point: Point) => { point: Point; tangent: Point; bankDistance: number; width: number; surfaceElevation: number; riverId: string } | null
}
export interface PlanningEnvironment { width: number; height: number; areas: Area[]; core: Point[] | null; terrain?: PlanningTerrain; bridgeSites?: Point[]; landCost?: (point: Point) => number; exactLandCost?: boolean; waterGeometryBounds?: { minX: number; minY: number; maxX: number; maxY: number } }
export interface SurveyedBridgeSpan { bankA: Point; bankB: Point }
export interface PlannedRoute { points: Point[]; length: number; cost: number; bridgeLength: number; method: 'direct' | 'heading-search' | 'bridge-project'; boundaryContinuation?: boolean; surveyedBridgeSpans?: SurveyedBridgeSpan[] }
export interface PlanningOptions { role: RoadRole; width: number; allowBridge?: boolean; startHeading?: number; endHeading?: number; through?: Point; maxNodes?: number; alignment?: 'natural' | 'planned'; maximumGrade?: number }
type PlanningField = { water: boolean; sea: boolean; grade: number; cost: number; coreDistance: number }
type EarthField = { grade: number; cost: number }
type WidthRailSegment = { a: Point; b: Point; id: string; along: number; length: number; levels?: [number, number]; bridges: [number, number][] }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const turn = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
/** Minimum dry-land credit/metre before nonnegative earthwork and ownership costs. */
export const roadConstructionFactor = (role: RoadRole) => role === 'expressway' ? 4.5 : role === 'ramp' ? 2 : role === 'highway' ? 1.8 : role === 'collector' ? 1.35 : role === 'farm' ? .38 : role === 'access' ? .68 : 1
function inside(p: Point, polygon: Point[]) { let hit = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i]!, b = polygon[j]!; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit } return hit }
const occupied = (p: Point, area: Area) => inside(p, area.polygon) && !area.holes?.some(hole => inside(p, hole))
function pointSegmentDistance(p: Point, a: Point, b: Point) { const x = b.x - a.x, y = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * x + (p.y - a.y) * y) / (x * x + y * y || 1))); return distance(p, lerp(a, b, t)) }

/** Terrain corridors and continuous alignments, with heading search for short local constraints.
 * Curvature is chosen during planning, before parcels exist, and is shared by collision and rendering. */
export class RoadPlanner {
  readonly environment: PlanningEnvironment
  private cache: (PlanningField | undefined)[]
  private earthCache: (EarthField | undefined)[]
  private outsideCache = new Map<string, PlanningField>()
  private outsideEarthCache = new Map<string, EarthField>()
  private readonly cacheColumns: number
  private readonly cacheRows: number
  private readonly earthColumns: number
  private readonly earthRows: number
  private waterAreas: Area[]
  private seaAreas: Area[]
  private forests: Area[]
  private forestAt: (point: Point) => boolean
  private waterEdges = new Map<string, { a: Point; b: Point }[]>()
  private bridgeBankCache = new Map<Point, [Point, Point] | null>()
  private dryRouteCache = new Map<string, PlannedRoute | null>()
  private dryComponents = new Map<number, { columns: number; rows: number; labels: Int32Array }>()
  private railwayCorridors: RailwayCorridor[] = []
  private widthRailBuckets = new Map<string, WidthRailSegment[]>()
  private railwayConstraints: RailwayRoadConstraints | null = null
  private railwayRevision = 0
  get transportRevision() { return this.railwayRevision }
  setRailwayCorridors(corridors: RailwayCorridor[]) {
    if (corridors.length === this.railwayCorridors.length && corridors.every((corridor, i) => corridor === this.railwayCorridors[i])) return
    this.railwayCorridors = corridors.slice()
    this.widthRailBuckets.clear()
    for (const corridor of corridors) {
      if (corridor.mode === 'subway') continue
      const detailed = corridor as RailwayCorridor & Partial<Pick<Railway, 'elevations' | 'structures'>>
      const chainage = [0]
      for (let i = 1; i < corridor.points.length; i++) chainage.push(chainage[i - 1]! + distance(corridor.points[i - 1]!, corridor.points[i]!))
      const along = (point: Point) => {
        let best = Infinity, at = 0
        for (let i = 1; i < corridor.points.length; i++) {
          const a = corridor.points[i - 1]!, b = corridor.points[i]!, dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1))), d = distance(point, lerp(a, b, t))
          if (d < best) { best = d; at = chainage[i - 1]! + t * (chainage[i]! - chainage[i - 1]!) }
        }
        return at
      }
      const bridges = (detailed.structures ?? []).filter(s => s.kind === 'bridge').map(s => { const a = along(s.from), b = along(s.to); return [Math.min(a, b), Math.max(a, b)] as [number, number] })
      for (let i = 1; i < corridor.points.length; i++) {
        const a = corridor.points[i - 1]!, b = corridor.points[i]!, length = distance(a, b)
        if (length < .001) continue
        const levels = detailed.elevations?.[i - 1] !== undefined && detailed.elevations?.[i] !== undefined ? [detailed.elevations[i - 1]!, detailed.elevations[i]!] as [number, number] : undefined
        const segment: WidthRailSegment = { a, b, id: corridor.id, along: chainage[i - 1]!, length, levels, bridges }
        for (let x = Math.floor(Math.min(a.x, b.x) / 100); x <= Math.floor(Math.max(a.x, b.x) / 100); x++) for (let y = Math.floor(Math.min(a.y, b.y) / 100); y <= Math.floor(Math.max(a.y, b.y) / 100); y++) { const key = `${x}:${y}`, list = this.widthRailBuckets.get(key) ?? []; list.push(segment); this.widthRailBuckets.set(key, list) }
      }
    }
    this.railwayConstraints = corridors.length ? new RailwayRoadConstraints(corridors) : null
    this.railwayRevision++; this.dryRouteCache.clear()
  }
  setRailwayRoadNetwork(roads: readonly Road[]) {
    if (!this.railwayConstraints?.updateExistingRoads(roads)) return
    this.railwayRevision++; this.dryRouteCache.clear()
  }
  railwayAllows(path: Point[], role: RoadRole) {
    return Number.isFinite(this.railwayConstraints?.pathCost(path, role) ?? 0)
  }
  /** Widening keeps the inherited centreline and legal crossing, but cannot
   * purchase a strip along the running track. A bridge is exempt only where
   * its actual profile proves clearance above this ground-level pavement. */
  railwayWidthAllows(path: Point[], oldWidth: number, newWidth: number, role: RoadRole) {
    if (path.length < 2 || path.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)) || !Number.isFinite(oldWidth) || !Number.isFinite(newWidth) || oldWidth <= 0 || newWidth <= 0) return false
    if (newWidth <= oldWidth || !this.widthRailBuckets.size) return true
    if (!this.railwayAllows(path, role)) return false
    const clearance = 3, half = newWidth / 2 + clearance, windows = new Map<string, [number, number][]>()
    for (const hit of this.railwayConstraints?.crossings(path) ?? []) {
      const reach = half / Math.max(.5, Math.sin(hit.angle)), list = windows.get(hit.railwayId) ?? []
      list.push([hit.chainage - reach, hit.chainage + reach]); windows.set(hit.railwayId, list)
    }
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, length = distance(a, b)
      if (length < .001) continue
      const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length, found = new Set<WidthRailSegment>()
      for (let x = Math.floor((Math.min(a.x, b.x) - half) / 100); x <= Math.floor((Math.max(a.x, b.x) + half) / 100); x++) for (let y = Math.floor((Math.min(a.y, b.y) - half) / 100); y <= Math.floor((Math.max(a.y, b.y) + half) / 100); y++) for (const segment of this.widthRailBuckets.get(`${x}:${y}`) ?? []) found.add(segment)
      for (const segment of found) {
        let lo = 0, hi = 1
        const local = (p: Point) => ({ x: (p.x - a.x) * ux + (p.y - a.y) * uy, y: -(p.x - a.x) * uy + (p.y - a.y) * ux }), start = local(segment.a), end = local(segment.b)
        for (const [v, d, lower, upper] of [[start.x, end.x - start.x, -clearance, length + clearance], [start.y, end.y - start.y, -half, half]]) {
          if (Math.abs(d!) < 1e-10) { if (v! < lower! || v! > upper!) { hi = -1; break } }
          else { const p = (lower! - v!) / d!, q = (upper! - v!) / d!; lo = Math.max(lo, Math.min(p, q)); hi = Math.min(hi, Math.max(p, q)) }
        }
        if (hi - lo < 1e-8) continue
        const from = segment.along + lo * segment.length, to = segment.along + hi * segment.length, allowed = [...windows.get(segment.id) ?? []]
        if (segment.levels && segment.levels.every(Number.isFinite) && this.environment.terrain) for (const bridge of segment.bridges) {
          const low = Math.max(from, bridge[0]), high = Math.min(to, bridge[1])
          if (high <= low) continue
          const count = Math.max(1, Math.ceil((high - low) / 6))
          let above = true
          for (let j = 0; j <= count; j++) {
            const at = low + (high - low) * j / count, t = (at - segment.along) / segment.length, ground = this.environment.terrain.elevation(lerp(segment.a, segment.b, t)), level = segment.levels[0] + (segment.levels[1] - segment.levels[0]) * t
            if (!Number.isFinite(ground) || level - ground < 4.5) { above = false; break }
          }
          if (above) allowed.push([low, high])
        }
        let covered = from
        for (const [low, high] of allowed.sort((x, y) => x[0] - y[0])) { if (low > covered + 1e-6) break; covered = Math.max(covered, high); if (covered >= to - 1e-6) break }
        if (covered < to - 1e-6) return false
      }
    }
    return true
  }
  constructor(environment: PlanningEnvironment) {
    this.environment = environment
    this.cacheColumns = Math.ceil(environment.width / 6) + 3
    this.cacheRows = Math.ceil(environment.height / 6) + 3
    this.earthColumns = Math.ceil(environment.width / 24) + 3
    this.earthRows = Math.ceil(environment.height / 24) + 3
    // Keep the existing first-sample semantics of both survey grids. Only the
    // storage changes: millions of repeated lookups need no hash table probe.
    this.cache = new Array(this.cacheColumns * this.cacheRows)
    this.earthCache = new Array(this.earthColumns * this.earthRows)
    this.waterAreas = environment.areas.filter(a => a.kind === 'water')
    this.seaAreas = this.waterAreas.filter(a => a.id === 'sea' || a.id.startsWith('sea-'))
    this.forests = environment.areas.filter(a => a.kind === 'forest')
    this.forestAt = regionQuery(this.forests)
    for (const area of this.waterAreas) for (const ring of [area.polygon, ...(area.holes ?? [])]) for (let i = 0; i < ring.length; i++) {
      const edge = { a: ring[i]!, b: ring[(i + 1) % ring.length]! }
      for (let x = Math.floor(Math.min(edge.a.x, edge.b.x) / 100); x <= Math.floor(Math.max(edge.a.x, edge.b.x) / 100); x++) for (let y = Math.floor(Math.min(edge.a.y, edge.b.y) / 100); y <= Math.floor(Math.max(edge.a.y, edge.b.y) / 100); y++) { const key = `${x}:${y}`, bucket = this.waterEdges.get(key) ?? []; bucket.push(edge); this.waterEdges.set(key, bucket) }
    }
  }
  private field(p: Point) {
    const gx = Math.round(p.x / 6), gy = Math.round(p.y / 6)
    const within = gx >= 0 && gy >= 0 && gx < this.cacheColumns && gy < this.cacheRows
    const k = within ? gy * this.cacheColumns + gx : -1
    const outsideKey = within ? '' : `${gx},${gy}`
    let value = within ? this.cache[k] : this.outsideCache.get(outsideKey)
    // A hard parcel/building mask must not move to the terrain-cost lattice.
    // Only small site planners opt in; the larger smooth earthwork cache stays.
    const exactLandCost = this.environment.exactLandCost ? this.environment.landCost?.(p) ?? 0 : 0
    if (value) return exactLandCost ? { ...value, cost: value.cost + exactLandCost } : value
    const terrain = this.environment.terrain
    const water = terrain ? terrain.waterAt(p) : this.waterAreas.some(a => occupied(p, a))
    const sea = water && (terrain?.seaAt?.(p) ?? this.seaAreas.some(a => occupied(p, a)))
    const ex = Math.round(p.x / 24), ey = Math.round(p.y / 24)
    const earthWithin = ex >= 0 && ey >= 0 && ex < this.earthColumns && ey < this.earthRows
    const earthKey = earthWithin ? ey * this.earthColumns + ex : -1
    const outsideEarthKey = earthWithin ? '' : `${ex},${ey}`
    let earth = earthWithin ? this.earthCache[earthKey] : this.outsideEarthCache.get(outsideEarthKey)
    if (!earth) {
      const q = { x: ex * 24, y: ey * 24 }, grade = terrain?.slope(q) ?? 0
      const forest = this.forestAt(q)
      earth = { grade, cost: 1 + grade * grade * 95 + Math.max(0, terrain?.elevation(q) ?? 0) / 500 + (forest ? 2.4 : 0) + (terrain?.wetness?.(q) ?? 0) * .55 + (this.environment.exactLandCost ? 0 : this.environment.landCost?.(q) ?? 0) }
      if (earthWithin) this.earthCache[earthKey] = earth
      else this.outsideEarthCache.set(outsideEarthKey, earth)
    }
    const grade = earth.grade
    const core = this.environment.core
    const coreDistance = core ? inside(p, core) ? -1 : Math.min(...core.map((a, i) => pointSegmentDistance(p, a, core[(i + 1) % core.length]!))) : Infinity
    // Relative construction cost, not yen or a claim of engineering calibration.
    const cost = earth.cost
    value = { water, sea, grade, cost, coreDistance }
    if (within) this.cache[k] = value
    else this.outsideCache.set(outsideKey, value)
    return exactLandCost ? { ...value, cost: value.cost + exactLandCost } : value
  }
  waterAt(p: Point) { return this.environment.terrain?.waterAt(p) ?? this.waterAreas.some(a => occupied(p, a)) }
  suitable(p: Point, width = 6) {
    if (p.x < width || p.y < width || p.x > this.environment.width - width || p.y > this.environment.height - width) return false
    const f = this.field(p)
    return !f.water && f.grade < .20 && f.coreDistance > width / 2 + 4
  }
  private crossesWater(a: Point, b: Point) {
    if (this.waterAt(a) || this.waterAt(b)) return true
    const bounds = this.environment.waterGeometryBounds ?? { minX: 0, minY: 0, maxX: this.environment.width, maxY: this.environment.height }
    const exactGeometry = this.waterAreas.length && [a, b].every(p => p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY)
    if (exactGeometry) {
      const tested = new Set<object>(), dx = b.x - a.x, dy = b.y - a.y
      for (let x = Math.floor(Math.min(a.x, b.x) / 100); x <= Math.floor(Math.max(a.x, b.x) / 100); x++) for (let y = Math.floor(Math.min(a.y, b.y) / 100); y <= Math.floor(Math.max(a.y, b.y) / 100); y++) for (const edge of this.waterEdges.get(`${x}:${y}`) ?? []) {
        if (tested.has(edge)) continue
        tested.add(edge)
        const ex = edge.b.x - edge.a.x, ey = edge.b.y - edge.a.y, det = dx * ey - dy * ex
        if (Math.abs(det) < 1e-8) continue
        const t = ((edge.a.x - a.x) * ey - (edge.a.y - a.y) * ex) / det, u = ((edge.a.x - a.x) * dy - (edge.a.y - a.y) * dx) / det
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return true
      }
      return false
    }
    if (!this.environment.terrain) return false
    const n = Math.max(1, Math.ceil(distance(a, b)))
    for (let i = 1; i < n; i++) if (this.waterAt(lerp(a, b, i / n))) return true
    return false
  }
  private validSegment(a: Point, b: Point, width: number, bridge = false) {
    const n = Math.max(1, Math.ceil(distance(a, b) / 6)), angle = Math.atan2(b.y - a.y, b.x - a.x)
    if (!bridge) for (const side of [-1, 0, 1]) {
      const offset = { x: -Math.sin(angle) * width / 2 * side, y: Math.cos(angle) * width / 2 * side }
      if (this.crossesWater({ x: a.x + offset.x, y: a.y + offset.y }, { x: b.x + offset.x, y: b.y + offset.y })) return false
    }
    for (let i = 0; i <= n; i++) {
      const p = lerp(a, b, i / n)
      for (const side of [-1, 0, 1]) {
        const q = { x: p.x - Math.sin(angle) * width / 2 * side, y: p.y + Math.cos(angle) * width / 2 * side }
        if (q.x < 2 || q.y < 2 || q.x > this.environment.width - 2 || q.y > this.environment.height - 2) return false
        const f = this.field(q)
        if (f.sea || f.coreDistance < 3 || (!bridge && (f.water || f.grade > .23))) return false
      }
    }
    return true
  }
  validate(path: Point[], width: number, allowBridge = false) {
    if (path.length < 2) return false
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, angle = Math.atan2(b.y - a.y, b.x - a.x), n = Math.max(1, Math.ceil(distance(a, b) / 3))
      for (let j = 0; j <= n; j++) for (const side of [-1, 0, 1]) {
        const p = lerp(a, b, j / n), q = { x: p.x - Math.sin(angle) * width / 2 * side, y: p.y + Math.cos(angle) * width / 2 * side }
        if (!allowBridge && this.waterAt(q)) return false
        if (this.seaAreas.some(region => occupied(q, region))) return false
        if (this.environment.core && (inside(q, this.environment.core) || this.environment.core.some((p, k, polygon) => pointSegmentDistance(q, p, polygon[(k + 1) % polygon.length]!) < 2))) return false
      }
      if (!this.validSegment(a, b, width, allowBridge)) return false
    }
    return true
  }
  private waterFraction(a: Point, b: Point) {
    const count = Math.max(1, Math.ceil(distance(a, b))), samples = Array.from({ length: count + 1 }, (_, i) => this.waterAt(lerp(a, b, i / count)))
    let total = 0
    for (let i = 0; i < count; i++) {
      if (samples[i] === samples[i + 1]) { total += Number(samples[i]); continue }
      let low = i / count, high = (i + 1) / count
      for (let j = 0; j < 12; j++) { const middle = (low + high) / 2; if (this.waterAt(lerp(a, b, middle)) === samples[i]) low = middle; else high = middle }
      const split = (low + high) / 2
      total += samples[i] ? (split - i / count) * count : ((i + 1) / count - split) * count
    }
    return total / count
  }
  cost(path: Point[], role: RoadRole, surveyedBridge = false): PlannedRoute {
    const dense: Point[] = [path[0]!]
    for (let i = 1; i < path.length; i++) { const a = path[i - 1]!, b = path[i]!, n = Math.max(1, Math.ceil(distance(a, b) / 12)); for (let j = 1; j <= n; j++) dense.push(lerp(a, b, j / n)) }
    path = dense
    let length = 0, cost = 0, bridgeLength = 0
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, n = distance(a, b), middle = lerp(a, b, .5), f = this.field(middle)
      length += n
      const water = surveyedBridge ? this.waterFraction(a, b) : f.water ? 1 : 0
      bridgeLength += n * water; cost += n * water * 13
      cost += n * (1 - water) * f.cost * roadConstructionFactor(role)
    }
    if (bridgeLength) cost += 420
    cost += this.railwayConstraints?.pathCost(path, role) ?? 0
    return { points: path, length, cost, bridgeLength, method: 'heading-search' }
  }
  private banks(site: Point): [Point, Point] | null {
    if (this.bridgeBankCache.has(site)) return this.bridgeBankCache.get(site)!
    const surveyed = this.environment.terrain?.bridgeCandidates?.find(candidate => distance(candidate.point, site) < 5)
    if (surveyed) {
      const pair: [Point, Point] = [surveyed.bankA, surveyed.bankB]
      if (pair.every(point => this.suitable(point, 12)) && this.validate(pair, 9, true)) { this.bridgeBankCache.set(site, pair); return pair }
    }
    let best: [Point, Point] | null = null, bestCost = Infinity
    for (let i = 0; i < 16; i++) {
      const angle = i * Math.PI / 16, u = { x: Math.cos(angle), y: Math.sin(angle) }, pair: Point[] = []
      for (const side of [-1, 1]) {
        let found: Point | null = null
        for (let d = 12; d <= 330; d += 12) {
          const p = { x: site.x + u.x * d * side, y: site.y + u.y * d * side }
          if (!this.waterAt(p) && this.suitable(p, 12) && !this.waterAt({ x: p.x + u.x * 25 * side, y: p.y + u.y * 25 * side })) { found = { x: p.x + u.x * 20 * side, y: p.y + u.y * 20 * side }; break }
        }
        if (found) pair.push(found)
      }
      if (pair.length !== 2 || !this.validate(pair, 9, true)) continue
      const cost = distance(pair[0]!, pair[1]!) + ((this.environment.terrain?.slope(pair[0]!) ?? 0) + (this.environment.terrain?.slope(pair[1]!) ?? 0)) * 500
      if (cost < bestCost) { bestCost = cost; best = [pair[0]!, pair[1]!] }
    }
    this.bridgeBankCache.set(site, best); return best
  }
  /** Exact reachability on the corridor search's own lattice. River-separated
   * land legs can be rejected once, before repeatedly running curvature search.
   * This is a search cache, never a road layout or a replacement for validation. */
  private sameDryCorridor(start: Point, goal: Point, corridorWidth: number, roadWidth: number) {
    const spacing = 45
    let grid = this.dryComponents.get(corridorWidth)
    if (!grid) {
      const columns = Math.ceil(this.environment.width / spacing) + 1, rows = Math.ceil(this.environment.height / spacing) + 1, labels = new Int32Array(columns * rows).fill(-1)
      const point = (i: number): Point => ({ x: i % columns * spacing, y: Math.floor(i / columns) * spacing })
      for (let i = 0; i < labels.length; i++) if (this.suitable(point(i), corridorWidth)) labels[i] = 0
      let component = 0
      for (let i = 0; i < labels.length; i++) {
        if (labels[i] !== 0) continue
        component++; labels[i] = component
        const queue = [i]
        for (let at = 0; at < queue.length; at++) {
          const current = queue[at]!, x = current % columns, y = Math.floor(current / columns), a = point(current)
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const nx = x + dx!, ny = y + dy!
            if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue
            const next = ny * columns + nx
            if (labels[next] !== 0 || !this.validSegment(a, point(next), corridorWidth)) continue
            labels[next] = component; queue.push(next)
          }
        }
      }
      grid = { columns, rows, labels }; this.dryComponents.set(corridorWidth, grid)
    }
    const labelsNear = (p: Point, starting: boolean) => {
      const found = new Set<number>(), x = Math.round(p.x / spacing), y = Math.round(p.y / spacing)
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
        if (starting && (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (!dx && !dy))) continue
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= grid.columns || ny >= grid.rows) continue
        const label = grid.labels[ny * grid.columns + nx]!, q = { x: nx * spacing, y: ny * spacing }
        if (label > 0 && (!starting ? distance(p, q) < spacing * 1.6 : true) && this.validSegment(p, q, starting ? corridorWidth : roadWidth)) found.add(label)
      }
      return found
    }
    const from = labelsNear(start, true), to = labelsNear(goal, false)
    return [...from].some(label => to.has(label))
  }
  /** Cheap gate/site survey on the same dry search lattice as the road planner.
   * This establishes reachability, never permission to skip final curve checks. */
  hasDryCorridor(start: Point, goal: Point, role: RoadRole, width: number) {
    if (!this.suitable(start, width) || !this.suitable(goal, width)) return false
    const major = role === 'highway' || role === 'collector' || role === 'ramp'
    const margin = role === 'expressway' ? 75 : major ? 45 : 14
    return this.validSegment(start, goal, width) || this.sameDryCorridor(start, goal, width + margin, width)
  }
  /** Longitudinal grade is different from the hillside's cross-slope. Apply an
   * engineering limit during search, so a steep cheap route does not conceal a
   * feasible, gentler detour that would survive the final road-profile survey. */
  private gradeAllowed(path: Point[], maximumGrade: number) {
    const terrain = this.environment.terrain
    if (!terrain || maximumGrade === Infinity) return true
    if (!(maximumGrade > 0) || !Number.isFinite(maximumGrade)) return false
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, length = distance(a, b), samples = Math.max(1, Math.ceil(length / 6))
      let previous = terrain.elevation(a)
      for (let j = 1; j <= samples; j++) {
        const next = terrain.elevation(lerp(a, b, j / samples))
        if (!Number.isFinite(next) || !Number.isFinite(previous) || Math.abs(next - previous) > maximumGrade * length / samples + 1e-8) return false
        previous = next
      }
    }
    return true
  }
  private endpointConnector(start: Point, goal: Point, options: PlanningOptions) {
    if (options.startHeading === undefined || options.endHeading === undefined || distance(start, goal) > 850) return null
    const radius = options.role === 'expressway' ? 240 : options.role === 'ramp' ? 60 : options.role === 'highway' ? 85 : options.role === 'collector' ? 50 : 15, direct = distance(start, goal)
    const maximumGrade = options.maximumGrade ?? (options.role === 'expressway' ? .07 : options.role === 'ramp' ? .10 : Infinity)
    const straightCost = this.cost([start, goal], options.role).cost, handles = [.38, .55, .75, 1, .22]
    const proposals = [...handles.map(a => [a, a] as const), ...handles.flatMap(a => handles.filter(b => b !== a).map(b => [a, b] as const))]
    let best: PlannedRoute | null = null
    for (const [a, b] of proposals) {
      const points = tangentAlignment(start, goal, options.startHeading, options.endHeading, direct * a, direct * b)
      const diagnostics = alignmentDiagnostics(points)
      if (diagnostics.minimumRadius < radius || diagnostics.length > direct * 2.1 || !this.validate(points, options.width)) continue
      if (!this.gradeAllowed(points, maximumGrade)) continue
      const route = this.cost(points, options.role)
      if (route.cost < straightCost * 1.08) return route
      if (!best || route.cost < best.cost) best = route
    }
    return best
  }
  /** The least-cost corridor supplies an elastic control polygon for a validated
   * C2 alignment. Keeping that corridor preserves geographic/ownership constraints;
   * it is a search discretisation, never a drawn road grid. */
  private corridor(start: Point, goal: Point, options: PlanningOptions): PlannedRoute | null {
    const major = options.role === 'highway' || options.role === 'collector' || options.role === 'expressway' || options.role === 'ramp'
    const minimumRadius = options.role === 'expressway' ? 240 : options.role === 'ramp' ? 60 : options.role === 'highway' ? 85 : major ? 50 : 15
    const maximumGrade = options.maximumGrade ?? (options.role === 'expressway' ? .07 : options.role === 'ramp' ? .10 : Infinity)
    const searchMaximumGrade = options.maximumGrade ?? Infinity
    const leadDistance = Math.min(250, minimumRadius * 2.5, distance(start, goal) * .35)
    const guide = (point: Point, heading: number | undefined, direction: number) => {
      if (heading === undefined) return point
      for (const scale of [1, .7, .45]) { const p = { x: point.x + Math.cos(heading) * leadDistance * direction * scale, y: point.y + Math.sin(heading) * leadDistance * direction * scale }; if (this.validSegment(point, p, options.width) && this.gradeAllowed([point, p], searchMaximumGrade)) return p }
      return null
    }
    const searchStart = guide(start, options.startHeading, 1), searchGoal = guide(goal, options.endHeading, -1)
    if (!searchStart || !searchGoal) return null
    const spacing = 45, width = Math.ceil(this.environment.width / spacing) + 1, corridorWidth = options.width + (options.role === 'expressway' ? 75 : major ? 45 : 14)
    if (!this.validSegment(searchStart, searchGoal, options.width) && !this.sameDryCorridor(searchStart, searchGoal, corridorWidth, options.width)) return null
    type Cell = { p: Point; index: number; cost: number; previous: Cell | null }
    const index = (p: Point) => Math.round(p.y / spacing) * width + Math.round(p.x / spacing)
    const queue = new MinHeap<Cell>(), values = new Map<number, number>()
    const initial: Cell = { p: searchStart, index: index(searchStart), cost: 0, previous: null }
    queue.push(initial, distance(searchStart, searchGoal)); values.set(initial.index, 0)
    let last: Cell | null = null
    for (let n = 0; queue.size && n < (options.maxNodes ?? width * (Math.ceil(this.environment.height / spacing) + 1)); n++) {
      const current = queue.pop()!.value
      if (current.cost > (values.get(current.index) ?? Infinity)) continue
      if (distance(current.p, searchGoal) < spacing * 1.6 && this.validSegment(current.p, searchGoal, options.width) && this.gradeAllowed([current.p, searchGoal], searchMaximumGrade)) { last = current; break }
      const gx = Math.round(current.p.x / spacing), gy = Math.round(current.p.y / spacing)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const p = { x: (gx + dx!) * spacing, y: (gy + dy!) * spacing }, k = index(p)
        if (!this.suitable(p, corridorWidth) || !this.validSegment(current.p, p, corridorWidth) || !this.gradeAllowed([current.p, p], searchMaximumGrade)) continue
        const cost = current.cost + distance(current.p, p) * this.field(p).cost + (this.railwayConstraints?.edgeCost(current.p, p, options.role) ?? 0) / roadConstructionFactor(options.role)
        if (cost >= (values.get(k) ?? Infinity)) continue
        values.set(k, cost); queue.push({ p, index: k, cost, previous: current }, cost + distance(p, searchGoal) * 1.25)
      }
    }
    if (!last) return null
    const coarse: Point[] = [searchGoal]
    for (let state: Cell | null = last; state; state = state.previous) coarse.push(state.p)
    coarse.reverse()
    if (options.startHeading !== undefined) coarse.unshift(start)
    if (options.endHeading !== undefined) coarse.push(goal)
    // Preserve the least-cost corridor. Farthest-visible simplification erased
    // terrain/ownership response and left kilometre-long rays joined by elbows.
    // Both endpoint tangents need their own control. A three-control short
    // corridor made the goal pin overwrite the start pin at controls[1].
    const spacingForControls = options.role === 'expressway' ? 260 : options.role === 'highway' ? 140 : major ? 100 : 65
    const bothPinned = options.startHeading !== undefined && options.endHeading !== undefined
    const controls = resampleAlignment(coarse, bothPinned ? Math.min(spacingForControls, roadLength(coarse) / 3) : spacingForControls)
    if (controls.length < 3) controls.splice(1, 0, lerp(start, goal, .5))
    const firstPinned = options.startHeading !== undefined, lastPinned = options.endHeading !== undefined
    if (firstPinned) controls[1] = { x: start.x + Math.cos(options.startHeading!) * Math.min(120, distance(start, searchStart)), y: start.y + Math.sin(options.startHeading!) * Math.min(120, distance(start, searchStart)) }
    if (lastPinned) controls[controls.length - 2] = { x: goal.x - Math.cos(options.endHeading!) * Math.min(120, distance(goal, searchGoal)), y: goal.y - Math.sin(options.endHeading!) * Math.min(120, distance(goal, searchGoal)) }
    const extendedPorts = controls.length >= 6
    const along = (path: Point[], chainage: number) => {
      for (let i = 1; i < path.length; i++) { const length = distance(path[i - 1]!, path[i]!); if (chainage <= length) return lerp(path[i - 1]!, path[i]!, chainage / length); chainage -= length }
      return path.at(-1)!
    }
    // Keep the turning bay as well as the tangent itself. Optimizing the next
    // control back toward the straight chord otherwise squeezes a valid
    // junction approach into a tight hook despite its exact endpoint heading.
    if (extendedPorts && firstPinned) controls[2] = along(coarse, Math.min(roadLength(coarse) * .42, distance(start, searchStart) + minimumRadius * 1.5))
    if (extendedPorts && lastPinned) controls[controls.length - 3] = along(coarse.slice().reverse(), Math.min(roadLength(coarse) * .42, distance(goal, searchGoal) + minimumRadius * 1.5))
    const pinned = (i: number) => (firstPinned && i <= (extendedPorts ? 2 : 1)) || (lastPinned && i >= controls.length - (extendedPorts ? 3 : 2))
    const bending = options.role === 'expressway' ? 320 : options.role === 'highway' ? 140 : major ? 90 : 35
    const energy = (a: Point, b: Point, c: Point) => {
      const ab = distance(a, b), bc = distance(b, c), angle = turn(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x))
      return (ab * (this.field(a).cost + this.field(b).cost) + bc * (this.field(b).cost + this.field(c).cost)) / 2 + bending * bending * angle * angle / Math.max(30, (ab + bc) / 2) + ((this.railwayConstraints?.edgeCost(a, b, options.role) ?? 0) + (this.railwayConstraints?.edgeCost(b, c, options.role) ?? 0)) / roadConstructionFactor(options.role)
    }
    for (const step of [28, 20, 12, 8]) for (let pass = 0; pass < 2; pass++) for (let i = 1; i < controls.length - 1; i++) {
      if (pinned(i)) continue
      const a = controls[i - 1]!, b = controls[i]!, c = controls[i + 1]!, angle = Math.atan2(c.y - a.y, c.x - a.x), midpoint = lerp(a, c, .5)
      const candidates = [b, { x: b.x - Math.sin(angle) * step, y: b.y + Math.cos(angle) * step }, { x: b.x + Math.sin(angle) * step, y: b.y - Math.cos(angle) * step }, lerp(b, midpoint, .28)]
      let best = b, bestEnergy = energy(a, b, c)
      for (const p of candidates.slice(1)) if (this.suitable(p, corridorWidth) && this.validSegment(a, p, corridorWidth) && this.validSegment(p, c, corridorWidth) && this.gradeAllowed([a, p, c], searchMaximumGrade)) { const e = energy(a, p, c); if (e < bestEnergy) { best = p; bestEnergy = e } }
      controls[i] = best
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const curve = splineAlignment(controls, 5), diagnostics = alignmentDiagnostics(curve)
      if (diagnostics.minimumRadius >= minimumRadius && this.gradeAllowed(curve, maximumGrade) && this.validate(curve, options.width)) return this.cost(curve, options.role)
      // Broaden a geographic bend instead of drawing a decorative curve on top
      // of a sharp canonical polyline. End constraints remain exactly pinned.
      for (let i = 1; i < controls.length - 1; i++) if (!pinned(i)) controls[i] = lerp(controls[i]!, lerp(controls[i - 1]!, controls[i + 1]!, .5), .22)
    }
    return null
  }
  plan(start: Point, goal: Point, options: PlanningOptions): PlannedRoute | null {
    const route = this.planGeometry(start, goal, options)
    if (route) {
      const first = route.points[0]!, last = route.points.at(-1)!, next = route.points.find(p => distance(first, p) > 1e-6), before = [...route.points].reverse().find(p => distance(last, p) > 1e-6)
      // Validate the canonical sampled pavement, not just the spline controls.
      // Five-metre chords on the minimum 50m collector radius fit within 0.1rad;
      // a 15m-radius local lane needs up to 0.2rad for the same sampling interval.
      const tolerance = ['highway', 'collector', 'expressway', 'ramp'].includes(options.role) ? .1 : .2
      if (!next || !before || options.startHeading !== undefined && Math.abs(turn(Math.atan2(next.y - first.y, next.x - first.x) - options.startHeading)) > tolerance || options.endHeading !== undefined && Math.abs(turn(Math.atan2(last.y - before.y, last.x - before.x) - options.endHeading)) > tolerance) return null
    }
    if (route && options.maximumGrade !== undefined && this.environment.terrain && (!(options.maximumGrade > 0) || !surveyedRoadGradeAllowed(route, options.maximumGrade, p => this.environment.terrain!.elevation(p)))) return null
    return route && Number.isFinite(route.cost) ? route : null
  }
  private planGeometry(start: Point, goal: Point, options: PlanningOptions): PlannedRoute | null {
    const maximumGrade = options.maximumGrade ?? (options.role === 'expressway' ? .07 : options.role === 'ramp' ? .10 : Infinity)
    const searchMaximumGrade = options.maximumGrade ?? Infinity
    if (distance(start, goal) < 16 || !this.suitable(start, options.width) || !this.suitable(goal, options.width)) return null
    if (options.through && distance(start, options.through) > 20 && distance(goal, options.through) > 20) {
      const corner = options.through
      // Short town lanes follow property edges with a small corner radius. Treating
      // every 5m lane as a highway-radius curve produced repeated suburban U-loops.
      if (!['highway', 'collector', 'expressway', 'ramp'].includes(options.role) && this.validate([start, corner, goal], options.width)) {
        const trim = Math.min(40, distance(start, corner) * .32, distance(goal, corner) * .32)
        const entry = lerp(corner, start, trim / distance(start, corner)), exit = lerp(corner, goal, trim / distance(goal, corner))
        const points = splineAlignment([start, entry, corner, exit, goal], 5)
        if (alignmentDiagnostics(points).minimumRadius > 12 && this.validate(points, options.width) && this.gradeAllowed(points, searchMaximumGrade)) { const route = this.cost(points, options.role); if (Number.isFinite(route.cost)) return route }
      }
      const a = this.plan(start, options.through, { ...options, through: undefined, endHeading: undefined })
      if (!a) return null
      const last = a.points.at(-1)!, before = a.points.at(-2)!, heading = Math.atan2(last.y - before.y, last.x - before.x)
      const b = this.plan(options.through, goal, { ...options, through: undefined, startHeading: heading })
      if (!b) return null
      const result = this.cost([...a.points, ...b.points.slice(1)], options.role)
      const spans = [...(a.surveyedBridgeSpans ?? []), ...(b.surveyedBridgeSpans ?? [])]
      if (spans.length) result.surveyedBridgeSpans = spans
      if (result.length > distance(start, goal) * 2.3) return null
      return result
    }
    const crosses = options.allowBridge && this.crossesWater(start, goal)
    if (crosses && options.allowBridge) {
      // A trade route may cross the trunk and a tributary. Surveyed bank pairs
      // form a small directed graph; every land leg still obeys the same width,
      // acquisition and approach-curvature constraints as an ordinary road.
      const sites = [...(this.environment.bridgeSites ?? this.environment.terrain?.bridgeSites ?? []), ...(this.environment.terrain?.bridgeCandidates?.map(candidate => candidate.point) ?? [])]
        .filter((site, i, all) => !all.slice(0, i).some(other => distance(site, other) < 5))
      const pairs = sites.flatMap(site => {
        const pair = this.banks(site)
        const gradeAllowed = pair && (!this.environment.terrain || Math.abs(this.environment.terrain.elevation(pair[1]) - this.environment.terrain.elevation(pair[0])) / distance(pair[0], pair[1]) <= maximumGrade)
        return pair && gradeAllowed && this.validate(pair, options.width, true) ? [{ a: pair[0], b: pair[1] }] : []
      })
      const pointKey = (p: Point) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`
      const bridgeRoute = routeAcrossBridges({
        start, goal, pairs, role: options.role, width: options.width,
        startHeading: options.startHeading, endHeading: options.endHeading,
        lowerBound: (a, b) => distance(a, b) * roadConstructionFactor(options.role),
        cost: points => this.cost(points, options.role, true),
        dry: (a, b, startHeading, endHeading) => {
          const key = `${pointKey(a)}>${pointKey(b)}:${options.role}:${options.width}:${startHeading?.toFixed(6)}:${endHeading?.toFixed(6)}:${options.alignment ?? 'natural'}:${options.maximumGrade ?? 'default'}`
          if (this.dryRouteCache.has(key)) return this.dryRouteCache.get(key)!
          const route = this.plan(a, b, { ...options, through: undefined, allowBridge: false, startHeading, endHeading, maxNodes: options.maxNodes ?? 9000 })
          this.dryRouteCache.set(key, route)
          return route
        },
      })
      if (bridgeRoute) return bridgeRoute
    }
    const direct = this.cost([start, goal], options.role)
    const directHeading = Math.atan2(goal.y - start.y, goal.x - start.x)
    const headingCompatible = (options.startHeading === undefined || Math.abs(turn(directHeading - options.startHeading)) < .06) && (options.endHeading === undefined || Math.abs(turn(directHeading - options.endHeading)) < .06)
    if (Number.isFinite(direct.cost) && (options.alignment === 'planned' || distance(start, goal) < 90) && this.validate([start, goal], options.width) && this.gradeAllowed([start, goal], searchMaximumGrade) && headingCompatible && (options.alignment === 'planned' || options.role === 'access' || direct.cost / direct.length < 1.55)) {
      const n = Math.ceil(direct.length / 12); direct.points = Array.from({ length: n + 1 }, (_, i) => lerp(start, goal, i / n)); direct.method = 'direct'; return direct
    }
    if (['highway', 'collector', 'expressway', 'ramp'].includes(options.role) || distance(start, goal) > 180) {
      const connector = this.endpointConnector(start, goal, options)
      // A physically simple junction connector may beat geographic search, but
      // expensive land still gets the chance to choose a cheaper outer corridor.
      if (connector && connector.cost < direct.cost * 1.08) return connector
      const corridor = this.corridor(start, goal, options)
      return connector && (!corridor || connector.cost < corridor.cost) ? connector : corridor
    }
    const step = 18, bin = Math.PI / 16, quantum = step * .52
    type State = { p: Point; heading: number; cost: number; previous: State | null; arc: Point[]; key: string }
    const stateKey = (p: Point, h: number) => `${Math.round(p.x / quantum)},${Math.round(p.y / quantum)},${(h + 32) % 32}`
    const queue = new MinHeap<State>(), best = new Map<string, number>(), initial = options.startHeading ?? Math.atan2(goal.y - start.y, goal.x - start.x)
    for (const delta of options.startHeading === undefined ? [-2, 0, 2] : [0]) {
      const heading = (Math.round(initial / bin) + delta + 32) % 32, k = stateKey(start, heading), state: State = { p: start, heading, cost: 0, previous: null, arc: [], key: k }
      best.set(k, 0); queue.push(state, distance(start, goal))
    }
    let finish: State | null = null, finalArc: Point[] = []
    const margin = Math.max(220, distance(start, goal) * .35), minX = Math.min(start.x, goal.x) - margin, maxX = Math.max(start.x, goal.x) + margin, minY = Math.min(start.y, goal.y) - margin, maxY = Math.max(start.y, goal.y) + margin
    for (let count = 0; queue.size && count < (options.maxNodes ?? 4600); count++) {
      const item = queue.pop()!, state = item.value
      if (state.cost > (best.get(state.key) ?? Infinity) + .001) continue
      const d = distance(state.p, goal), direction = Math.atan2(goal.y - state.p.y, goal.x - state.p.x)
      if (d < step * 1.8 && Math.abs(turn(direction - state.heading * bin)) < .54 && this.validSegment(state.p, goal, options.width) && this.gradeAllowed([state.p, goal], searchMaximumGrade)) {
        finish = state; const n = Math.max(1, Math.ceil(d / 10)); finalArc = Array.from({ length: n }, (_, i) => lerp(state.p, goal, (i + 1) / n)); break
      }
      for (const delta of [-4, -2, -1, 0, 1, 2, 4]) {
        const change = delta * bin, angle = state.heading * bin, arc: Point[] = []
        for (let j = 1; j <= 4; j++) {
          const t = j / 4
          arc.push(Math.abs(change) < 1e-8 ? { x: state.p.x + Math.cos(angle) * step * t, y: state.p.y + Math.sin(angle) * step * t } : { x: state.p.x + step / change * (Math.sin(angle + change * t) - Math.sin(angle)), y: state.p.y - step / change * (Math.cos(angle + change * t) - Math.cos(angle)) })
        }
        const p = arc.at(-1)!
        if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY || !this.suitable(p, options.width)) continue
        let previous = state.p, allowed = true, routeCost = 0
        for (const q of arc) { if (!this.validSegment(previous, q, options.width)) { allowed = false; break } routeCost += distance(previous, q) * this.field(q).cost + (this.railwayConstraints?.edgeCost(previous, q, options.role) ?? 0) / roadConstructionFactor(options.role); previous = q }
        if (!allowed || !this.gradeAllowed([state.p, ...arc], searchMaximumGrade)) continue
        const heading = (state.heading + delta + 32) % 32, k = stateKey(p, heading), cost = state.cost + routeCost + 3.5 * delta * delta
        if (cost >= (best.get(k) ?? Infinity)) continue
        best.set(k, cost); queue.push({ p, heading, cost, previous: state, arc, key: k }, cost + distance(p, goal))
      }
    }
    if (!finish) return null
    const arcs: Point[][] = []
    for (let current: State | null = finish; current?.previous; current = current.previous) arcs.push(current.arc)
    const points = [start, ...arcs.reverse().flat(), ...finalArc]
    if (roadLength(points) > distance(start, goal) * 2.6) return null
    return this.cost(points, options.role)
  }
}
