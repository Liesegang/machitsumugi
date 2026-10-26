import type { Point, Road, TimelineVersion } from './types'

export type RoadRole = 'highway' | 'collector' | 'lane' | 'access' | 'bridge' | 'farm' | 'expressway' | 'ramp'
export interface SimulatedRoad extends Road { builtYear: number; role: RoadRole; reason: string; bridge?: boolean; phase: string; constructionCost: number }
export interface RoadMetadata { id: string; builtYear: number; role: RoadRole; reason: string; phase: string; width: number; kind: Road['kind']; constructionCost: number; bridge?: boolean; preserveEndpoint?: boolean; level?: number; controlledAccess?: boolean; boundaryContinuation?: boolean; throughRouteId?: string }
export interface RoadProject { points: Point[]; metadata: RoadMetadata; requireConnection?: boolean; modifies?: string }
export interface NormalizedRoadCandidate { readonly points: readonly Readonly<Point>[]; readonly reusedRoadId?: string }
export type RoadInsertionGuard = (candidate: NormalizedRoadCandidate) => boolean
export interface RoadProjection { point: Point; distance: number; road: SimulatedRoad; a: Point; b: Point; t: number }
/** Generalized uncongested speed in m/min; historical impedance is applied by
 * year. Width constrains an actual carriageway, including access streets. A
 * role-only proposal uses its reference section; widening never raises speed
 * above that class's limit. Capacity/junction delays are evaluated separately. */
export const roadTravelSpeed = (road: { role?: string; kind?: Road['kind']; width?: number }) => {
  const base = road.role === 'expressway' ? 1400 : road.role === 'ramp' ? 350 : road.role === 'highway' || (!road.role && road.kind === 'arterial') ? 450 : road.role === 'collector' ? 330 : road.role === 'farm' ? 100 : 220
  const reference = road.role === 'expressway' ? 22 : road.role === 'ramp' ? 7 : road.role === 'highway' || (!road.role && road.kind === 'arterial') ? 13 : road.role === 'collector' ? 8 : road.role === 'access' ? 4.6 : road.role === 'farm' ? 4 : 6
  return base * (road.width !== undefined && Number.isFinite(road.width) && road.width > 0 ? Math.max(.35, Math.min(1, road.width / reference)) : 1)
}
const key = (p: Point) => `${Math.round(p.x * 20)},${Math.round(p.y * 20)}`
export const roadLength = (points: Point[]) => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y), 0)
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
export const controlledRoad = (road: { role?: string; controlledAccess?: boolean }) => !!road.controlledAccess || road.role === 'expressway' || road.role === 'ramp'
/** Ramps are stored from the surface entrance toward the elevated mainline. */
export const roadLevelAt = (road: Pick<Road, 'role' | 'level' | 'points'>, point: Point) => road.role === 'ramp' && dist(road.points[0]!, point) < .04 ? 0 : road.level ?? 0
const routingKey = (road: Pick<Road, 'role' | 'level' | 'points'>, point: Point) => `${roadLevelAt(road, point)}:${key(point)}`
function canConnect(path: Point[], metadata: Pick<Road, 'role' | 'level' | 'controlledAccess'>, other: Road, point: Point) {
  const road = { ...metadata, points: path }
  if (roadLevelAt(road, point) !== roadLevelAt(other, point)) return false
  if (!controlledRoad(road) && !controlledRoad(other)) return true
  const end = (r: Pick<Road, 'points'>) => dist(r.points.at(-1)!, point) < .04
  const first = (r: Pick<Road, 'points'>) => dist(r.points[0]!, point) < .04
  if (road.role === 'ramp') return controlledRoad(other) ? end(road) && other.role !== 'ramp' : first(road)
  if (other.role === 'ramp') return controlledRoad(road) ? end(other) : first(other)
  return controlledRoad(road) && controlledRoad(other) && (first(road) || end(road)) && (first(other) || end(other))
}
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

/** Recover an exact physical T-junction from saved routes without moving either
 * route. Earlier insertion could omit a contact within4cm of a stored vertex,
 * while routing rounded those two positions to different5cm keys. Only an
 * endpoint actually ON another compatible centreline is split here; nearby
 * streets, ordinary line crossings and grade-separated roads are not joined. */
export function materializeRoadJunctions<T extends Road>(roads: readonly T[]): T[] {
  type ContactSegment = { road: T; index: number; a: Point; b: Point }
  const bins = new Map<string, ContactSegment[]>(), epsilon = 1e-7
  const keys = (a: Point, b: Point, pad = 0) => {
    const result: string[] = []
    for (let x = Math.floor((Math.min(a.x, b.x) - pad) / 100); x <= Math.floor((Math.max(a.x, b.x) + pad) / 100); x++) for (let y = Math.floor((Math.min(a.y, b.y) - pad) / 100); y <= Math.floor((Math.max(a.y, b.y) + pad) / 100); y++) result.push(`${x}:${y}`)
    return result
  }
  for (const road of roads) for (let i = 1; i < road.points.length; i++) {
    const segment = { road, index: i, a: road.points[i - 1]!, b: road.points[i]! }
    for (const k of keys(segment.a, segment.b)) { const bucket = bins.get(k) ?? []; bucket.push(segment); bins.set(k, bucket) }
  }
  const cuts = new Map<T, Map<number, { point: Point; t: number }[]>>()
  for (const road of roads) for (const point of [road.points[0], road.points.at(-1)]) {
    if (!point) continue
    const nearby = new Set<ContactSegment>()
    for (const k of keys(point, point, epsilon)) for (const segment of bins.get(k) ?? []) nearby.add(segment)
    for (const segment of nearby) {
      if (segment.road === road || !canConnect(road.points, road, segment.road, point) || dist(point, segment.a) < epsilon || dist(point, segment.b) < epsilon) continue
      const projection = projectOnRoadSegment(point, segment.a, segment.b)
      if (projection.t <= 0 || projection.t >= 1 || dist(point, projection.point) > epsilon) continue
      const bySegment = cuts.get(segment.road) ?? new Map<number, { point: Point; t: number }[]>(), sites = bySegment.get(segment.index) ?? []
      if (!sites.some(site => dist(site.point, point) < epsilon)) sites.push({ point, t: projection.t })
      bySegment.set(segment.index, sites); cuts.set(segment.road, bySegment)
    }
  }
  return roads.map(road => {
    const bySegment = cuts.get(road)
    if (!bySegment) return road
    const points: Point[] = [road.points[0]!]
    for (let i = 1; i < road.points.length; i++) {
      for (const cut of (bySegment.get(i) ?? []).sort((a, b) => a.t - b.t)) points.push({ ...cut.point })
      points.push(road.points[i]!)
    }
    return { ...road, points }
  })
}
type Segment = { a: Point; b: Point; road: SimulatedRoad }

/** Mutable planar graph; inserting a junction only subdivides an existing immutable route. */
export class PlanarRoadGraph {
  readonly roads: SimulatedRoad[] = []
  private retiredVersions: TimelineVersion<SimulatedRoad>[] = []
  private versionStart = new Map<string, number>()
  /** Geometry is detached from mutable junction insertion and later upgrades. */
  get roadHistory(): TimelineVersion<SimulatedRoad>[] {
    return [...this.retiredVersions, ...this.roads.map(road => ({ from: this.versionStart.get(road.id) ?? road.builtYear, value: { ...road, points: road.points.map(p => ({ ...p })) } }))]
  }
  // Raw appends require fallback until rebuilding the index. Direct same-length
  // array replacement is unsupported, as with the graph's other spatial queries.
  private indexedRoadCount = 0
  private segments: Segment[] = []
  private buckets = new Map<string, Segment[]>()
  private revision = 0
  /** Invalidates traffic assignment after a real junction or road change. */
  get topologyRevision() { return this.revision }
  private routingRevision = -1
  private routing: { points: Point[]; nodes: Map<string, number>; adjacency: { to: number; time: number; length: number }[][] } | null = null
  private queryRevision = -1
  private nearestQueries = new Map<string, RoadProjection | null>()
  private projectionQueries = new Map<string, number>()
  private projectionResults = new Map<string, RoadProjection[]>()
  private accessibilityQueries = new Map<string, (point: Point) => number>()
  private syncQueries() {
    if (this.queryRevision === this.revision) return
    this.nearestQueries.clear(); this.projectionQueries.clear(); this.projectionResults.clear(); this.accessibilityQueries.clear()
    this.queryRevision = this.revision
  }
  private remember<T>(cache: Map<string, T>, k: string, value: T, limit = 8192) {
    if (cache.size >= limit) cache.delete(cache.keys().next().value!)
    cache.set(k, value)
    return value
  }
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
    this.syncQueries()
    const queryKey = `${p.x}:${p.y}:${radius}`
    if (this.nearestQueries.has(queryKey)) return this.nearestQueries.get(queryKey)!
    // A point with a street within80m never needs the entire450m access radius.
    // The square query contains every point within its radius, so returning a
    // hit is exact; expanding only an empty radius changes cost, not geometry.
    let previous = -1
    for (const search of [Math.min(80, radius), Math.min(240, radius), radius]) {
      if (search === previous) continue
      previous = search
      const candidates = Number.isFinite(search) ? this.nearby(p, p, search) : this.segments
      let nearest: RoadProjection | null = null, best = search
      for (const s of candidates) { if (controlledRoad(s.road)) continue; const projection = projectOnRoadSegment(p, s.a, s.b), distance = dist(p, projection.point); if (distance > best) continue; best = distance; nearest = { ...projection, distance, road: s.road, a: s.a, b: s.b } }
      if (nearest) return this.remember(this.nearestQueries, queryKey, nearest)
    }
    return this.remember(this.nearestQueries, queryKey, null)
  }
  projections(p: Point, radius: number, count = 12): RoadProjection[] {
    this.syncQueries()
    const queryKey = `${p.x}:${p.y}:${radius}:${count}`
    // Retain exact survey sites only while their road geometry is unchanged.
    // Callers own the result array, projection records and projected points;
    // the road reference still identifies the actual graph-owned corridor.
    const copy = (hits: RoadProjection[]) => hits.map(hit => ({ ...hit, point: { ...hit.point } }))
    const cached = this.projectionResults.get(queryKey)
    if (cached) return copy(cached)
    const candidates = Number.isFinite(radius) ? this.nearby(p, p, radius) : this.segments
    const hits: RoadProjection[] = []
    for (const s of candidates) {
      if (controlledRoad(s.road)) continue
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
    this.remember(this.projectionResults, queryKey, selected, 2048)
    return copy(selected)
  }
  /** Exact junction sites along a proposed survey line, in chainage order. */
  crossings(a: Point, b: Point): { point: Point; road: SimulatedRoad; t: number }[] {
    const hits: { point: Point; road: SimulatedRoad; t: number }[] = []
    for (const segment of this.nearby(a, b, .05)) {
      if (controlledRoad(segment.road)) continue
      const hit = intersect(a, b, segment.a, segment.b)
      if (hit && !hits.some(other => dist(other.point, hit.point) < .05)) hits.push({ ...hit, road: segment.road })
    }
    return hits.sort((x, y) => x.t - y.t || x.road.id.localeCompare(y.road.id))
  }
  private headingsAt(point: Point) {
    const arms: number[] = []
    for (const segment of this.nearby(point, point, .1)) {
      if (controlledRoad(segment.road) && !(segment.road.role === 'ramp' && dist(segment.road.points[0]!, point) < .05)) continue
      if (dist(projectOnRoadSegment(point, segment.a, segment.b).point, point) > .05) continue
      for (const end of [segment.a, segment.b]) {
        if (dist(end, point) < .05) continue
        const angle = Math.atan2(end.y - point.y, end.x - point.x)
        if (!arms.some(other => Math.abs(Math.atan2(Math.sin(angle - other), Math.cos(angle - other))) < .03)) arms.push(angle)
      }
    }
    return arms
  }
  /** Tangent for extending a physical degree-one road end, not turning at a junction. */
  openEndHeading(point: Point): number | undefined {
    const arms = this.headingsAt(point)
    return arms.length === 1 ? Math.atan2(Math.sin(arms[0]! + Math.PI), Math.cos(arms[0]! + Math.PI)) : undefined
  }
  /** Departure into a junction's free sector. Null means this node is crowded. */
  junctionHeading(point: Point, toward: Point): number | null {
    const arms = this.headingsAt(point), desired = Math.atan2(toward.y - point.y, toward.x - point.x)
    if (!arms.length) return null
    if (arms.length === 1) return Math.atan2(Math.sin(arms[0]! + Math.PI), Math.cos(arms[0]! + Math.PI))
    const difference = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))
    const candidates = arms.flatMap(angle => [angle + Math.PI / 2, angle - Math.PI / 2])
      .filter(angle => arms.every(arm => difference(angle, arm) >= Math.PI * 70 / 180))
      .sort((a, b) => difference(a, desired) - difference(b, desired))
    return candidates[0] ?? null
  }
  /** A new major street may not create a needle-shaped oblique crossing. */
  hasAcuteMajorCrossing(path: Point[], minimumDegrees = 50) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, length = dist(a, b)
      if (length < .01) continue
      for (const segment of this.nearby(a, b, .05)) {
        if (controlledRoad(segment.road)) continue
        if (segment.road.kind !== 'arterial' && segment.road.width < 9) continue
        const hit = intersect(a, b, segment.a, segment.b)
        if (!hit || dist(hit.point, path[0]!) < .15 || dist(hit.point, path.at(-1)!) < .15) continue
        const oldLength = dist(segment.a, segment.b)
        const cosine = Math.min(1, Math.abs(((b.x - a.x) * (segment.b.x - segment.a.x) + (b.y - a.y) * (segment.b.y - segment.a.y)) / (length * oldLength)))
        if (Math.acos(cosine) * 180 / Math.PI < minimumDegrees) return true
      }
    }
    return false
  }
  private insert(road: SimulatedRoad, point: Point) {
    if (road.points.some(p => dist(p, point) < 1e-7)) return
    for (let i = 1; i < road.points.length; i++) {
      const projection = projectOnRoadSegment(point, road.points[i - 1]!, road.points[i]!)
      if (dist(point, projection.point) < 1e-7 && projection.t > 0 && projection.t < 1) { road.points.splice(i, 0, point); return }
    }
  }
  /** Mark an exactly on-street transport entrance without shifting the old road. */
  ensureJunction(point: Point) {
    const near = this.nearest(point, 1e-7)
    if (!near) return false
    if (!near.road.points.some(p => dist(p, point) < 1e-7)) for (let i = 1; i < near.road.points.length; i++) if (dist(projectOnRoadSegment(point, near.road.points[i - 1]!, near.road.points[i]!).point, point) < 1e-7) { near.road.points.splice(i, 0, { ...point }); break }
    this.revision++; return true
  }
  /** A surveyed section already owned at sufficient width is reused, including
   * a reverse traversal of a short bridge deck. This is not a second capacity
   * edge or a new dated construction. A wider request still needs modify(). */
  reusableRoad(path: Point[], metadata: Pick<RoadMetadata, 'width' | 'role' | 'level' | 'controlledAccess' | 'bridge'>): SimulatedRoad | null {
    if (path.length < 2) return null
    const first = path[0]!, last = path.at(-1)!, proposal = { ...metadata, points: path }
    const covered = (points: Point[], route: Point[]) => points.every(point => route.slice(1).some((end, i) => dist(projectOnRoadSegment(point, route[i]!, end).point, point) <= .04))
    const candidates = this.indexedRoadCount === this.roads.length
      ? [...new Set([...this.nearby(first, first, .04)].map(segment => segment.road))].sort((a, b) => this.roads.indexOf(a) - this.roads.indexOf(b))
      : this.roads
    for (const road of candidates) {
      if (road.width + 1e-7 < metadata.width || controlledRoad(road) !== controlledRoad(metadata) || !!(road.bridge || road.role === 'bridge') !== !!(metadata.bridge || metadata.role === 'bridge')) continue
      const sameEnds = dist(first, road.points[0]!) < .04 && dist(last, road.points.at(-1)!) < .04
      const reversedEnds = dist(first, road.points.at(-1)!) < .04 && dist(last, road.points[0]!) < .04
      if ((!sameEnds && !reversedEnds) || roadLevelAt(proposal, first) !== roadLevelAt(road, first) || roadLevelAt(proposal, last) !== roadLevelAt(road, last)) continue
      if (Math.abs(roadLength(path) - roadLength(road.points)) > .08 || !covered(path, road.points) || !covered(road.points, path)) continue
      return road
    }
    return null
  }
  /** All crossings are real shared vertices; a road may connect two older roads to close a loop. */
  add(path: Point[], metadata: RoadMetadata, requireConnection = true, beforeCommit?: RoadInsertionGuard): SimulatedRoad | null {
    if (path.length < 2 || roadLength(path) < (metadata.preserveEndpoint ? 1e-7 : metadata.role === 'bridge' ? .01 : 20)) return null
    path = path.map(p => ({ ...p }))
    for (const i of [0, path.length - 1]) { if (controlledRoad(metadata) || (i === path.length - 1 && metadata.preserveEndpoint)) continue; const near = this.nearest(path[i]!, 1); if (near) path[i] = near.point }
    const existing = this.reusableRoad(path, metadata)
    if (existing) {
      if (beforeCommit && !beforeCommit(Object.freeze({ points: Object.freeze(existing.points.map(point => Object.freeze({ ...point }))), reusedRoadId: existing.id }))) return null
      return existing
    }
    if (requireConnection && this.roads.length && !this.nearest(path[0]!, .15)) return null
    const normalized: Point[] = [path[0]!], junctions: { road: SimulatedRoad; point: Point }[] = []
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, hits: { point: Point; t: number }[] = []
      for (const s of this.nearby(a, b, .05)) {
        const cross = intersect(a, b, s.a, s.b)
        if (!cross || !canConnect(path, metadata, s.road, cross.point)) continue
        hits.push(cross); junctions.push({ road: s.road, point: cross.point })
      }
      hits.sort((x, y) => x.t - y.t)
      for (const hit of hits) if (dist(normalized.at(-1)!, hit.point) > 1e-7) normalized.push(hit.point)
      if (dist(normalized.at(-1)!, b) > (metadata.preserveEndpoint && i === path.length - 1 ? 1e-8 : .04)) normalized.push(b)
    }
    if (normalized.length < 2) return null
    // An already existing corridor is maintenance, not a second newly built parallel street.
    let covered = 0, samples = 0
    for (let i = 1; i < normalized.length; i++) {
      const middle = at(normalized[i - 1]!, normalized[i]!, .5)
      samples++; if (!controlledRoad(metadata) && this.nearest(middle, metadata.width * .5 + 2)) covered++
    }
    if (samples > 3 && covered / samples > .72) return null
    // Normalization may snap an endpoint or remove a sub-4cm bend. Validate
    // exactly the eventual saved geometry before changing ANY old junction,
    // version, road record or spatial index. Detached frozen copies prevent a
    // guard from accidentally mutating either the old or staged geometry.
    if (beforeCommit && !beforeCommit(Object.freeze({ points: Object.freeze(normalized.map(point => Object.freeze({ ...point }))) }))) return null
    const road: SimulatedRoad = { id: metadata.id, points: normalized, kind: metadata.kind, width: metadata.width, builtYear: metadata.builtYear, role: metadata.role, phase: metadata.phase, reason: metadata.reason, constructionCost: metadata.constructionCost, ...(metadata.bridge ? { bridge: true } : {}), ...(metadata.level !== undefined ? { level: metadata.level } : {}), ...(metadata.controlledAccess ? { controlledAccess: true } : {}), ...(metadata.boundaryContinuation ? { boundaryContinuation: true } : {}), ...(metadata.throughRouteId ? { throughRouteId: metadata.throughRouteId } : {}) }
    for (const junction of junctions) this.insert(junction.road, junction.point)
    // Explicit endpoint snaps also split old curves even if the new path is tangent at the connection.
    for (const endpoint of controlledRoad(metadata) ? [] : [normalized[0]!, normalized.at(-1)!]) {
      const near = this.nearest(endpoint, .15)
      if (near) this.insert(near.road, endpoint)
    }
    this.roads.push(road)
    this.versionStart.set(road.id, metadata.builtYear)
    for (let i = 1; i < normalized.length; i++) {
      const segment = { a: normalized[i - 1]!, b: normalized[i]!, road }
      this.segments.push(segment)
      for (const k of this.keys(segment.a, segment.b)) { const bucket = this.buckets.get(k) ?? []; bucket.push(segment); this.buckets.set(k, bucket) }
    }
    this.indexedRoadCount++
    this.revision++
    return road
  }
  fork() {
    const staged = new PlanarRoadGraph()
    staged.retiredVersions = [...this.retiredVersions]
    staged.versionStart = new Map(this.versionStart)
    // Normal graphs already have an index and exact shared contacts. Raw saved
    // roads need this one import normalization, rather than every planning fork.
    const roads = this.segments.length ? this.roads : materializeRoadJunctions(this.roads)
    staged.roads.push(...roads.map(road => ({ ...road, points: road.points.map(p => ({ ...p })) })))
    for (const road of staged.roads) for (let i = 1; i < road.points.length; i++) {
      const segment = { a: road.points[i - 1]!, b: road.points[i]!, road }
      staged.segments.push(segment)
      for (const k of staged.keys(segment.a, segment.b)) { const bucket = staged.buckets.get(k) ?? []; bucket.push(segment); staged.buckets.set(k, bucket) }
    }
    staged.indexedRoadCount = staged.roads.length
    return staged
  }
  /** Infrastructure with several mandatory accesses is committed atomically.
   * A failed ramp may not leave an inaccessible mainline in the city history. */
  addBatch(projects: RoadProject[]): SimulatedRoad[] | null {
    const staged = this.fork()
    const added: SimulatedRoad[] = []
    for (const project of projects) {
      if (project.modifies && project.metadata.id !== project.modifies) return null
      const road = project.modifies
        ? staged.modify(project.modifies, project.metadata.builtYear, { points: project.points, width: project.metadata.width, role: project.metadata.role, kind: project.metadata.kind, phase: project.metadata.phase, reason: project.metadata.reason, constructionCost: project.metadata.constructionCost, ...(project.metadata.boundaryContinuation !== undefined ? { boundaryContinuation: project.metadata.boundaryContinuation } : {}) })
        : staged.add(project.points, project.metadata, project.requireConnection ?? true)
      if (!road) return null
      added.push(road)
    }
    this.roads.splice(0, this.roads.length, ...staged.roads)
    this.retiredVersions = staged.retiredVersions; this.versionStart = staged.versionStart
    this.indexedRoadCount = staged.indexedRoadCount
    this.segments = staged.segments; this.buckets = staged.buckets; this.revision++; this.routing = null
    return added
  }
  /** A funded modification keeps its identity/opening date and archives its old
   * cross-section. All existing junctions must remain on the replacement route. */
  modify(id: string, year: number, change: { points?: Point[]; width: number; role?: RoadRole; kind?: Road['kind']; phase?: string; reason: string; constructionCost: number; boundaryContinuation?: boolean }): SimulatedRoad | null {
    const previous = this.roads.find(road => road.id === id)
    if (!previous || year <= (this.versionStart.get(id) ?? previous.builtYear) || !Number.isFinite(change.width) || change.width <= 0 || !Number.isFinite(change.constructionCost) || change.constructionCost < 0) return null
    const points = (change.points ?? previous.points).map(p => ({ ...p }))
    if (points.length < 2 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null
    // A relocated section cannot sever a branch or quietly move its junction.
    const required = previous.points.filter((point, i) => i === 0 || i === previous.points.length - 1 || this.roads.some(road => road !== previous && road.points.some(p => dist(p, point) < .04)))
    for (const point of required) if (!points.slice(1).some((end, i) => dist(projectOnRoadSegment(point, points[i]!, end).point, point) < .04)) return null
    for (const point of required) if (!points.some(p => dist(p, point) < 1e-7)) for (let i = 1; i < points.length; i++) if (dist(projectOnRoadSegment(point, points[i - 1]!, points[i]!).point, point) < .04) { points.splice(i, 0, { ...point }); break }
    this.retiredVersions.push({ from: this.versionStart.get(id) ?? previous.builtYear, to: year, value: { ...previous, points: previous.points.map(p => ({ ...p })) } })
    this.versionStart.set(id, year)
    const updated = { ...previous, ...change, points, modifiedYear: year }
    this.roads[this.roads.indexOf(previous)] = updated
    this.segments = []; this.buckets.clear()
    for (const road of this.roads) for (let i = 1; i < road.points.length; i++) {
      const segment = { a: road.points[i - 1]!, b: road.points[i]!, road }
      this.segments.push(segment)
      for (const k of this.keys(segment.a, segment.b)) { const bucket = this.buckets.get(k) ?? []; bucket.push(segment); this.buckets.set(k, bucket) }
    }
    this.indexedRoadCount = this.roads.length
    this.revision++
    return updated
  }
  private buildRouting() {
    if (this.routing && this.routingRevision === this.revision) return this.routing
    const membership = new Map<string, Set<string>>(), endpoints = new Set<string>()
    for (const road of this.roads) {
      endpoints.add(routingKey(road, road.points[0]!)); endpoints.add(routingKey(road, road.points.at(-1)!))
      for (const p of road.points) { const k = routingKey(road, p), found = membership.get(k) ?? new Set<string>(); found.add(road.id); membership.set(k, found) }
    }
    const points: Point[] = [], nodes = new Map<string, number>(), adjacency: { to: number; time: number; length: number }[][] = []
    const node = (point: Point, road: SimulatedRoad) => { const k = routingKey(road, point); if (!nodes.has(k)) { nodes.set(k, points.length); points.push(point); adjacency.push([]) } return nodes.get(k)! }
    for (const road of this.roads) {
      let previous = node(road.points[0]!, road), length = 0
      const speed = roadTravelSpeed(road)
      for (let i = 1; i < road.points.length; i++) {
        const p = road.points[i]!, k = routingKey(road, p); length += dist(road.points[i - 1]!, p)
        if (!endpoints.has(k) && (membership.get(k)?.size ?? 0) < 2) continue
        const next = node(p, road)
        if (next !== previous) { adjacency[previous]!.push({ to: next, time: length / speed, length }); adjacency[next]!.push({ to: previous, time: length / speed, length }) }
        previous = next; length = 0
      }
    }
    this.routingRevision = this.revision
    return this.routing = { points, nodes, adjacency }
  }
  /** Minutes over the street network; off-road access is walking at 75m/min. */
  accessibilityFrom(origin: Point): (point: Point) => number {
    this.syncQueries()
    const queryKey = `${origin.x}:${origin.y}`
    const previous = this.accessibilityQueries.get(queryKey)
    if (previous) return previous
    const revision = this.revision, values = new Map<string, number>()
    const graph = this.buildRouting(), times = new Float64Array(graph.points.length).fill(Infinity)
    const checkpoints = new Map<SimulatedRoad, { point: Point; along: number; index: number }[]>()
    const positions = (near: RoadProjection) => {
      let along = 0
      const projectionKey = `${near.road.id}:${near.point.x}:${near.point.y}`
      let projectionAlong = this.projectionQueries.get(projectionKey)
      if (projectionAlong === undefined) {
        projectionAlong = 0
        for (let i = 1; i < near.road.points.length; i++) { const a = near.road.points[i - 1]!, b = near.road.points[i]!, n = dist(a, b); if (dist(projectOnRoadSegment(near.point, a, b).point, near.point) < .05) { projectionAlong = along + dist(a, near.point); break } along += n }
        this.remember(this.projectionQueries, projectionKey, projectionAlong)
      }
      let nodes = checkpoints.get(near.road)
      if (!nodes) {
        nodes = []; along = 0
        for (let i = 0; i < near.road.points.length; i++) { const p = near.road.points[i]!, index = graph.nodes.get(routingKey(near.road, p)); if (index !== undefined) nodes.push({ point: p, along, index }); if (i + 1 < near.road.points.length) along += dist(p, near.road.points[i + 1]!) }
        checkpoints.set(near.road, nodes)
      }
      return { nodes, projectionAlong, speed: roadTravelSpeed(near.road) }
    }
    const originProjection = this.nearest(origin)
    if (!originProjection) return this.remember(this.accessibilityQueries, queryKey, (point: Point) => revision === this.revision ? Infinity : this.accessibilityFrom(origin)(point), 64)
    const source = positions(originProjection), heap = new MinHeap<number>()
    for (const node of source.nodes) { times[node.index] = Math.abs(node.along - source.projectionAlong) / source.speed + originProjection.distance / 75; heap.push(node.index, times[node.index]!) }
    while (heap.size) {
      const item = heap.pop()!, n = item.value
      if (item.priority > times[n]!) continue
      for (const edge of graph.adjacency[n]!) { const value = times[n]! + edge.time; if (value >= times[edge.to]!) continue; times[edge.to] = value; heap.push(edge.to, value) }
    }
    const time = (point: Point) => {
      if (revision !== this.revision) return this.accessibilityFrom(origin)(point)
      const pointKey = `${point.x}:${point.y}`
      const cached = values.get(pointKey)
      if (cached !== undefined) return cached
      const nearest = this.nearest(point, 450), nearby = nearest ? [nearest] : []
      let best = Infinity
      for (const near of nearby) {
        const road = positions(near)
        for (const node of road.nodes) best = Math.min(best, times[node.index]! + Math.abs(node.along - road.projectionAlong) / road.speed + near.distance / 75)
        if (near.road === originProjection.road) best = Math.min(best, originProjection.distance / 75 + Math.abs(road.projectionAlong - source.projectionAlong) / road.speed + near.distance / 75)
      }
      return this.remember(values, pointKey, best, 4096)
    }
    return this.remember(this.accessibilityQueries, queryKey, time, 64)
  }
  travelTime(a: Point, b: Point) {
    const graph = this.buildRouting(), from = this.nearest(a), to = this.nearest(b)
    if (!from || !to) return Infinity
    const checkpoints = (projection: RoadProjection) => {
      const points = projection.road.points, nodes: { index: number; along: number }[] = []
      let along = 0, at = 0
      for (let i = 0; i < points.length; i++) {
        const index = graph.nodes.get(routingKey(projection.road, points[i]!)); if (index !== undefined) nodes.push({ index, along })
        if (i + 1 < points.length) { const next = points[i + 1]!, hit = projectOnRoadSegment(projection.point, points[i]!, next); if (dist(hit.point, projection.point) < .05) at = along + dist(points[i]!, hit.point); along += dist(points[i]!, next) }
      }
      const speed = roadTravelSpeed(projection.road)
      return { nodes: nodes.map(node => ({ index: node.index, cost: Math.abs(node.along - at) / speed + projection.distance / 75 })), at, speed }
    }
    const source = checkpoints(from), destination = checkpoints(to), exits = new Map(destination.nodes.map(node => [node.index, node.cost]))
    let answer = from.road === to.road ? Math.abs(source.at - destination.at) / source.speed + (from.distance + to.distance) / 75 : Infinity
    const times = new Float64Array(graph.points.length).fill(Infinity), queue = new MinHeap<number>()
    for (const node of source.nodes) { times[node.index] = node.cost; queue.push(node.index, node.cost + dist(graph.points[node.index]!, b) / 1400) }
    while (queue.size) {
      const next = queue.pop()!, node = next.value
      if (next.priority >= answer) break
      const exit = exits.get(node); if (exit !== undefined) answer = Math.min(answer, times[node]! + exit)
      for (const edge of graph.adjacency[node]!) { const time = times[node]! + edge.time; if (time >= times[edge.to]!) continue; times[edge.to] = time; queue.push(edge.to, time + dist(graph.points[edge.to]!, b) / 1400) }
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
export function extractStreetBlocks(roads: Road[], minimumArea = 150): Point[][] {
  type Edge = { from: string; to: string; a: Point; b: Point; angle: number; reverse: Edge | null; used: boolean }
  const outgoing = new Map<string, Edge[]>(), edges: Edge[] = [], unique = new Set<string>()
  for (const road of roads.filter(road => !controlledRoad(road))) for (let i = 1; i < road.points.length; i++) {
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
    while (changed && polygon.length > 2) {
      changed = false
      for (let i = 0; i < polygon.length; i++) {
        const previous = polygon[(i + polygon.length - 1) % polygon.length]!, current = polygon[i]!, next = polygon[(i + 1) % polygon.length]!
        // Removing a reversed tree tip leaves J,J. Collapse that same graph
        // node as well, so nested/T/Y excursions can unwind all the way back
        // to the real perimeter rather than leaving a weakly-simple spike.
        if (key(current) === key(next) || key(previous) === key(next)) { polygon.splice(i, 1); changed = true; break }
      }
    }
    const area = polygon.reduce((sum, p, i) => sum + p.x * polygon[(i + 1) % polygon.length]!.y - polygon[(i + 1) % polygon.length]!.x * p.y, 0) / 2
    if (area > minimumArea) faces.push(polygon)
  }
  return faces
}
