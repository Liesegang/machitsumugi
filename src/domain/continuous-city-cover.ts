import polygonClipping from 'polygon-clipping'
import ClipperLib from 'clipper-lib'
import type { Path, PolyNode } from 'clipper-lib'
import type { Area, CityConfig, Parcel, Point, Road } from './types'
import type { Bounds, PolygonRegion } from './geometry'
import type { TerrainModel } from './terrain'
import type { ContinuousCityDemand } from './continuous-city-types'
import { boundsOf, distance, distanceToSegment, intersectRegions, overlaps, pathPointAt, pointInRegion, rectangle, regionArea, subtractRegions } from './geometry'
import { contourLand } from './land-use'
import { PROJECT_GEOMETRY_LIMITS } from './project'
import { subdivideContinuousFarmDistrict } from './continuous-city-farm-plots'

const { union } = polygonClipping

/** Working-union diagnostics, never source stock edits. The fixed survey
 * lattice can collapse floating sweep noise; its raw fill is recorded. */
export const continuousCoverDiagnostics = { collapsedRings: 0, collapsedHoles: 0, collapsedRawFilledArea: 0, maximumGridSpacing: 0, exactAreaFallbacks: 0, zeroSignedPositiveRings: 0, canonicalizationFallbacks: 0 }
const localArea = (ring: readonly Point[]) => {
  const origin = ring[0]
  return origin ? ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]!; return sum + (p.x - origin.x) * (q.y - origin.y) - (q.x - origin.x) * (p.y - origin.y) }, 0) / 2 : 0
}
function exactIntegerAreaSign(path: Path) {
  const origin = path[0]!
  let local = 0, magnitude = 0
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!, q = path[(i + 1) % path.length]!, a = (p.X - origin.X) * (q.Y - origin.Y), b = (q.X - origin.X) * (p.Y - origin.Y)
    local += a - b; magnitude += Math.abs(a) + Math.abs(b)
  }
  // The translated shoelace avoids city-coordinate cancellation. Only a sign
  // beyond this conservative floating error bound is trusted; doubtful sums
  // use the exact integer determinant, including nonzero grid-sized slivers.
  if (Math.abs(local) > magnitude * Number.EPSILON * (path.length + 4) * 4) return Math.sign(local)
  continuousCoverDiagnostics.exactAreaFallbacks++
  let twice = 0n
  for (let i = 0; i < path.length; i++) { const p = path[i]!, q = path[(i + 1) % path.length]!; twice += BigInt(p.X) * BigInt(q.Y) - BigInt(q.X) * BigInt(p.Y) }
  return twice < 0n ? -1 : twice > 0n ? 1 : 0
}
function coverGrid(parts: readonly PolygonRegion[], boundaries: readonly PolygonRegion[] = []) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const region of [...parts, ...boundaries]) for (const p of region.polygon) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
  const origin = { x: Math.round((minX + maxX) / 2 * 5000) / 5000, y: Math.round((minY + maxY) / 2 * 5000) / 5000 }
  const reach = Math.max(maxX - origin.x, origin.x - minX, maxY - origin.y, origin.y - minY)
  return { origin, scale: reach * 10000 < 47453100 ? 10000 : 5000 }
}
function gridRing(ring: readonly Point[], grid: ReturnType<typeof coverGrid>) {
  const path = ring.map(p => ({ X: Math.round((p.x - grid.origin.x) * grid.scale), Y: Math.round((p.y - grid.origin.y) * grid.scale) })).filter((p, i, all) => !i || p.X !== all[i - 1]!.X || p.Y !== all[i - 1]!.Y)
  if (path.length > 1 && path[0]!.X === path.at(-1)!.X && path[0]!.Y === path.at(-1)!.Y) path.pop()
  if (path.length < 3) return { paths: [] as Path[], simplified: false }
  if (exactIntegerAreaSign(path) !== 0) return { paths: [path], simplified: false }
  // Signed zero is NOT filled zero: a figure eight has two positive lobes.
  // A single integer-ring simplification resolves its fill before deciding.
  const paths = ClipperLib.Clipper.SimplifyPolygon(path, ClipperLib.PolyFillType.pftNonZero)
  if (paths.length) continuousCoverDiagnostics.zeroSignedPositiveRings++
  return { paths, simplified: true }
}
function recordCollapsedRing(ring: Point[], hole: boolean, scale: number) {
  continuousCoverDiagnostics.collapsedRings++; continuousCoverDiagnostics.collapsedHoles += Number(hole)
  continuousCoverDiagnostics.maximumGridSpacing = Math.max(continuousCoverDiagnostics.maximumGridSpacing, 1 / scale)
  const origin = ring[0]
  if (!origin || ring.length < 3) return
  // Translate this one tiny contour before measuring. Global shoelaces can
  // cancel its positive 1e-12m² fill at city coordinates near 5km.
  const local = ring.map(p => [p.x - origin.x, p.y - origin.y] as [number, number])
  const geometry = union([local])
  continuousCoverDiagnostics.collapsedRawFilledArea += geometry.reduce((sum, rings) => sum + Math.abs(localArea(rings[0]!.map(([x, y]) => ({ x, y })))) - rings.slice(1).reduce((holes, h) => holes + Math.abs(localArea(h.map(([x, y]) => ({ x, y })))), 0), 0)
}
function workingCoverRegions(parts: readonly PolygonRegion[], grid: ReturnType<typeof coverGrid>) {
  return parts.flatMap(part => {
    if (!gridRing(part.polygon, grid).paths.length) { recordCollapsedRing(part.polygon, false, grid.scale); return [] }
    const holes = (part.holes ?? []).filter(hole => { if (gridRing(hole, grid).paths.length) return true; recordCollapsedRing(hole, true, grid.scale); return false })
    return holes.length === (part.holes?.length ?? 0) ? [part] : [{ polygon: part.polygon, ...(holes.length ? { holes } : {}) }]
  })
}

export interface ContinuousCityCoverInput {
  config: CityConfig
  width: number
  height: number
  terrain: Pick<TerrainModel, 'areas' | 'elevation' | 'slope' | 'waterAt'> & Partial<Pick<TerrainModel, 'wetness' | 'channelAt' | 'rivers' | 'cultivable'>>
  demand: ContinuousCityDemand
  roads: readonly Road[]
  parcels: readonly Parcel[]
  reserves: readonly PolygonRegion[]
  urbanBlocks: readonly PolygonRegion[]
  onProgress?: (label: string) => void
  onGeometry?: (stage: string, parts: readonly PolygonRegion[]) => void
}
/** Integer Vatti union is independent of the floating sweep which can exceed
 * its event queue on thousands of almost-touching title verges. Source water
 * never passes through this operation; its exact objects remain unchanged. */
function integerCoverBoolean(parts: readonly PolygonRegion[], boundaries: readonly PolygonRegion[] = [], operation: 'union' | 'intersection' | 'difference' = 'union', strictlySimple = false): PolygonRegion[] {
  if (!parts.length) return []
  // Clipper.js switches to Int128 above47,453,132, far below the C++ limit.
  // A local origin keeps ordinary blocks and4x3km crops in the fast range.
  // The widest12km crop uses0.2mm; normal source geometry uses0.1mm already.
  const grid = coverGrid(parts, boundaries), { origin, scale } = grid
  const pathsAt = (regions: readonly PolygonRegion[]): Path[] => {
    const paths: Path[] = []
    for (const region of workingCoverRegions(regions, grid)) for (const [index, ring] of [region.polygon, ...(region.holes ?? [])].entries()) {
      const resolved = gridRing(ring, grid)
      for (const path of resolved.paths) {
        if (resolved.simplified ? index > 0 : (exactIntegerAreaSign(path) > 0) !== (index === 0)) path.reverse()
        paths.push(path)
      }
    }
    return paths
  }
  const subjects = pathsAt(parts), clips = pathsAt(boundaries)
  if (!subjects.length || operation === 'intersection' && !clips.length) return []
  const engine = new ClipperLib.Clipper(), tree = new ClipperLib.PolyTree()
  // Clipper's optional DoSimplePolygons pass repeatedly splits the native
  // cadastre's touching hole vertices, exploding23k vertices into260k. The
  // default Vatti PolyTree already retains the same filled set and hole tree.
  engine.StrictlySimple = strictlySimple
  if (!engine.AddPaths(subjects, ClipperLib.PolyType.ptSubject, true)) throw new Error('被覆境界の整数入力がありません。')
  if (boundaries.length) engine.AddPaths(clips, ClipperLib.PolyType.ptClip, true)
  const type = operation === 'difference' ? ClipperLib.ClipType.ctDifference : operation === 'intersection' ? ClipperLib.ClipType.ctIntersection : ClipperLib.ClipType.ctUnion
  if (!engine.Execute(type, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) throw new Error('被覆境界の整数演算に失敗しました。')
  const result: PolygonRegion[] = [], ring = (node: PolyNode) => node.Contour().map(p => ({ x: p.X / scale + origin.x, y: p.Y / scale + origin.y }))
  const visit = (node: PolyNode) => {
    if (!node.IsHole() && node.Contour().length >= 3) {
      const holes = node.Childs().filter(c => c.IsHole()).map(ring)
      result.push({ polygon: ring(node), ...(holes.length ? { holes } : {}) })
    }
    for (const child of node.Childs()) visit(child)
  }
  visit(tree)
  return result
}
/** Ordinary small components retain the fast floating implementation. A fixed
 * vertex ceiling prevents restoring its failed whole-city event queue; any
 * numerical failure and every larger merge use the independent integer path. */
function joinCoverParts(parts: readonly PolygonRegion[]): PolygonRegion[] {
  if (!parts.length) return []
  parts = workingCoverRegions(parts, coverGrid(parts))
  if (!parts.length) return []
  const count = parts.reduce((sum, p) => sum + p.polygon.length + (p.holes ?? []).reduce((n, h) => n + h.length, 0), 0)
  if (count <= 12000) {
    try {
      const geometry = union(parts.map(p => [p.polygon, ...(p.holes ?? [])].map(ring => [...ring, ring[0]!].map(q => [q.x, q.y] as [number, number]))))
      if (!geometry.length) throw new Error('Empty nonempty cover union')
      return geometry.map(rings => {
        if (rings.some(ring => ring.length < 4)) throw new Error('Invalid cover union ring')
        const polygon = rings[0]!.slice(0, -1).map(([x, y]) => ({ x, y })), holes = rings.slice(1).map(ring => ring.slice(0, -1).map(([x, y]) => ({ x, y })))
        return { polygon, ...(holes.length ? { holes } : {}) }
      })
    } catch { /* The integer algorithm retains these same rings and fragments. */ }
  }
  return integerCoverBoolean(parts)
}
/** Only an actual portable-format overflow introduces a partition boundary.
 * Exact integer intersections retain both sides, all holes and all fill. */
function portableCoverRegions(region: PolygonRegion): PolygonRegion[] {
  const limit = PROJECT_GEOMETRY_LIMITS.areaRingPoints
  if (region.polygon.length <= limit && (region.holes?.length ?? 0) <= 10000 && (region.holes ?? []).every(h => h.length <= limit)) return [region]
  const b = boundsOf(region.polygon), vertical = b.maxX - b.minX >= b.maxY - b.minY, middle = vertical ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2
  const masks = vertical ? [rectangle(b.minX - 1, b.minY - 1, middle - b.minX + 1, b.maxY - b.minY + 2), rectangle(middle, b.minY - 1, b.maxX - middle + 1, b.maxY - b.minY + 2)] : [rectangle(b.minX - 1, b.minY - 1, b.maxX - b.minX + 2, middle - b.minY + 1), rectangle(b.minX - 1, middle, b.maxX - b.minX + 2, b.maxY - middle + 1)]
  return masks.flatMap(polygon => integerCoverBoolean([region], [{ polygon }], 'intersection')).flatMap(portableCoverRegions)
}
/** Only high-operand tile acquisition differences bypass the floating sweep.
 * Native2999-cut input otherwise spends68s on almost-coincident title/ROW
 * edges. The same0.1–0.2mm survey lattice and full hole tree are retained. */
export function subtractContinuousCover(subject: PolygonRegion, cuts: readonly PolygonRegion[]): PolygonRegion[] {
  const bounds = boundsOf(subject.polygon), nearby = cuts.filter(cut => overlaps(bounds, boundsOf(cut.polygon)))
  if (!nearby.length) return [subject]
  const vertices = nearby.reduce((n, p) => n + p.polygon.length + (p.holes ?? []).reduce((s, h) => s + h.length, 0), 0)
  if (nearby.length < 512 && vertices < 12000) return subtractRegions(subject, nearby)
  // Vatti's weakly-simple outer/holes may touch at acquired title corners.
  // Reapply the holes as explicit cuts in each small result component, so a
  // touching hole splits its shell rather than surviving as an invalid ring.
  // This never restores the pathological whole-tile floating difference.
  const ring = (points: readonly Point[]) => [...points, points[0]!].map(p => [p.x, p.y] as [number, number])
  return integerCoverBoolean([subject], nearby, 'difference').flatMap(part => {
    try {
      const geometry = polygonClipping.difference([ring(part.polygon)], ...(part.holes ?? []).map(hole => [ring(hole)]))
      return geometry.map(rings => ({ polygon: rings[0]!.slice(0, -1).map(([x, y]) => ({ x, y })), ...(rings.length > 1 ? { holes: rings.slice(1).map(hole => hole.slice(0, -1).map(([x, y]) => ({ x, y }))) } : {}) }))
    } catch {
      // A successful acquisition must not be discarded by the second sweep
      // which merely canonicalizes its touching holes. Retry only this piece.
      continuousCoverDiagnostics.canonicalizationFallbacks++
      return integerCoverBoolean([part], [], 'union', true)
    }
  })
}
/** Already-disjoint conversion pieces need no numeric reunion. Keep exact
 * source coordinates; only the portable format's real limits justify cuts. */
export function partitionContinuousCover(parts: readonly PolygonRegion[]): PolygonRegion[] {
  return parts.flatMap(portableCoverRegions)
}
/** Spatial components avoid repeatedly unioning unrelated blocks. Connected
 * inputs enter bounded-vertex batches and a balanced merge tree, rather than
 * one unbounded floating event queue or a quadratic growing accumulator. */
export function dissolveContinuousCover(parts: readonly PolygonRegion[], options: { batchVertices?: number } = {}): PolygonRegion[] {
  if (parts.length < 2) return parts.flatMap(portableCoverRegions)
  const batchVertices = Math.max(3, Math.min(12000, Math.floor(options.batchVertices ?? 12000)))
  const cell = 900, bins = new Map<string, number[]>(), parents = parts.map((_, i) => i)
  const bounds = parts.map(p => { const b = boundsOf(p.polygon); return { minX: b.minX - .00001, minY: b.minY - .00001, maxX: b.maxX + .00001, maxY: b.maxY + .00001 } })
  const root = (i: number): number => { while (parents[i] !== i) { parents[i] = parents[parents[i]!]!; i = parents[i]! } return i }
  for (let i = 0; i < parts.length; i++) {
    const b = bounds[i]!, candidates = new Set<number>()
    for (let x = Math.floor(b.minX / cell); x <= Math.floor(b.maxX / cell); x++) for (let y = Math.floor(b.minY / cell); y <= Math.floor(b.maxY / cell); y++) {
      const key = `${x}:${y}`, values = bins.get(key) ?? []
      for (const j of values) candidates.add(j)
      values.push(i); bins.set(key, values)
    }
    for (const j of candidates) if (overlaps(b, bounds[j]!)) parents[root(i)] = root(j)
  }
  const components = new Map<number, number[]>()
  for (let i = 0; i < parts.length; i++) { const key = root(i), values = components.get(key) ?? []; values.push(i); components.set(key, values) }
  const result: PolygonRegion[] = []
  for (const indices of components.values()) {
    if (indices.length === 1) { result.push(...portableCoverRegions(parts[indices[0]!]!)); continue }
    indices.sort((a, b) => Math.floor(bounds[a]!.minY / cell) - Math.floor(bounds[b]!.minY / cell) || bounds[a]!.minX - bounds[b]!.minX)
    let groups: PolygonRegion[][] = [], batch: PolygonRegion[] = [], vertices = 0
    for (const i of indices) {
      const part = parts[i]!, count = part.polygon.length + (part.holes ?? []).reduce((n, h) => n + h.length, 0)
      if (batch.length && vertices + count > batchVertices) { groups.push(joinCoverParts(batch)); batch = []; vertices = 0 }
      batch.push(part); vertices += count
    }
    if (batch.length) groups.push(joinCoverParts(batch))
    while (groups.length > 1) {
      const next: PolygonRegion[][] = []
      for (let i = 0; i < groups.length; i += 2) next.push(groups[i + 1] ? joinCoverParts([...groups[i]!, ...groups[i + 1]!]) : groups[i]!)
      groups = next
    }
    result.push(...groups[0]!.flatMap(portableCoverRegions))
  }
  return result
}
/** Small titles are never unioned into one enormous whole-city clipping input. */
function regionIndex(regions: readonly PolygonRegion[], cell = 400) {
  const cells = new Map<string, { region: PolygonRegion; bounds: Bounds }[]>()
  for (const region of regions) {
    const entry = { region, bounds: boundsOf(region.polygon) }, b = entry.bounds
    for (let x = Math.floor(b.minX / cell); x <= Math.floor(b.maxX / cell); x++) for (let y = Math.floor(b.minY / cell); y <= Math.floor(b.maxY / cell); y++) {
      const key = `${x}:${y}`, values = cells.get(key) ?? []
      values.push(entry); cells.set(key, values)
    }
  }
  return (region: PolygonRegion) => {
    const b = boundsOf(region.polygon), found = new Set<PolygonRegion>()
    for (let x = Math.floor(b.minX / cell); x <= Math.floor(b.maxX / cell); x++) for (let y = Math.floor(b.minY / cell); y <= Math.floor(b.maxY / cell); y++) for (const entry of cells.get(`${x}:${y}`) ?? []) if (overlaps(b, entry.bounds)) found.add(entry.region)
    return [...found]
  }
}
/** A component with no mask boundary in its bounds is wholly on one side.
 * Most title-sized remnants lie deep inside one large demand contour. Exact
 * boundary boxes avoid clipping that entire contour twice for every remnant;
 * touching boundaries and enclosed holes retain the ordinary polygon kernel. */
function coverMaskRelation() {
  const boundaries = new WeakMap<PolygonRegion, ReturnType<typeof regionIndex>>()
  return (part: PolygonRegion, mask: PolygonRegion) => {
    let edges = boundaries.get(mask)
    if (!edges) {
      edges = regionIndex([mask.polygon, ...mask.holes ?? []].flatMap(ring => ring.map((a, i) => ({ polygon: [a, ring[(i + 1) % ring.length]!] }))))
      boundaries.set(mask, edges)
    }
    if (edges(part).length) return 'partial'
    return pointInRegion(part.polygon[0]!, mask) ? 'inside' : 'outside'
  }
}
function coverMaskPartition(masks: readonly PolygonRegion[]) {
  const query = regionIndex(masks), relation = coverMaskRelation()
  return (part: PolygonRegion) => {
    const partial: PolygonRegion[] = []
    for (const mask of query(part)) {
      const side = relation(part, mask)
      if (side === 'partial') partial.push(mask)
      else if (side === 'inside') return { inside: [part], outside: [] }
    }
    if (!partial.length) return { inside: [], outside: [part] }
    return { inside: partial.flatMap(mask => intersectRegions(part, mask)), outside: subtractRegions(part, partial) }
  }
}
/** Continuous full-width ground strip. Bridge water remains the exact water area. */
export function continuousRoadGround(road: Road): PolygonRegion[] {
  if (road.points.length < 2 || (road.level ?? 0) !== 0) return []
  const scale = 1000, offset = new ClipperLib.ClipperOffset(2, 50), tree = new ClipperLib.PolyTree()
  offset.AddPath(road.points.map(p => ({ X: Math.round(p.x * scale), Y: Math.round(p.y * scale) })), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etOpenSquare)
  offset.Execute(tree, road.width / 2 * scale)
  const result: PolygonRegion[] = [], ring = (node: PolyNode) => node.Contour().map(p => ({ x: p.X / scale, y: p.Y / scale }))
  const visit = (node: PolyNode) => {
    if (!node.IsHole() && node.Contour().length >= 3) result.push({ polygon: ring(node), holes: node.Childs().filter(c => c.IsHole()).map(ring) })
    for (const child of node.Childs()) visit(child)
  }
  visit(tree)
  return result
}
function halfPlane(polygon: Point[], nx: number, ny: number, limit: number) {
  const result: Point[] = []
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, da = a.x * nx + a.y * ny - limit, db = b.x * nx + b.y * ny - limit
    if (da <= 1e-7) result.push(a)
    if (da < -1e-7 && db > 1e-7 || da > 1e-7 && db < -1e-7) { const t = da / (da - db); result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }) }
  }
  return result
}
interface RuralAccess { point: Point; origin: Point; road: Road; bearing: number }
/** Service districts extend into continuous countryside from actual public
 * frontage. These are ownership districts, not road ribbons or invented roads. */
function ruralAccesses(input: ContinuousCityCoverInput, forbidden: (p: Point) => boolean) {
  const result: RuralAccess[] = [], spacing = Math.max(500, Math.sqrt(input.width * input.height / 180))
  const roads = [...input.roads].filter(r => (r.level ?? 0) === 0 && !r.controlledAccess && r.role !== 'expressway' && r.role !== 'ramp').sort((a, b) => Number(b.role === 'farm') - Number(a.role === 'farm') || a.id.localeCompare(b.id))
  for (const road of roads) {
    const length = road.points.slice(1).reduce((sum, p, i) => sum + distance(road.points[i]!, p), 0), count = Math.max(1, Math.ceil(length / spacing))
    for (let i = 0; i < count; i++) {
      const t = (i + .5) / count, origin = pathPointAt(road.points, t), a = pathPointAt(road.points, Math.max(0, t - 80 / Math.max(1, length))), b = pathPointAt(road.points, Math.min(1, t + 80 / Math.max(1, length))), bearing = Math.atan2(b.y - a.y, b.x - a.x)
      for (const side of [-1, 1]) {
        const inset = road.width / 2 + 2, point = { x: origin.x - Math.sin(bearing) * inset * side, y: origin.y + Math.cos(bearing) * inset * side }
        if (point.x < 0 || point.y < 0 || point.x > input.width || point.y > input.height || input.demand.at(point) > 0 || forbidden(point) || input.terrain.waterAt(point) || input.terrain.slope(point) > .14) continue
        if (result.some(s => distance(s.point, point) < spacing * .55 && s.road.id !== road.id)) continue
        result.push({ point, origin, road, bearing })
      }
    }
  }
  return result
}
function roadContacts(roads: readonly Road[]) {
  const cell = 400, cells = new Map<string, { a: Point; b: Point; radius: number; roadId: string; bounds: Bounds }[]>()
  for (const road of roads) for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]!, b = road.points[i]!, radius = road.width / 2 + .002
    const bounds = { minX: Math.min(a.x, b.x) - radius, minY: Math.min(a.y, b.y) - radius, maxX: Math.max(a.x, b.x) + radius, maxY: Math.max(a.y, b.y) + radius }, entry = { a, b, radius, roadId: road.id, bounds }
    for (let x = Math.floor(bounds.minX / cell); x <= Math.floor(bounds.maxX / cell); x++) for (let y = Math.floor(bounds.minY / cell); y <= Math.floor(bounds.maxY / cell); y++) {
      const key = `${x}:${y}`, values = cells.get(key) ?? []; values.push(entry); cells.set(key, values)
    }
  }
  return (region: PolygonRegion, roadId?: string) => {
    const bounds = boundsOf(region.polygon), vertices = [region.polygon, ...(region.holes ?? [])].flat()
    for (let x = Math.floor(bounds.minX / cell); x <= Math.floor(bounds.maxX / cell); x++) for (let y = Math.floor(bounds.minY / cell); y <= Math.floor(bounds.maxY / cell); y++) for (const segment of cells.get(`${x}:${y}`) ?? []) {
      if (roadId !== undefined && segment.roadId !== roadId || !overlaps(bounds, segment.bounds)) continue
      if (vertices.some(p => distanceToSegment(p, segment.a, segment.b) <= segment.radius)) return true
    }
    return false
  }
}
/** Rural components are cut only for bounded processing. A positive-length
 * shared tile edge transfers existing field access; a corner touch cannot.
 * Their coordinates and holes remain an explicit, disjoint partition. */
function ruralPartitionComponents(parts: readonly PolygonRegion[], tile: number) {
  const parents = parts.map((_, i) => i), edges = new Map<string, { low: number; high: number; part: number }[]>()
  const root = (i: number): number => { while (parents[i] !== i) { parents[i] = parents[parents[i]!]!; i = parents[i]! } return i }
  for (const [i, part] of parts.entries()) for (const ring of [part.polygon, ...(part.holes ?? [])]) for (let j = 0; j < ring.length; j++) {
    const a = ring[j]!, b = ring[(j + 1) % ring.length]!
    const vertical = Math.abs(a.x - b.x) < 1e-7 && Math.abs(a.x / tile - Math.round(a.x / tile)) < 1e-8
    const horizontal = Math.abs(a.y - b.y) < 1e-7 && Math.abs(a.y / tile - Math.round(a.y / tile)) < 1e-8
    if (!vertical && !horizontal) continue
    const key = `${vertical ? 'x' : 'y'}:${Math.round((vertical ? a.x : a.y) * 10000)}`, values = edges.get(key) ?? []
    values.push({ low: Math.min(vertical ? a.y : a.x, vertical ? b.y : b.x), high: Math.max(vertical ? a.y : a.x, vertical ? b.y : b.x), part: i }); edges.set(key, values)
  }
  for (const values of edges.values()) {
    values.sort((a, b) => a.low - b.low)
    for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length && values[j]!.low < values[i]!.high - .0001; j++) {
      if (values[i]!.part !== values[j]!.part && Math.min(values[i]!.high, values[j]!.high) - Math.max(values[i]!.low, values[j]!.low) > .0001) parents[root(values[i]!.part)] = root(values[j]!.part)
    }
  }
  const groups = new Map<number, PolygonRegion[]>()
  for (const [i, part] of parts.entries()) { const key = root(i), group = groups.get(key) ?? []; group.push(part); groups.set(key, group) }
  return [...groups.values()]
}
function roadServedRuralPartition(parts: readonly PolygonRegion[], touches: (region: PolygonRegion) => boolean, tile: number) {
  return ruralPartitionComponents(parts, tile).filter(group => group.some(touches)).flat()
}
/** An arbitrary500m sampling phase or a neighbouring site's Voronoi boundary
 * cannot revoke real public frontage. Measure a positive-length contact on the
 * remaining dry boundary; the farm survey separately certifies vehicle access.
 */
function remainingRuralFrontages(roads: readonly Road[]) {
  const entries = roads.flatMap(road => road.points.slice(1).map((b, i) => {
    const a = road.points[i]!, radius = road.width / 2 + .02, bounds = boundsOf([a, b])
    return { road, a, b, radius, bounds: { minX: bounds.minX - radius, maxX: bounds.maxX + radius, minY: bounds.minY - radius, maxY: bounds.maxY + radius } }
  }))
  const bins = new Map<string, typeof entries>(), size = 100
  for (const entry of entries) for (let x = Math.floor(entry.bounds.minX / size); x <= Math.floor(entry.bounds.maxX / size); x++) for (let y = Math.floor(entry.bounds.minY / size); y <= Math.floor(entry.bounds.maxY / size); y++) { const key = `${x}:${y}`, list = bins.get(key) ?? []; list.push(entry); bins.set(key, list) }
  const nearby = (bounds: Bounds) => {
    const found = new Set<(typeof entries)[number]>()
    for (let x = Math.floor(bounds.minX / size); x <= Math.floor(bounds.maxX / size); x++) for (let y = Math.floor(bounds.minY / size); y <= Math.floor(bounds.maxY / size); y++) for (const entry of bins.get(`${x}:${y}`) ?? []) if (overlaps(bounds, entry.bounds)) found.add(entry)
    return found
  }
  return (regions: readonly PolygonRegion[]) => {
    const contacts = new Map<string, { road: Road; origin: Point; length: number; best: number }>()
    for (const region of regions) {
      for (const ring of [region.polygon, ...region.holes ?? []]) for (let i = 0; i < ring.length; i++) {
        const p = ring[i]!, q = ring[(i + 1) % ring.length]!, edgeLength = distance(p, q)
        if (edgeLength < .01) continue
        for (const { road, a, b, radius } of nearby(boundsOf([p, q]))) {
          const length = distance(a, b)
          if (length < .01) continue
          const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length, x = (p.x - a.x) * ux + (p.y - a.y) * uy, y = -(p.x - a.x) * uy + (p.y - a.y) * ux
          const dx = (q.x - p.x) * ux + (q.y - p.y) * uy, dy = -(q.x - p.x) * uy + (q.y - p.y) * ux
          let low = 0, high = 1
          for (const [start, delta, min, max] of [[x, dx, -radius, length + radius], [y, dy, -radius, radius]] as const) {
            if (Math.abs(delta) < 1e-12) { if (start < min || start > max) { high = -1; break } }
            else { const first = (min - start) / delta, last = (max - start) / delta; low = Math.max(low, Math.min(first, last)); high = Math.min(high, Math.max(first, last)) }
          }
          const contact = (high - low) * edgeLength
          if (contact <= .01) continue
          const t = (low + high) / 2, along = Math.max(0, Math.min(length, x + dx * t)), origin = { x: a.x + ux * along, y: a.y + uy * along }, old = contacts.get(road.id)
          contacts.set(road.id, { road, origin: !old || contact > old.best ? origin : old.origin, length: (old?.length ?? 0) + contact, best: Math.max(old?.best ?? 0, contact) })
        }
      }
    }
    return [...contacts.values()].filter(contact => contact.length >= 2.4).sort((a, b) => Number(b.road.role === 'farm') - Number(a.road.role === 'farm') || b.length - a.length || a.road.id.localeCompare(b.road.id)).slice(0, 8)
  }
}

/** Uncleared countryside is not automatically managed grass. After actual
 * farming has acquired its holdings/working ground, regenerate only the
 * remaining natural ground. Clearing distance, moisture and slope determine
 * coherent habitat edges; the user's forest allocation limits their area.
 * Neither working verges nor acquired/water/road ground enter this operation. */
function ruralRegeneration(input: ContinuousCityCoverInput, remaining: readonly PolygonRegion[], cleared: readonly PolygonRegion[], existingForestArea: number) {
  const forest = Math.max(0, Math.min(1, input.config.forest / 100)), sum = (parts: readonly PolygonRegion[]) => parts.reduce((n, part) => n + regionArea(part), 0)
  const waterArea = sum(input.terrain.areas.filter(area => area.kind === 'water')), budget = Math.max(0, (input.width * input.height - waterArea) * forest - existingForestArea)
  if (!forest || budget < 2500 || !remaining.length) return { woodland: [] as PolygonRegion[], meadow: [...remaining] }
  const eligible = regionIndex(remaining), edges = regionIndex(cleared.flatMap(region => [region.polygon, ...region.holes ?? []].flatMap(ring => ring.map((p, i) => ({ polygon: [p, ring[(i + 1) % ring.length]!] })))), 100)
  const cached = new Map<string, number>(), values: number[] = [], step = Math.max(48, Math.sqrt(input.width * input.height / 5000))
  const suitability = (point: Point) => {
    const key = `${point.x}:${point.y}`, known = cached.get(key)
    if (known !== undefined) return known
    const probe = { polygon: rectangle(point.x - .001, point.y - .001, .002, .002) }
    let value = -1000
    if (eligible(probe).some(region => pointInRegion(point, region)) && !input.terrain.waterAt(point)) {
      const nearby = edges({ polygon: rectangle(point.x - 220, point.y - 220, 440, 440) })
      const clearance = nearby.reduce((d, edge) => Math.min(d, distanceToSegment(point, edge.polygon[0]!, edge.polygon[1]!)), 220)
      const moisture = input.terrain.wetness?.(point) ?? .2, slope = input.terrain.slope(point)
      // Saturated flood grass remains open; dry low terraces can be wooded
      // even when they never meet the mountain-forest elevation threshold.
      value = Math.min(clearance - 24, (.68 - moisture) * 400, clearance - 75 + slope * 600 + Math.min(moisture, .45) * 30)
    }
    cached.set(key, value); values.push(value); return value
  }
  const smooth = (ring: Point[]) => {
    for (let pass = 0; pass < 2; pass++) ring = ring.flatMap((p, i) => { const q = ring[(i + 1) % ring.length]!; return [{ x: p.x * .75 + q.x * .25, y: p.y * .75 + q.y * .25 }, { x: p.x * .25 + q.x * .75, y: p.y * .25 + q.y * .75 }] })
    return ring
  }
  const select = (threshold: number) => {
    const masks = contourLand(input.width, input.height, p => suitability(p) - threshold, step).map(region => ({ polygon: smooth(region.polygon), holes: region.holes?.map(smooth) })), partition = coverMaskPartition(masks)
    return remaining.flatMap(part => partition(part).inside).filter(part => regionArea(part) >= 2500)
  }
  let woodland = select(0)
  if (sum(woodland) > budget) {
    let low = 0, high = Math.max(...values) + 1; woodland = []
    // Exact clipped areas, rather than a sample-count quota, respect water
    // holes and the user's forest budget. Sampling is cached across searches.
    for (let i = 0; i < 9; i++) { const middle = (low + high) / 2, candidate = select(middle); if (sum(candidate) > budget) low = middle; else { high = middle; woodland = candidate } }
  }
  const partition = coverMaskPartition(woodland)
  return { woodland, meadow: remaining.flatMap(part => partition(part).outside) }
}

/** Partitions every unacquired part of the crop. Urban vacancies stay explicit;
 * rural flat land belongs to broad road-served districts, and hills retain
 * continuous woodland. No old zone, street-fabric or cover pass participates. */
export function buildContinuousCityCover(input: ContinuousCityCoverInput): Area[] {
  const { width, height, terrain, onProgress, onGeometry } = input, crop = { polygon: rectangle(0, 0, width, height) }
  const water = terrain.areas.filter(a => a.kind === 'water')
  onProgress?.(`土地被覆:道路用地の幅を展開中（${input.roads.length}路線）…`)
  const ground = input.roads.flatMap(continuousRoadGround)
  onProgress?.(`土地被覆:水・取得地・保護地の索引を作成中（${input.parcels.length}筆）…`)
  const obstacles = [...water, ...input.reserves, ...input.parcels.filter(p => p.retiredYear === undefined).map(p => ({ polygon: p.polygon })), ...ground], obstacleQuery = regionIndex(obstacles)
  onProgress?.(`土地被覆:都市需要面を索引化中（${input.demand.regions.length}面）…`)
  const demand = partitionContinuousCover(input.demand.regions), demandPartition = coverMaskPartition(demand)
  onProgress?.('土地被覆:斜面の自然植生を測量中…')
  const steep = contourLand(width, height, p => terrain.slope(p) - .16, Math.max(60, Math.sqrt(width * height / 9000)))
  onProgress?.(`土地被覆:森林と斜面境界を結合中（${steep.length}斜面）…`)
  const woodland = dissolveContinuousCover([...terrain.areas.filter(a => a.kind === 'forest' || a.landUse === 'woodland'), ...steep]), woodlandPartition = coverMaskPartition(woodland)
  const result: Area[] = [], add = (regions: PolygonRegion[], kind: Area['kind'], landUse?: Area['landUse'], identity = 'land-continuous') => {
    for (const region of regions) if (regionArea(region) > .0001) result.push({ id: `${identity}-${result.length}`, ...region, kind, ...(landUse ? { landUse } : {}) })
  }
  // Tiles have disjoint interiors; woodland has been truly unioned, and the
  // demand contour consists of disjoint regions. Subtraction/intersection thus
  // yields disjoint natural/urban/rural pieces. Keep that exact partition;
  // landPaintGroups paints each contiguous use in one antialiased fill.
  const naturalParts: PolygonRegion[] = [], urbanParts: PolygonRegion[] = [], ruralParts: PolygonRegion[] = [], tile = 900
  const tileCount = Math.ceil(width / tile) * Math.ceil(height / tile)
  let tileSerial = 0
  for (let x = 0; x < width; x += tile) for (let y = 0; y < height; y += tile) {
    const cell = { polygon: rectangle(x, y, Math.min(tile, width - x), Math.min(tile, height - y)) }
    const cuts = obstacleQuery(cell)
    onProgress?.(`土地被覆:取得地の除外 ${++tileSerial}/${tileCount}（${x},${y}・${cuts.length}境界）…`)
    const vacant = subtractContinuousCover(cell, cuts)
    onProgress?.(`土地被覆:自然・都市・農村の分類 ${tileSerial}/${tileCount}（${vacant.length}残地）…`)
    for (const part of vacant) {
      const wooded = woodlandPartition(part)
      naturalParts.push(...wooded.inside)
      for (const dry of wooded.outside) {
        const developed = demandPartition(dry)
        urbanParts.push(...developed.inside)
        ruralParts.push(...developed.outside)
      }
    }
  }
  onProgress?.(`土地被覆:タイル分類100%・自然被覆の保持（${naturalParts.length}片）…`)
  onGeometry?.('natural', naturalParts)
  add(partitionContinuousCover(naturalParts), 'forest', 'woodland')
  const publicRoads = input.roads.filter(r => (r.level ?? 0) === 0 && !r.controlledAccess && r.role !== 'expressway' && r.role !== 'ramp'), touchesRoad = roadContacts(publicRoads)
  onProgress?.(`土地被覆:都市内残地の保持（${urbanParts.length}片）…`)
  onGeometry?.('urban', urbanParts)
  const urban = partitionContinuousCover(urbanParts), blockQuery = regionIndex(input.urbanBlocks), blockRelation = coverMaskRelation()
  const blockAreas = new WeakMap(input.urbanBlocks.map(block => [block, regionArea(block)] as const))
  onProgress?.(`土地被覆:都市内空地と小公園を分類中（${urban.length}面）…`)
  for (const part of urban) {
    const processingEdge = part.polygon.some((a, i) => { const b = part.polygon[(i + 1) % part.polygon.length]!; return Math.abs(a.x - b.x) < 1e-7 && a.x > 0 && a.x < width && Math.abs(a.x / tile - Math.round(a.x / tile)) < 1e-8 || Math.abs(a.y - b.y) < 1e-7 && a.y > 0 && a.y < height && Math.abs(a.y / tile - Math.round(a.y / tile)) < 1e-8 })
    const area = regionArea(part)
    const smallPocket = area <= 1600 && blockQuery(part).some(b => {
      if (processingEdge && blockAreas.get(b)! > 1600) return false
      const side = blockRelation(part, b)
      return side === 'inside' || side === 'partial' && intersectRegions(part, b).reduce((sum, p) => sum + regionArea(p), 0) >= area * .99
    }) && touchesRoad(part)
    add([part], 'park', smallPocket ? undefined : 'vacant')
  }
  const ruralQuery = regionIndex(ruralParts)
  const naturalQuery = regionIndex([...woodland, ...water, ...input.reserves]), forbidden = (p: Point) => naturalQuery({ polygon: rectangle(p.x - .01, p.y - .01, .02, .02) }).some(r => pointInRegion(p, r))
  onProgress?.(`土地被覆:実道路に接する農地区の起点を選定中（${ruralParts.length}農村片）…`)
  const sites = ruralAccesses(input, forbidden), farmParts: PolygonRegion[] = []
  const agricultureTerrain = { elevation: terrain.elevation, slope: terrain.slope, wetness: terrain.wetness ?? (() => 0), channelAt: terrain.channelAt ?? (() => null), rivers: terrain.rivers, cultivable: terrain.cultivable }
  let districtSerial = 0
  for (const site of sites) {
    onProgress?.(`土地被覆:農地区境界の分割 ${++districtSerial}/${sites.length}…`)
    let polygon = crop.polygon
    for (const other of sites) if (other !== site && polygon.length >= 3) {
      const nx = other.point.x - site.point.x, ny = other.point.y - site.point.y
      polygon = halfPlane(polygon, nx, ny, (other.point.x ** 2 + other.point.y ** 2 - site.point.x ** 2 - site.point.y ** 2) / 2)
    }
    if (polygon.length < 3) continue
    const district = { polygon }
    const nearby = ruralQuery(district)
    onProgress?.(`土地被覆:農地区の地盤交差 ${districtSerial}/${sites.length}（${nearby.length}残地）…`)
    const pieces = nearby.flatMap(remainder => intersectRegions(district, remainder))
    onProgress?.(`土地被覆:農地区の連続接道 ${districtSerial}/${sites.length}（${pieces.length}片）…`)
    // Water, a reserve or a disconnected island can sever an ownership cell.
    // Keep only districts with real access, then survey field holdings and
    // their shared working verges rather than painting one enormous field.
    const served = partitionContinuousCover(roadServedRuralPartition(pieces, p => touchesRoad(p, site.road.id), tile))
    const holdings = subdivideContinuousFarmDistrict({ regions: served, road: site.road, origin: site.origin, seed: `${input.config.seed}:rural-${districtSerial}`, terrain: agricultureTerrain })
    // A failed survey does not clear a district or acquire working verges.
    // Its untouched habitat must remain eligible for natural regeneration.
    if (!holdings.plots.length) continue
    for (const plot of holdings.plots) add([plot], 'field', plot.landUse)
    add(holdings.bunds, 'park', 'meadow', `land-continuous-farm-bund-${districtSerial}`)
    farmParts.push(...served)
  }
  onProgress?.(`土地被覆:最終残地から農地を除外中（${ruralParts.length}残地・${farmParts.length}農地区）…`)
  const farmQuery = regionIndex(farmParts), inaccessible: PolygonRegion[] = []
  for (const [i, part] of ruralParts.entries()) {
    if (i % 50 === 0) onProgress?.(`土地被覆:最終残地の除外 ${i + 1}/${ruralParts.length}…`)
    inaccessible.push(...subtractRegions(part, farmQuery(part)))
  }
  // Reconsider only unacquired ground with its OWN real public frontage.
  // Storage seams transfer positive-width access; a corner or a water hole
  // does not. Whole plots must still pass soil, slope and working-lane tests.
  const frontages = remainingRuralFrontages(publicRoads), naturalRemainder: PolygonRegion[] = []
  for (const [i, group] of ruralPartitionComponents(inaccessible, tile).entries()) {
    const contacts = frontages(group)
    let acquired = false
    if (contacts.length) {
      const regions = group.length > 1 ? dissolveContinuousCover(group, { batchVertices: 3000 }) : group
      for (const contact of contacts) {
        const holdings = subdivideContinuousFarmDistrict({ regions, road: contact.road, origin: contact.origin, seed: `${input.config.seed}:rural-frontage-${i}`, terrain: agricultureTerrain })
        if (!holdings.plots.length) continue
        for (const plot of holdings.plots) add([plot], 'field', plot.landUse)
        add(holdings.bunds, 'park', 'meadow', `land-continuous-farm-bund-frontage-${i}`)
        acquired = true; break
      }
    }
    if (!acquired) naturalRemainder.push(...group)
  }
  onProgress?.(`土地被覆:最終自然残地の保持（${naturalRemainder.length}片）…`)
  onGeometry?.('rural-final', naturalRemainder)
  const regeneration = ruralRegeneration(input, naturalRemainder, [...ground, ...input.reserves, ...input.parcels.filter(parcel => parcel.retiredYear === undefined).map(parcel => ({ polygon: parcel.polygon })), ...result.filter(area => area.kind === 'field')], naturalParts.reduce((sum, part) => sum + regionArea(part), 0))
  add(partitionContinuousCover(regeneration.woodland), 'forest', 'woodland', 'land-continuous-rural-woodland')
  add(partitionContinuousCover(regeneration.meadow), 'park', 'meadow')
  onProgress?.(`土地被覆:完了（${result.length}面・${water.length}水域）`)
  return [...result, ...water]
}
