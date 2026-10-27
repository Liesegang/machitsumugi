import type { Area, Building, BuildingState, GrowthEvent, Parcel, Point, Road, TimelineVersion } from './types'
import type { Bounds, PolygonRegion } from './geometry'
import type { ContinuousCityLandInput } from './continuous-city-types'
import { boundsOf, corridorPolygon, distance, distanceToSegment, intersectRegions, overlaps, pointInPolygon, pointInRegion, polygonArea, polygonOverlapsRegion, projectPoint, rectangle, regionArea, seededRandom, segmentsCross, subtractRegions } from './geometry'
import { buildingServiceYears } from './building-lifecycle'
import { MinHeap } from './road-graph'
import { indexedPolygonOverlap } from './indexed-polygon-overlap'
import { subtractContinuousCover } from './continuous-city-cover'
import { streetHolding } from './street-holding'
import type { HoldingProfile, StreetStock } from './street-holding'
import { continuousLocalStreetForm } from './continuous-city-density'
import { neighbourhoodHolding } from './continuous-city-parcel-form'
import type { ParcelNeighbourhoodForm } from './continuous-city-parcel-form'

interface Segment { a: Point; b: Point; road: Road; polygon: Point[]; bounds: Bounds; chainage: number }
interface Frontage { a: Point; b: Point; segment: Segment; length: number }
interface Cell extends PolygonRegion { frontages: Frontage[] }
type Stock = StreetStock
interface RouteContext { distance: number; availableYear: number; formAvailableYear: number; source: 'center' | 'station' }
interface FrontageProgramme { front: Frontage; stock: Stock; from: number; to: number; route: RouteContext; holding?: HoldingProfile; holdingKey?: string; court?: boolean; winged?: boolean; form?: ParcelNeighbourhoodForm }
interface TitleProgramme { stock: Stock; frontage: number; depth: number; maximumArea: number; route: RouteContext; parking: boolean; holding: HoldingProfile; cuts: number[]; court: boolean; winged: boolean; inherited: boolean }
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n))
const commercialStock = (stock: Stock) => stock === 'mixed' || stock === 'office' || stock === 'retail'
const businessStock = (stock: Stock) => stock === 'office' || stock === 'retail'
const publicStreet = (road: Road) => !road.controlledAccess && road.role !== 'expressway' && road.role !== 'ramp' && road.role !== 'farm' && (road.level ?? 0) === 0
const sumArea = (regions: readonly PolygonRegion[]) => regions.reduce((sum, region) => sum + regionArea(region), 0)
// Translate tiny survey rings before summing so global coordinates do not
// cancel a positive sub-lattice fragment to zero during the entry check.
const localRingArea = (ring: Point[]) => { const origin = ring[0]; return origin ? Math.abs(ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]!; return sum + (p.x - origin.x) * (q.y - origin.y) - (q.x - origin.x) * (p.y - origin.y) }, 0)) / 2 : 0 }
const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const onBoundary = (p: Point, polygon: Point[]) => polygon.some((a, i) => distanceToSegment(p, a, polygon[(i + 1) % polygon.length]!) < .0005)
const within = (p: Point, region: PolygonRegion) => (pointInPolygon(p, region.polygon) || onBoundary(p, region.polygon)) && !(region.holes ?? []).some(hole => pointInPolygon(p, hole))
function interior(region: PolygonRegion): Point {
  const bounds = boundsOf(region.polygon), center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
  if (pointInRegion(center, region)) return center
  for (const fraction of [.25, .5, .75, .125, .875]) for (let i = 1; i < 8; i++) {
    const p = { x: bounds.minX + (bounds.maxX - bounds.minX) * fraction, y: bounds.minY + (bounds.maxY - bounds.minY) * i / 8 }
    if (pointInRegion(p, region)) return p
  }
  return middle(region.polygon[0]!, region.polygon[1]!)
}
function samples(polygon: Point[], spacing = 4): Point[] {
  return polygon.flatMap((a, i) => { const b = polygon[(i + 1) % polygon.length]!, count = Math.max(1, Math.ceil(distance(a, b) / spacing)); return Array.from({ length: count }, (_, n) => ({ x: a.x + (b.x - a.x) * n / count, y: a.y + (b.y - a.y) * n / count })) })
}
function containsPolygon(region: PolygonRegion, polygon: Point[]) {
  return polygon.every(p => within(p, region)) && !polygon.some((a, i) => [region.polygon, ...region.holes ?? []].some(ring => ring.some((b, j) => segmentsCross(a, polygon[(i + 1) % polygon.length]!, b, ring[(j + 1) % ring.length]!)))) && !(region.holes ?? []).some(hole => hole.some(p => pointInPolygon(p, polygon)))
}
const turn = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
const convex = (ring: Point[]) => ring.length >= 3 && ring.every((p, i) => turn(p, ring[(i + 1) % ring.length]!, ring[(i + 2) % ring.length]!) >= 0)
const inConvex = (point: Point, ring: Point[]) => ring.every((a, i) => turn(a, ring[(i + 1) % ring.length]!, point) >= 0)
function lineClip(ring: Point[], a: Point, b: Point, positive: boolean) {
  const result: Point[] = []
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!, from = turn(a, b, p), to = turn(a, b, q), inside = positive ? from >= 0 : from <= 0, next = positive ? to >= 0 : to <= 0
    if (inside) result.push(p)
    if (inside !== next) { const t = from / (from - to); result.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }) }
  }
  return result
}
/** A line crossing a simple, hole-free title exactly twice divides it into
 * two connected titles, including a concave street frontage. More crossings
 * could create disconnected acquisitions and must use the general kernel.
 * Coordinates use that kernel's existing survey lattice. */
function simpleLineSplit(cell: PolygonRegion, mask: PolygonRegion): [PolygonRegion[], PolygonRegion[]] | null {
  if (cell.holes?.length) return null
  const rounded = (p: Point) => ({ x: Math.round(p.x * 10000) / 10000, y: Math.round(p.y * 10000) / 10000 })
  const ring = cell.polygon.map(rounded), boundary = mask.polygon.map(rounded)
  if (!convex(boundary) || boundary.some((a, i) => i !== 1 && ring.some(p => turn(a, boundary[(i + 1) % boundary.length]!, p) < 0))) return null
  const sides = ring.map(p => turn(boundary[1]!, boundary[2]!, p))
  // Vertex contacts are deliberately left to the topology-aware kernel.
  if (sides.some(side => side === 0) || sides.reduce((count, side, i) => count + Number((side > 0) !== (sides[(i + 1) % sides.length]! > 0)), 0) !== 2) return null
  const region = (points: Point[]): PolygonRegion[] => {
    const unique = points.filter((p, i) => { const previous = points[(i + points.length - 1) % points.length]!; return p.x !== previous.x || p.y !== previous.y })
    const clean = unique.filter((p, i) => turn(unique[(i + unique.length - 1) % unique.length]!, p, unique[(i + 1) % unique.length]!) !== 0)
    if (clean.length < 3 || polygonArea(clean) <= .01) return []
    let first = 0
    for (let i = 1; i < clean.length; i++) if (clean[i]!.x < clean[first]!.x || clean[i]!.x === clean[first]!.x && clean[i]!.y < clean[first]!.y) first = i
    return [{ polygon: [...clean.slice(first), ...clean.slice(0, first)] }]
  }
  return [region(lineClip(ring, boundary[1]!, boundary[2]!, true)), region(lineClip(ring, boundary[1]!, boundary[2]!, false))]
}
function spatialIndex<T extends { bounds: Bounds }>(size = 80) {
  const bins = new Map<string, T[]>()
  const keys = function* (b: Bounds) { for (let x = Math.floor(b.minX / size); x <= Math.floor(b.maxX / size); x++) for (let y = Math.floor(b.minY / size); y <= Math.floor(b.maxY / size); y++) yield `${x}:${y}` }
  return {
    add(value: T) { for (const key of keys(value.bounds)) { const list = bins.get(key) ?? []; list.push(value); bins.set(key, list) } },
    query(bounds: Bounds) { const result = new Set<T>(); for (const key of keys(bounds)) for (const value of bins.get(key) ?? []) if (overlaps(bounds, value.bounds)) result.add(value); return [...result] },
  }
}

/** A block cadastre, rather than independent rectangles cast from each road.
 * Every developable square metre becomes a title, a surveyed shared street or
 * an explicitly identified open-space remainder. Physical masks are immutable. */
export function developContinuousCityLand(input: ContinuousCityLandInput) {
  const endYear = clamp(Math.round(input.config.targetYear ?? 2025), 1650, 2025)
  const roadIndex = spatialIndex<Segment>(), obstacleIndex = spatialIndex<PolygonRegion & { bounds: Bounds }>(), streetSegments: Segment[] = []
  const obstacleOverlaps = new WeakMap<PolygonRegion, (polygon: Point[]) => boolean>()
  const addRoad = (road: Road) => {
    if ((road.level ?? 0) !== 0) return
    let chainage = 0
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!
      if (distance(a, b) < .01) continue
      const polygon = corridorPolygon(a, b, road.width / 2 + .25)
      const segment = { a, b, road, polygon, bounds: boundsOf(polygon), chainage }
      chainage += distance(a,b)
      roadIndex.add(segment)
      if (publicStreet(road)) streetSegments.push(segment)
    }
  }
  for (const road of input.roads) addRoad(road)
  for (const region of [...input.terrain.areas.filter(area => area.kind === 'water'), ...input.reserves]) {
    const entry = { ...region, bounds: boundsOf(region.polygon) }
    obstacleIndex.add(entry); obstacleOverlaps.set(entry, indexedPolygonOverlap(entry))
  }
  const parcels: Parcel[] = [], buildings: Building[] = [], accessRoads: Road[] = [], openSpaces: Area[] = [], unassignedGround: PolygonRegion[] = [], events: GrowthEvent[] = []
  const history = { parcels: [] as TimelineVersion<Parcel>[], buildings: [] as TimelineVersion<Building>[], buildingStates: [] as BuildingState[] }
  const metrics = { blocks: input.blocks.length, buildableArea: 0, parcelArea: 0, accessArea: 0, openSpaceArea: 0, unassignedArea: 0, partitionAreaError: 0, laneAttempts: 0, accessRoads: 0, privateReplacements: 0, lots: 0, courtyardLots: 0, wingedRoofs: 0, oversizedLots: 0, frontageFailures: 0, formationFailures: 0, stock: {} as Record<Stock, { count: number; parcelArea: number; roofArea: number; parking: number }>, openReasons: {} as Record<string, { count: number; area: number }> }
  const obstacles = (region: PolygonRegion) => obstacleIndex.query(boundsOf(region.polygon))
  const frontages = (region: PolygonRegion): Frontage[] => {
    const bounds = boundsOf(region.polygon), near = roadIndex.query({ minX: bounds.minX - 18, minY: bounds.minY - 18, maxX: bounds.maxX + 18, maxY: bounds.maxY + 18 }).filter(segment => publicStreet(segment.road))
    const result: Frontage[] = []
    for (let i = 0; i < region.polygon.length; i++) {
      const a = region.polygon[i]!, b = region.polygon[(i + 1) % region.polygon.length]!, length = distance(a, b)
      if (length < .3) continue
      const dx = (b.x - a.x) / length, dy = (b.y - a.y) / length
      const pieces: { low: number; high: number; segments: Segment[] }[] = []
      for (const segment of near) {
        const size = distance(segment.a, segment.b), alignment = Math.abs(((segment.b.x - segment.a.x) * dx + (segment.b.y - segment.a.y) * dy) / size)
        if (alignment <= .8) continue
        const projected = [segment.a, segment.b].map(p => (p.x - a.x) * dx + (p.y - a.y) * dy), low = Math.max(0, Math.min(...projected)), high = Math.min(length, Math.max(...projected))
        if (high - low < .0001) continue
        const from = { x: a.x + dx * low, y: a.y + dy * low }, to = { x: a.x + dx * high, y: a.y + dy * high }, p = middle(from, to)
        // Clipping merges collinear boundaries across several road samples.
        // Attribute their actual overlapping pieces, not the whole long edge
        // to one short source segment (which would erase shared-lane frontage).
        if (Math.abs(distanceToSegment(p, segment.a, segment.b) - segment.road.width / 2 - .25) < .65 && Math.max(distanceToSegment(from, segment.a, segment.b), distanceToSegment(to, segment.a, segment.b)) <= segment.road.width / 2 + 1) pieces.push({ low, high, segments: [segment] })
      }
      pieces.sort((a, b) => a.segments[0]!.road.id.localeCompare(b.segments[0]!.road.id) || a.low - b.low)
      const merged: typeof pieces = []
      for (const piece of pieces) {
        const previous = merged.at(-1)
        if (previous && previous.segments[0]!.road.id === piece.segments[0]!.road.id && piece.low <= previous.high + .001) { previous.high = Math.max(previous.high, piece.high); previous.segments.push(...piece.segments) }
        else merged.push({ ...piece, segments: [...piece.segments] })
      }
      for (const piece of merged) {
        const from = { x: a.x + dx * piece.low, y: a.y + dy * piece.low }, to = { x: a.x + dx * piece.high, y: a.y + dy * piece.high }, p = middle(from, to)
        const segment = piece.segments.sort((x, y) => distanceToSegment(p, x.a, x.b) - distanceToSegment(p, y.a, y.b))[0]!
        result.push({ a: from, b: to, segment, length: piece.high - piece.low })
      }
    }
    return result.sort((a, b) => b.length - a.length || a.segment.road.id.localeCompare(b.segment.road.id))
  }
  const opening = (p: Point) => Math.max(1650, Math.round(input.demand.openingAt(p)))
  const physical = (polygon: Point[], maximumSlope = .16) => {
    if (polygon.some(p => p.x < 0 || p.y < 0 || p.x > input.width || p.y > input.height) || obstacles({ polygon }).some(region => obstacleOverlaps.get(region)!(polygon))) return false
    const bounds = boundsOf(polygon), points = samples(polygon)
    for (let x = bounds.minX + 2; x < bounds.maxX; x += 4) for (let y = bounds.minY + 2; y < bounds.maxY; y += 4) if (pointInPolygon({ x, y }, polygon)) points.push({ x, y })
    return points.every(p => !input.terrain.waterAt(p) && Number.isFinite(input.terrain.slope(p)) && input.terrain.slope(p) <= maximumSlope)
  }
  // Junctions are materialized by transport. Route only over those public,
  // ground-level vertices; geometric proximity never joins two streets.
  const network = (() => {
    const indices = new Map<string, number>(), adjacency: { to: number; length: number; year: number }[][] = [], segmentNodes = new Map<Segment, [number, number]>()
    const node = (p: Point) => { const key = `${p.x.toFixed(5)}:${p.y.toFixed(5)}`; let index = indices.get(key); if (index === undefined) { index = adjacency.length; indices.set(key, index); adjacency.push([]) } return index }
    for (const segment of streetSegments) {
      const a = node(segment.a), b = node(segment.b), length = distance(segment.a, segment.b), year = segment.road.builtYear ?? 1650
      adjacency[a]!.push({ to: b, length, year }); adjacency[b]!.push({ to: a, length, year }); segmentNodes.set(segment, [a, b])
    }
    const values: RouteContext[][] = Array.from({ length: adjacency.length }, () => []), queue = new MinHeap<{ index: number; route: RouteContext }>(), contacts: { segment: Segment; point: Point; value: RouteContext }[] = []
    const improve = (index: number, value: RouteContext) => {
      const previous = values[index]!
      if (previous.some(route => route.source === value.source && route.distance <= value.distance + 1e-7 && route.availableYear <= value.availableYear)) return
      values[index] = previous.filter(route => route.source !== value.source || route.distance < value.distance - 1e-7 || route.availableYear < value.availableYear)
      values[index]!.push(value); queue.push({ index, route: value }, value.distance)
    }
    const sites = [{ point: input.centerAccess?.point ?? input.demand.center, year: input.centerAccess?.builtYear ?? 1650, source: 'center' as const }, ...input.stations.map(station => ({ point: station.entrance ?? station.point, year: station.builtYear ?? 1900, source: 'station' as const }))]
    for (const site of sites) {
      if (input.terrain.waterAt(site.point)) continue
      const p = site.point, nearby = roadIndex.query({ minX: p.x - 18, minY: p.y - 18, maxX: p.x + 18, maxY: p.y + 18 }).filter(segment => segmentNodes.has(segment)).map(segment => ({ segment, point: projectPoint(p, segment.a, segment.b) })).sort((a, b) => distance(p, a.point) - distance(p, b.point) || a.segment.road.id.localeCompare(b.segment.road.id))
      const contact = nearby.find(contact => distance(p, contact.point) <= 18 && (distance(p, contact.point) < .01 || physical(corridorPolygon(p, contact.point, .65))))
      if (!contact) continue
      // At a real shared junction, an old approach and a new shortcut have the
      // same physical attachment. Neither road's id may choose its opening.
      for (const attachment of nearby.filter(candidate => distance(candidate.point, contact.point) < 1e-7)) {
        const availableYear = Math.max(site.year, attachment.segment.road.builtYear ?? 1650), value = { distance: distance(p, attachment.point), availableYear, formAvailableYear: availableYear, source: site.source }
        contacts.push({ ...attachment, value })
        const nodes = segmentNodes.get(attachment.segment)!
        improve(nodes[0], { ...value, distance: value.distance + distance(attachment.point, attachment.segment.a) }); improve(nodes[1], { ...value, distance: value.distance + distance(attachment.point, attachment.segment.b) })
      }
    }
    while (queue.size) {
      const item = queue.pop()!, { index, route: value } = item.value
      if (!values[index]!.includes(value)) continue
      for (const edge of adjacency[index]!) { const availableYear = Math.max(value.availableYear, edge.year); improve(edge.to, { ...value, distance: value.distance + edge.length, availableYear, formAvailableYear: availableYear }) }
    }
    return (front: Frontage): RouteContext => {
      const p = projectPoint(middle(front.a, front.b), front.segment.a, front.segment.b), nodes = segmentNodes.get(front.segment), candidates: RouteContext[] = []
      if (nodes) for (const [i, endpoint] of [front.segment.a, front.segment.b].entries()) for (const value of values[nodes[i]!]!) candidates.push({ ...value, distance: value.distance + distance(p, endpoint) })
      for (const contact of contacts) if (contact.segment === front.segment) candidates.push({ ...contact.value, distance: contact.value.distance + distance(p, contact.point) })
      const current = candidates.sort((a, b) => a.distance - b.distance || a.availableYear - b.availableYear)[0]
      if (!current) return { distance: Infinity, availableYear: 2025, formAvailableYear: 2025, source: 'center' }
      // An old qualifying main street survives a later shortcut. Its title can
      // remain old, while additional station/downtown mass waits for that
      // faster route and is introduced only with a later physical replacement.
      const earliest = candidates.filter(route => route.distance < (route.source === 'station' ? 680 : 880)).sort((a, b) => a.availableYear - b.availableYear || a.distance - b.distance)[0]
      return { ...current, availableYear: earliest?.availableYear ?? current.availableYear, formAvailableYear: current.availableYear }
    }
  })()
  const open = (region: PolygonRegion, id: string, reason: string) => {
    openSpaces.push({ polygon: region.polygon, ...(region.holes?.length ? { holes: region.holes } : {}), id: `cf-o-${id}`, kind: 'park', landUse: 'vacant' })
    const group = metrics.openReasons[reason] ?? { count: 0, area: 0 }; group.count++; group.area += regionArea(region); metrics.openReasons[reason] = group
    metrics.openSpaceArea += regionArea(region)
  }
  const lineEnds = (region: PolygonRegion, p: Point, direction: Point) => {
    const cuts: number[] = []
    for (const ring of [region.polygon, ...region.holes ?? []]) for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!, dx = b.x - a.x, dy = b.y - a.y, determinant = direction.x * dy - direction.y * dx
      if (Math.abs(determinant) < 1e-8) continue
      const x = a.x - p.x, y = a.y - p.y, along = (x * dy - y * dx) / determinant, across = (x * direction.y - y * direction.x) / determinant
      if (across >= 0 && across <= 1) cuts.push(along)
    }
    cuts.sort((a, b) => a - b)
    for (let i = 1; i < cuts.length; i++) if (cuts[i - 1]! < 0 && cuts[i]! > 0) return [cuts[i - 1]!, cuts[i]!] as const
    return null
  }
  const sharedLane = (region: PolygonRegion, block: PolygonRegion, id: string, allowThrough: boolean): Road | null => {
    const fronts = frontages(region)
    if (!fronts.length || regionArea(region) < 1800) return null
    const bounds = boundsOf(region.polygon)
    let deepest = interior(region), maximum = 0
    for (let x = bounds.minX + 8; x < bounds.maxX; x += 12) for (let y = bounds.minY + 8; y < bounds.maxY; y += 12) {
      const p = { x, y }; if (!pointInRegion(p, region)) continue
      const depth = Math.min(...fronts.map(front => distanceToSegment(p, front.a, front.b)))
      if (depth > maximum) { maximum = depth; deepest = p }
    }
    if (maximum <= 27) return null
    const longest = fronts[0]!, length = distance(longest.a, longest.b), tangent = { x: (longest.b.x - longest.a.x) / length, y: (longest.b.y - longest.a.y) / length }
    const certify = (points: Point[], anchorYears: number[], ground: PolygonRegion): Road | null => {
      const length = points.slice(1).reduce((sum, point, i) => sum + distance(points[i]!, point), 0)
      // Transport owns the street pattern. Land can acquire a short rear
      // access, but cannot bisect a coarse face with another long street.
      if (length > 110) return null
      metrics.laneAttempts++
      const width = 4, strips = points.slice(1).map((b, i) => ({ polygon: corridorPolygon(points[i]!, b, width / 2 + .25) }))
      if (points.length === 4 && points.slice(1).some((b, i) => roadIndex.query(boundsOf(strips[i]!.polygon)).some(segment => {
        if (!publicStreet(segment.road)) return false
        const contact = segmentsCross(points[i]!, b, segment.a, segment.b) || [segment.a, segment.b].some(p => distance(p, points[0]!) > 12 && distanceToSegment(p, points[i]!, b) < 1e-7)
        return contact || i > 0 && distanceToSegment(b, segment.a, segment.b) < segment.road.width / 2 + width / 2 + .25
      }))) return null
      if (strips.some(strip => !physical(strip.polygon, .13))) return null
      const publicGround = roadIndex.query(boundsOf(strips.flatMap(strip => strip.polygon))).map(segment => ({ polygon: segment.polygon }))
      if (strips.some(strip => sumArea(subtractRegions(strip, [ground, ...publicGround])) > .02)) return null
      const checkpoints = points.slice(1).flatMap((b, i) => { const a = points[i]!, count = Math.ceil(distance(a, b) / 4); return Array.from({ length: count + 1 }, (_, n) => ({ x: a.x + (b.x - a.x) * n / count, y: a.y + (b.y - a.y) * n / count })) })
      if (checkpoints.some((q, i) => i > 0 && Math.abs(input.terrain.elevation(q) - input.terrain.elevation(checkpoints[i - 1]!)) > distance(q, checkpoints[i - 1]!) * .13 + .02)) return null
      const builtYear = Math.max(...checkpoints.filter(q => input.demand.at(q) > 0).map(opening), ...anchorYears)
      if (!Number.isFinite(builtYear) || builtYear > 2025) return null
      return { id: `continuous-shared-${id}`, points, width, kind: 'local', role: 'access', builtYear, reason: '閉街区の奥へ接続する実幅の共有接道' }
    }
    for (const direction of allowThrough ? [tangent, { x: -tangent.y, y: tangent.x }] : []) for (const offset of [0, -10, 10]) {
      const p = { x: deepest.x - direction.y * offset, y: deepest.y + direction.x * offset }
      if (!pointInRegion(p, region)) continue
      const parallel = roadIndex.query({ minX: p.x - 35, minY: p.y - 35, maxX: p.x + 35, maxY: p.y + 35 }).some(segment => {
        const length = distance(segment.a, segment.b), alignment = Math.abs(((segment.b.x - segment.a.x) * direction.x + (segment.b.y - segment.a.y) * direction.y) / length)
        const attachment = projectPoint(p, segment.a, segment.b)
        return publicStreet(segment.road) && alignment > .96 && distance(p, attachment) < 35 && physical(corridorPolygon(p, attachment, .65))
      })
      if (parallel) continue
      const ends = lineEnds(region, p, direction)
      if (!ends) continue
      const tips = ends.map(t => ({ x: p.x + direction.x * t, y: p.y + direction.y * t }))
      const anchors = tips.map(tip => roadIndex.query({ minX: tip.x - 20, minY: tip.y - 20, maxX: tip.x + 20, maxY: tip.y + 20 }).filter(segment => publicStreet(segment.road) && distanceToSegment(tip, segment.a, segment.b) <= segment.road.width / 2 + 1).map(segment => ({ segment, point: projectPoint(tip, segment.a, segment.b) })).sort((a, b) => distance(tip, a.point) - distance(tip, b.point))[0])
      if (!anchors[0] || !anchors[1] || distance(anchors[0].point, anchors[1].point) < 30) continue
      const lane = certify([anchors[0].point, p, anchors[1].point], anchors.map(anchor => anchor!.segment.road.builtYear ?? 1650), block)
      if (lane) return lane
    }
    // A deep rear acquisition need not have a second public outlet. Survey a
    // finite shared access with a real12m-wide T turning head instead of giving
    // its entire interior to one frontage house as a fictitious giant garden.
    for (const front of fronts.slice().sort((a, b) => distance(deepest, middle(a.a, a.b)) - distance(deepest, middle(b.a, b.b))).slice(0, 8)) {
      const anchor = projectPoint(middle(front.a, front.b), front.segment.a, front.segment.b), run = distance(anchor, deepest)
      if (run < 35) continue
      const u = { x: (deepest.x - anchor.x) / run, y: (deepest.y - anchor.y) / run }, end = { x: anchor.x + u.x * Math.min(95, run), y: anchor.y + u.y * Math.min(95, run) }, p = middle(anchor, end)
      if (!pointInRegion(end, region)) continue
      if (roadIndex.query({ minX: p.x - 35, minY: p.y - 35, maxX: p.x + 35, maxY: p.y + 35 }).some(segment => { const n = distance(segment.a, segment.b), alignment = Math.abs(((segment.b.x - segment.a.x) * u.x + (segment.b.y - segment.a.y) * u.y) / n), q = projectPoint(p, segment.a, segment.b); return publicStreet(segment.road) && alignment > .96 && distance(p, q) < 35 && physical(corridorPolygon(p, q, .65)) })) continue
      const lane = certify([anchor, end, { x: end.x - u.y * 4, y: end.y + u.x * 4 }, { x: end.x + u.y * 4, y: end.y - u.x * 4 }], [front.segment.road.builtYear ?? 1650], region)
      if (lane) return lane
    }
    return null
  }
  const programmes = (region: PolygonRegion, includeBusiness = true): FrontageProgramme[] => {
    const fronts = frontages(region), intensity = clamp(input.demand.at(interior(region)), 0, 1)
    const frontageByRoad=new Map<string,number>()
    for(const front of fronts)frontageByRoad.set(front.segment.road.id,(frontageByRoad.get(front.segment.road.id)??0)+front.length)
    const ordinary: Stock = intensity >= .72 ? 'compact' : intensity < .38 ? 'garden' : 'ordinary'
    const result: FrontageProgramme[] = fronts.map(front => ({ front, stock: ordinary, from: 0, to: front.length, route: network(front) }))
    const core = (programme: FrontageProgramme) => programme.route.distance < (programme.route.source === 'station' ? 680 : 880)
    const wide = result.filter(programme => (programme.front.segment.road.width >= 8 || programme.front.segment.road.role === 'collector' || programme.route.source === 'station' && programme.route.distance < 300 && programme.front.segment.road.width >= 6) && core(programme) && intensity >= .58).sort((a, b) => a.route.distance - b.route.distance || b.front.segment.road.width - a.front.segment.road.width)[0]
    const local = result.filter(programme => programme.front.segment.road.id !== wide?.front.segment.road.id && programme.front.segment.road.width >= 4.6 && result.filter(other => other.front.segment.road.id === programme.front.segment.road.id).reduce((sum, other) => sum + other.front.length, 0) >= 25 && programme.route.distance < (programme.route.source === 'station' ? 1500 : 1600) && intensity >= .58).sort((a, b) => b.front.length - a.front.length || a.route.distance - b.route.distance)[0]
    // A mixed-use corner or a small apartment acquisition is a contiguous
    // frontage programme, never a fresh apartment/commercial coin per title.
    for (const [programme, stock] of [[wide, 'mixed'], [local, 'walkup']] as const) {
      if (!programme || regionArea(region) < 900) continue
      const front = programme.front, first = network({ ...front, b: front.a, length: 0 }), last = network({ ...front, a: front.b, length: 0 })
      const length = Math.min(front.length, stock === 'mixed' ? programme.route.distance < 260 ? 70 : 38 : 42)
      result.push({ ...programme, stock, from: first.distance <= last.distance ? 0 : front.length - length, to: first.distance <= last.distance ? length : front.length })
      for (const neighbour of result.slice(0, fronts.length)) if (neighbour !== programme && neighbour.front.segment.road.id === front.segment.road.id && neighbour.route.distance <= programme.route.distance + (stock === 'mixed' ? 38 : 42) && distance(middle(neighbour.front.a, neighbour.front.b), middle(front.a, front.b)) <= 42) result.push({ ...neighbour, stock })
    }
    // A business district acquires actual larger holdings along a connected
    // major street before housing subdivision. Continuous chainage bands
    // survive survey segmentation and leave mixed/residential gaps between
    // the office and retail clusters; geometry never spans a public street.
    for (const front of includeBusiness ? fronts : []) {
      const route = network(front), road = front.segment.road
      if (road.width < 8 || intensity < .6 || regionArea(region) < 4500 || (frontageByRoad.get(road.id)??0)<45 || route.distance >= (route.source === 'station' ? 2400 : 2200)) continue
      const segment = front.segment, run = distance(segment.a,segment.b), dx = (segment.b.x-segment.a.x)/run, dy = (segment.b.y-segment.a.y)/run
      const tangent={x:(front.b.x-front.a.x)/front.length,y:(front.b.y-front.a.y)/front.length},p=middle(front.a,front.b),inward=pointInRegion({x:p.x-tangent.y,y:p.y+tangent.x},region)?1:-1
      const depths=region.polygon.map(q=>(q.x-p.x)*-tangent.y+(q.y-p.y)*tangent.x)
      if(Math.max(...depths)-Math.min(...depths)<18)continue
      const side=(-dy*-tangent.y+dx*tangent.x)*inward>0?'left':'right',period=320,phase=seededRandom(`${input.config.seed}:${road.id}:${side}:business-bands`)()*period
      const start=segment.chainage+(front.a.x-segment.a.x)*dx+(front.a.y-segment.a.y)*dy,direction=tangent.x*dx+tangent.y*dy,low=Math.min(start,start+front.length*direction),high=Math.max(start,start+front.length*direction)
      const close=route.distance<(route.source==='station'?1300:1200),bands: {stock:'office'|'retail';from:number;to:number}[]=close?[{stock:'office',from:30,to:125},{stock:'retail',from:195,to:250}]:[{stock:'retail',from:80,to:170}]
      for(let cycle=Math.floor((low-phase)/period);cycle<=Math.floor((high-phase)/period);cycle++)for(const band of bands){
        const left=Math.max(low,phase+cycle*period+band.from),right=Math.min(high,phase+cycle*period+band.to)
        if(right-left<.001)continue
        const a=(left-start)/direction,b=(right-start)/direction
        let from=Math.max(0,Math.min(a,b)),to=Math.min(front.length,Math.max(a,b))
        // Retain the fine-grained established shop approach at a long corner.
        // A tiny survey segment is not itself a separate protected street.
        const shop=result.find(plan=>plan.front===front&&plan.stock==='mixed'&&plan.to-plan.from>=28)
        if(shop){if(shop.from<.01)from=Math.max(from,shop.from+18);else to=Math.min(to,shop.to-18)}
        if(to-from>.001)result.push({front,stock:band.stock,from,to,route})
      }
    }
    // A later apartment group acquires a complete site and service court on
    // an existing connected approach. Its neighbours retain their independent
    // titles; a nearby but disconnected station cannot trigger acquisition.
    for (const front of includeBusiness ? fronts : []) {
      const route = network(front), road = front.segment.road, p = middle(front.a, front.b)
      if (road.width < 5.2 || road.width >= 8 || intensity < .5 || regionArea(region) < 2800 || input.terrain.slope(p) > .065 || Math.max(road.builtYear ?? 1650, opening(p)) < 1955 || route.distance >= (route.source === 'station' ? 1100 : 700) || (frontageByRoad.get(road.id) ?? 0) < 34) continue
      const segment = front.segment, run = distance(segment.a, segment.b), dx = (segment.b.x - segment.a.x) / run, dy = (segment.b.y - segment.a.y) / run
      const start = segment.chainage + (front.a.x - segment.a.x) * dx + (front.a.y - segment.a.y) * dy, direction = ((front.b.x - front.a.x) * dx + (front.b.y - front.a.y) * dy) / front.length
      const low = Math.min(start, start + front.length * direction), high = Math.max(start, start + front.length * direction), period = 340
      const phase = seededRandom(`${input.config.seed}:${road.id}:apartment-sites`)() * period
      for (let cycle = Math.floor((low - phase) / period); cycle <= Math.floor((high - phase) / period); cycle++) {
        const left = Math.max(low, phase + cycle * period + 45), right = Math.min(high, phase + cycle * period + 135)
        if (right - left < .001) continue
        const a = (left - start) / direction, b = (right - start) / direction
        let intervals=[{from:Math.max(0,Math.min(a,b)),to:Math.min(front.length,Math.max(a,b))}]
        // A new apartment group must not replace the already specified shop
        // approach. Clip its proposal before ownership runs are subdivided.
        for(const trade of result.filter(plan=>plan.front===front&&commercialStock(plan.stock)))intervals=intervals.flatMap(interval=>trade.to<=interval.from||trade.from>=interval.to?[interval]:[{from:interval.from,to:Math.min(interval.to,trade.from)},{from:Math.max(interval.from,trade.to),to:interval.to}].filter(part=>part.to-part.from>.001))
        for(const interval of intervals)result.push({front,stock:'walkup',...interval,route,court:true})
      }
    }
    // Acquisitions precede private cuts. Their widths and building programmes
    // follow an ordered sequence on each actual road side, rather than the
    // recursive subdivision serial or one globally repeated house width.
    const overlays = new Map<Frontage, FrontageProgramme[]>()
    for (const plan of result) { const group = overlays.get(plan.front) ?? []; group.push(plan); overlays.set(plan.front, group) }
    return fronts.flatMap(front => {
      const plans = overlays.get(front)!, cuts = [...new Set(plans.flatMap(plan => [plan.from, plan.to]))].sort((a,b)=>a-b)
      const segment = front.segment, length = distance(segment.a,segment.b), dx = (segment.b.x-segment.a.x)/length, dy = (segment.b.y-segment.a.y)/length
      const tangent = {x:(front.b.x-front.a.x)/front.length,y:(front.b.y-front.a.y)/front.length}, midpoint = middle(front.a,front.b)
      const inward = pointInRegion({x:midpoint.x-tangent.y,y:midpoint.y+tangent.x},region)?1:-1
      const side = (-dy * -tangent.y + dx * tangent.x) * inward > 0 ? 'left' : 'right', key = `${segment.road.id}:${side}`
      const start = segment.chainage + (front.a.x-segment.a.x)*dx + (front.a.y-segment.a.y)*dy, direction = tangent.x*dx+tangent.y*dy
      const slope = input.terrain.slope(midpoint), openingYear = opening(midpoint), frontageYear = segment.road.builtYear ?? 1650
      const form: ParcelNeighbourhoodForm = slope > .055 ? 'hillside' : intensity < .38 ? 'edge' : Math.max(frontageYear, openingYear) < 1955 ? 'inherited' : 'planned'
      const depthTarget = continuousLocalStreetForm({ intensity, openingYear, frontageYear, frontageDistance: 0, slope }).depth
      const acquired: FrontageProgramme[] = []
      for(let zone=1;zone<cuts.length;zone++){
        const from=cuts[zone-1]!,to=cuts[zone]!,mid=(from+to)/2,plan=plans.filter(plan=>plan.from<=mid&&plan.to>=mid).at(-1)!
        const cohortLength=businessStock(plan.stock)?144:plan.court?120:72,phase=seededRandom(`${input.config.seed}:${key}:holding-origin`)()*cohortLength
        const low=Math.min(start+from*direction,start+to*direction),high=Math.max(start+from*direction,start+to*direction)
        const group: FrontageProgramme[]=[]
        for(let cohort=Math.floor((low-phase)/cohortLength);cohort<=Math.floor((high-phase)/cohortLength);cohort++){
          const cohortKey=`${key}:${cohort}`,end=phase+(cohort+1)*cohortLength
          for(let position=phase+cohort*cohortLength,index=0;position<end-.001;index++){
            const holding=neighbourhoodHolding(input.config.seed,`${cohortKey}:${index}`,plan.stock,intensity,cohortKey,form,plan.court,depthTarget)
            let width=Math.min(holding.frontage,end-position)
            if(end-position-width<5.25)width=end-position
            const left=Math.max(low,position),right=Math.min(high,position+width)
            if(right-left>.001){const a=(left-start)/direction,b=(right-start)/direction;group.push({...plan,from:Math.max(from,Math.min(a,b)),to:Math.min(to,Math.max(a,b)),holding:{...holding,frontage:width},holdingKey:`${plan.stock}:${cohortKey}:${index}`,form,winged:plan.court || form==='planned' && seededRandom(`${input.config.seed}:${cohortKey}:house-plan`)()<.34})}
            position+=width
          }
        }
        group.sort((a,b)=>a.from-b.from)
        // A clipped end of a real run is part of its neighbouring holding,
        // never a fabricated sub-five-metre independent building title.
        const minimumFrontage=businessStock(plan.stock)?24:plan.stock==='mixed'||plan.stock==='walkup'?12:5.8
        for(let i=0;i<group.length;i++)if(group[i]!.to-group[i]!.from<minimumFrontage&&group.length>1){if(i){group[i-1]!.to=group[i]!.to;group.splice(i--,1)}else{group[1]!.from=group[0]!.from;group.shift();i--}}
        acquired.push(...group)
      }
      return acquired
    })
  }
  const programmeIndex=new WeakMap<FrontageProgramme[],{roads:Map<string,FrontageProgramme[]>;totalFrontage:number}>()
  const acquireBusiness = (region: PolygonRegion, plans: FrontageProgramme[]) => {
    const groups=new Map<string,FrontageProgramme[]>()
    for(const plan of plans)if((businessStock(plan.stock)||plan.court)&&plan.holdingKey){const group=groups.get(plan.holdingKey)??[];group.push(plan);groups.set(plan.holdingKey,group)}
    let remaining:PolygonRegion[]=[region]
    const acquired:{region:PolygonRegion;plans:FrontageProgramme[];roadId:string}[]=[]
    const shopApproaches=plans.filter(plan=>plan.stock==='mixed').map(plan=>{
      const front=plan.front,u={x:(front.b.x-front.a.x)/front.length,y:(front.b.y-front.a.y)/front.length},a={x:front.a.x+u.x*plan.from,y:front.a.y+u.y*plan.from},b={x:front.a.x+u.x*plan.to,y:front.a.y+u.y*plan.to},p=middle(a,b)
      let n={x:-u.y,y:u.x};if(!pointInRegion({x:p.x+n.x,y:p.y+n.y},region))n={x:-n.x,y:-n.y}
      const depth=plan.holding!.depth
      return {polygon:[{x:a.x-n.x*.1,y:a.y-n.y*.1},{x:b.x-n.x*.1,y:b.y-n.y*.1},{x:b.x+n.x*depth,y:b.y+n.y*depth},{x:a.x+n.x*depth,y:a.y+n.y*depth}]}
    })
    // Business acquisitions have priority. Their exact acquired ground and the
    // surviving mixed-use approach also protect corner shops from a court
    // proposed on a different side of the same block.
    for(const group of [...groups.values()].sort((a,b)=>Number(!!a[0]!.court)-Number(!!b[0]!.court)||a[0]!.route.distance-b[0]!.route.distance||a[0]!.holdingKey!.localeCompare(b[0]!.holdingKey!))){
      const plan=group[0]!,holding=plan.holding!,roadId=plan.front.segment.road.id
      const points=group.flatMap(plan=>{const u={x:(plan.front.b.x-plan.front.a.x)/plan.front.length,y:(plan.front.b.y-plan.front.a.y)/plan.front.length};return [plan.from,plan.to].map(distance=>({x:plan.front.a.x+u.x*distance,y:plan.front.a.y+u.y*distance}))})
      const basis=group.slice().sort((a,b)=>b.to-b.from-(a.to-a.from))[0]!,u={x:(basis.front.b.x-basis.front.a.x)/basis.front.length,y:(basis.front.b.y-basis.front.a.y)/basis.front.length},origin=middle(points[0]!,points[1]!)
      let n={x:-u.y,y:u.x}
      if(!pointInRegion({x:origin.x+n.x,y:origin.y+n.y},region))n={x:-n.x,y:-n.y}
      const along=points.map(p=>(p.x-origin.x)*u.x+(p.y-origin.y)*u.y),across=points.map(p=>(p.x-origin.x)*n.x+(p.y-origin.y)*n.y),low=Math.min(...along),high=Math.max(...along),near=Math.min(...across)-.1,far=Math.max(...across)+holding.depth
      const minimumFrontage=plan.court?20:24,minimumArea=plan.court?500:600
      if(high-low<minimumFrontage)continue
      const world=(a:number,b:number)=>({x:origin.x+u.x*a+n.x*b,y:origin.y+u.y*a+n.y*b})
      const mask={polygon:[world(low,near),world(high,near),world(high,far),world(low,far)]}
      const candidate=remaining.flatMap(part=>intersectRegions(part,mask))
      const pieces=(plan.court?candidate.flatMap(part=>subtractRegions(part,shopApproaches)):candidate).filter(part=>regionArea(part)>=minimumArea&&frontages(part).filter(front=>front.segment.road.id===roadId).reduce((sum,front)=>sum+front.length,0)>=minimumFrontage)
      if(!pieces.length)continue
      for(const part of pieces)acquired.push({region:part,plans:group,roadId})
      remaining=remaining.flatMap(part=>subtractRegions(part,pieces))
    }
    return {acquired,remaining}
  }
  const titleProgramme = (cell: Cell, original: PolygonRegion, plans: FrontageProgramme[]): TitleProgramme => {
    const front = cell.frontages[0]!, p = middle(front.a, front.b), intensity = clamp(input.demand.at(interior(cell)), 0, 1)
    let index=programmeIndex.get(plans)
    if(!index){const roads=new Map<string,FrontageProgramme[]>();for(const plan of plans){const group=roads.get(plan.front.segment.road.id)??[];group.push(plan);roads.set(plan.front.segment.road.id,group)}index={roads,totalFrontage:[...new Set(plans.map(plan=>plan.front))].reduce((sum,front)=>sum+front.length,0)};programmeIndex.set(plans,index)}
    const alongRoad=index.roads.get(front.segment.road.id)??[]
    const matches = alongRoad.filter(plan => {
      if (plan.front.segment.road.id !== front.segment.road.id || distanceToSegment(p, plan.front.a, plan.front.b) > .02) return false
      const u = { x: (plan.front.b.x - plan.front.a.x) / plan.front.length, y: (plan.front.b.y - plan.front.a.y) / plan.front.length }, along = (p.x - plan.front.a.x) * u.x + (p.y - plan.front.a.y) * u.y
      return along >= plan.from - .01 && along <= plan.to + .01
    })
    const plan = matches.at(-1), stock = plan?.stock ?? (intensity >= .72 ? 'compact' : intensity < .38 ? 'garden' : 'ordinary')
    const fallbackKey=`${front.segment.road.id}:${Math.floor(p.x/24)}:${Math.floor(p.y/24)}`,holding=plan?.holding??streetHolding(input.config.seed,fallbackKey,stock,intensity)
    const inherited = plan?.form === 'inherited' || !plan?.form && Math.max(front.segment.road.builtYear ?? 1650, opening(p)) < 1955
    const meanDepth = regionArea(original) / Math.max(1, index.totalFrontage), acquiredBusiness=(businessStock(stock)||plan?.court)&&plans.every(plan=>businessStock(plan.stock)||plan.court),depth = acquiredBusiness?holding.depth:Math.min(holding.depth,clamp(meanDepth*(businessStock(stock)?2.4:inherited?1.65:2.1),inherited?16:20,businessStock(stock)?58:inherited?40:48)),frontage=holding.frontage
    const u={x:(front.b.x-front.a.x)/front.length,y:(front.b.y-front.a.y)/front.length},cuts:number[]=[]
    for(const candidate of alongRoad)if(distanceToSegment(p,candidate.front.a,candidate.front.b)<.02){const axis={x:(candidate.front.b.x-candidate.front.a.x)/candidate.front.length,y:(candidate.front.b.y-candidate.front.a.y)/candidate.front.length};for(const end of [candidate.from,candidate.to]){const q={x:candidate.front.a.x+axis.x*end,y:candidate.front.a.y+axis.y*end};if(distanceToSegment(q,front.a,front.b)<.02&&distance(q,front.a)>=5.25&&distance(q,front.b)>=5.25)cuts.push(q.x*u.x+q.y*u.y)}}
    const route = plan?.route ?? { distance: Infinity, availableYear: 2025, formAvailableYear: 2025, source: 'center' as const }
    return { stock, frontage, depth, maximumArea: frontage * depth * 1.28, route, parking: !!plan?.court || stock === 'retail' || stock === 'garden' || stock === 'ordinary' && intensity < .64 || stock === 'walkup' && route.distance > 350, holding, cuts:[...new Set(cuts)], court:!!plan?.court, winged:!!plan?.winged, inherited }
  }
  const split = (cell: Cell, programme: TitleProgramme): Cell[] | null => {
    const front = cell.frontages[0]!, length = front.length, u = { x: (front.b.x - front.a.x) / length, y: (front.b.y - front.a.y) / length }, v = { x: -u.y, y: u.x }
    const extents = [u, v].map((axis, i) => { const values = cell.polygon.map(p => p.x * axis.x + p.y * axis.y); return { axis, low: Math.min(...values), high: Math.max(...values), target: i ? programme.depth : programme.frontage } }).sort((a, b) => (b.high - b.low) / b.target - (a.high - a.low) / a.target)
    const b = boundsOf(cell.polygon), reach = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) * 3 + 20
    for (const { axis, low, high, target } of extents) {
      const count = Math.max(2, Math.round((high - low) / target)), acquisition = clamp(target * Math.max(1, Math.floor(count * .42)) / (high - low), .24, .68)
      const holdingCuts=Math.abs(axis.x*u.x+axis.y*u.y)>.99?programme.cuts.filter(cut=>cut>low+5.25&&cut<high-5.25).sort((a,b)=>Math.abs(a-(low+high)/2)-Math.abs(b-(low+high)/2)).map(cut=>(cut-low)/(high-low)):[]
      const isDepth=Math.abs(axis.x*v.x+axis.y*v.y)>.99,frontDatum=middle(front.a,front.b),datum=frontDatum.x*axis.x+frontDatum.y*axis.y
      const inward=pointInRegion({x:frontDatum.x+axis.x,y:frontDatum.y+axis.y},cell)?1:-1,backLine=isDepth?(datum+inward*programme.depth-low)/(high-low):NaN
      for (const fraction of [...holdingCuts, ...(!programme.inherited&&backLine>.15&&backLine<.85?[backLine]:[]), acquisition, .5, .38, .62]) {
      if (high - low < 11) continue
      const cut = low + (high - low) * fraction, normal = { x: -axis.y, y: axis.x }
      const point = (along: number, across: number): Point => ({ x: axis.x * along + normal.x * across, y: axis.y * along + normal.y * across })
      const across = cell.polygon.map(p => p.x * normal.x + p.y * normal.y), left = Math.min(...across) - reach, right = Math.max(...across) + reach
      const mask = { polygon: [point(low - reach, left), point(cut, left), point(cut, right), point(low - reach, right)] }
      const halves = simpleLineSplit(cell, mask), first = halves?.[0] ?? intersectRegions(cell, mask), second = halves?.[1] ?? subtractRegions(cell, [mask]), parts = [...first, ...second]
      if (!first.length || !second.length || parts.some(part => regionArea(part) < 48)) continue
      const children = parts.map(part => ({ ...part, frontages: frontages(part) }))
      // A strip with only3–4m on the public street cannot fit the minimum
      // house plus side setbacks. Keep it in the neighbouring acquisition.
      if (children.some(part => !part.frontages.some(frontage => {
        const u = { x: (frontage.b.x - frontage.a.x) / frontage.length, y: (frontage.b.y - frontage.a.y) / frontage.length }, projected = part.polygon.map(p => p.x * u.x + p.y * u.y)
        const contact = part.frontages.filter(other => other.segment.road.id === frontage.segment.road.id && Math.abs(((other.b.x - other.a.x) * u.x + (other.b.y - other.a.y) * u.y) / other.length) > .97).reduce((sum, other) => sum + other.length, 0)
        return contact >= 5.25 && Math.max(...projected) - Math.min(...projected) >= 5.25
      }))) continue
      return children
      }
    }
    return null
  }
  const buildingPad = (cell: Cell, front: Frontage, programme: TitleProgramme) => {
    if (cell.holes?.length) return null
    const initialTangent = { x: (front.b.x - front.a.x) / front.length, y: (front.b.y - front.a.y) / front.length }
    const contacts = cell.frontages.filter(other => other.segment.road.id === front.segment.road.id && ((other.b.x - other.a.x) * initialTangent.x + (other.b.y - other.a.y) * initialTangent.y) / other.length > .94)
    const total = contacts.reduce((sum, contact) => sum + contact.length, 0), preferred = contacts.reduce((p, contact) => ({ x: p.x + (contact.a.x + contact.b.x) / 2 * contact.length / total, y: p.y + (contact.a.y + contact.b.y) / 2 * contact.length / total }), { x: 0, y: 0 })
    // One curved frontage can contain dozens of survey segments. Place the
    // entrance at its central actual boundary contact, not at whichever tiny
    // segment happens to sort first near a parcel corner.
    front = contacts.sort((a, b) => distanceToSegment(preferred, a.a, a.b) - distanceToSegment(preferred, b.a, b.b))[0]!
    const origin = projectPoint(preferred, front.a, front.b), tangent = { x: (front.b.x - front.a.x) / front.length, y: (front.b.y - front.a.y) / front.length }
    let normal = { x: -tangent.y, y: tangent.x }
    if (!pointInRegion({ x: origin.x + normal.x, y: origin.y + normal.y }, cell)) normal = { x: -normal.x, y: -normal.y }
    const world = (u: number, v: number): Point => ({ x: origin.x + tangent.x * u + normal.x * v, y: origin.y + tangent.y * u + normal.y * v })
    const us = cell.polygon.map(p => (p.x - origin.x) * tangent.x + (p.y - origin.y) * tangent.y), vs = cell.polygon.map(p => (p.x - origin.x) * normal.x + (p.y - origin.y) * normal.y)
    const stock = programme.stock, large=businessStock(stock), merged = commercialStock(stock) || stock === 'walkup', availableWidth = Math.max(...us) - Math.min(...us), sideParking = programme.parking && !merged && availableWidth >= 13.5
    const frontParking = programme.parking && !sideParking && Math.max(...vs) >= 15
    // The certified entrance strip has a1.1m end cap inside the title.
    // Its clearance is part of site fitting, not an overlap to waive.
    const preferredGap = Math.max(1.25,programme.holding.frontGap,frontParking?5.7:0),siteDepth=Math.max(...vs)
    const frontGap = siteDepth-preferredGap-1.1<5?Math.max(1.25,Math.min(preferredGap,siteDepth-7.1)):preferredGap
    // The programme reserves titled ground for its garden, service court or
    // surveyed parking bay. Roof depth follows that acquisition and usable
    // width, rather than every road getting the same12m-deep building band.
    const roofBudget = regionArea(cell) * programme.holding.coverage
    const desiredWidth = clamp(Math.min(programme.frontage*programme.holding.widthRatio,Math.sqrt(roofBudget*programme.holding.aspect)),large?16:merged?10:4.8,large?52:programme.court?44:merged?32:18)
    const desiredDepth = clamp(roofBudget/Math.min(desiredWidth,availableWidth-(sideParking?4.2:1.3)),6,large?44:merged?24:20)
    const fullWidth = Math.min(desiredWidth, availableWidth - (sideParking ? 4.2 : merged ? 2.4 : 1.3)), fullDepth = Math.min(desiredDepth, Math.max(...vs) - frontGap - 1.1)
    const align = (sideParking ? -1.5 : 0) + programme.holding.sideBias*Math.max(0,availableWidth-fullWidth-1.3)
    let acquiredAccess: { attachment: Point; access: Point[]; covered: boolean } | undefined
    for (const scale of [1, .9, .8, .7, .6]) for (const shift of [align, align - 1, align + 1]) {
      const width = fullWidth * scale, depth = fullDepth * scale
      if (width < 3.8 || depth < 5 || width * depth < 30) continue
      const winged=programme.winged&&width>8&&depth>9
      const backWing = shift + width * (programme.court ? .05 : .22), frontWing = frontGap + depth * (programme.court ? .55 : .75)
      const outline = winged ? [world(shift-width/2,frontGap),world(shift+width/2,frontGap),world(shift+width/2,frontWing),world(backWing,frontWing),world(backWing,frontGap+depth),world(shift-width/2,frontGap+depth)] : [world(shift - width / 2, frontGap), world(shift + width / 2, frontGap), world(shift + width / 2, frontGap + depth), world(shift - width / 2, frontGap + depth)]
      const polygon = outline.map(point => ({ x: Math.round(point.x * 10000) / 10000, y: Math.round(point.y * 10000) / 10000 }))
      if (!containsPolygon(cell, polygon) || !physical(polygon)) continue
      const elevations = [...polygon, middle(polygon[0]!, polygon[2]!)].map(input.terrain.elevation)
      if (Math.max(...elevations) - Math.min(...elevations) > 2.4) continue
      if (!acquiredAccess) {
        const attachment = projectPoint(origin, front.segment.a, front.segment.b), access = corridorPolygon(attachment, origin, 1.1)
        // A straight frontage is the supporting edge of a convex title.
        // Certify each half of its short entrance against the title and one
        // actual surveyed ROW. This is a sufficient exact coverage proof;
        // curved/concave cases retain the general union/difference check.
        const titleConvex = convex(cell.polygon), road = front.segment.polygon
        const inside = titleConvex ? lineClip(access, front.a, front.b, true) : [], outside = titleConvex ? lineClip(access, front.a, front.b, false) : []
        const proved = titleConvex && convex(road) && inside.length >= 3 && outside.length >= 3 && inside.every(p => inConvex(p, cell.polygon)) && outside.every(p => inConvex(p, road))
        const publicGround = proved ? [] : roadIndex.query(boundsOf(access)).filter(segment => segment.road.id === front.segment.road.id).map(segment => ({ polygon: segment.polygon }))
        acquiredAccess = { attachment, access, covered: physical(access) && (proved || sumArea(subtractRegions({ polygon: access }, [cell, ...publicGround])) <= .01) }
      }
      const { attachment, access, covered } = acquiredAccess
      if (!covered || polygonOverlapsRegion(access, { polygon })) continue
      const parking = [world(sideParking ? Math.max(...us) - 3.1 : -1.3, .6), world(sideParking ? Math.max(...us) - .5 : 1.3, .6), world(sideParking ? Math.max(...us) - .5 : 1.3, 5.6), world(sideParking ? Math.max(...us) - 3.1 : -1.3, 5.6)]
      const hasParking = programme.parking && containsPolygon(cell, parking) && physical(parking) && !polygonOverlapsRegion(parking, { polygon })
      return { polygon, entrance: origin, attachment, parking: hasParking, front }
    }
    return null
  }
  const demandMasks = input.demand.regions.map(region => ({ region, bounds: boundsOf(region.polygon) }))
  let serial = 0
  for (const block of input.blocks) {
    const entryArea = localRingArea(block.polygon) - (block.holes ?? []).reduce((sum, hole) => sum + localRingArea(hole), 0)
    if (entryArea >= 0 && entryArea <= .01) {
      // The fixed0.1mm crop kernel may collapse a positive planning sliver.
      // Keep its exact rings as unassigned ground instead of clipping it away
      // or attempting to manufacture a title from non-buildable dimensions.
      unassignedGround.push({ polygon: block.polygon, ...(block.holes?.length ? { holes: block.holes } : {}) })
      metrics.buildableArea += entryArea; metrics.unassignedArea += entryArea
      continue
    }
    const cropped = intersectRegions(block, { polygon: rectangle(0, 0, input.width, input.height) })
    const bounds = boundsOf(block.polygon), roads = roadIndex.query(bounds).map(segment => ({ polygon: segment.polygon }))
    // Open fringe can span the city and intersect thousands of ROW strips.
    // Reuse the bounded fixed-grid difference there; ordinary block-sized
    // inputs keep the same small-component kernel through this wrapper.
    let regions = cropped.flatMap(part => subtractContinuousCover(part, [...obstacles(part), ...roads]))
    const initialArea = sumArea(regions); metrics.buildableArea += initialArea
    const beforeLots = metrics.parcelArea, beforeOpen = metrics.openSpaceArea, beforeUnassigned = metrics.unassignedArea
    const inDemand: PolygonRegion[] = []
    for (const part of regions) {
      const bounds = boundsOf(part.polygon), masks = demandMasks.filter(mask => overlaps(bounds, mask.bounds)).map(mask => mask.region)
      const outside = masks.length ? subtractRegions(part, masks) : [part]
      // Closed faces may straddle the demand edge. Separate their ground
      // before any representative-point decision; demand overlaps are one cut,
      // not duplicate titles or artificial streets between support polygons.
      if (!outside.length) inDemand.push(part)
      else {
        if (masks.length && !(outside.length === 1 && outside[0] === part)) inDemand.push(...subtractRegions(part, outside))
        for (const remainder of outside) {
          unassignedGround.push({ polygon: remainder.polygon, ...(remainder.holes?.length ? { holes: remainder.holes } : {}) })
          metrics.unassignedArea += regionArea(remainder)
        }
      }
    }
    regions = inDemand
    // A new business holding changes only its acquired ground. Keep the
    // surrounding streets' ownership runs and depth reference stable rather
    // than replanning distant housing from the remainder's altered boundary.
    const businessSites:ReturnType<typeof acquireBusiness>['acquired']=[], ordinaryPlanning: { original: PolygonRegion; plans: FrontageProgramme[]; roadIds: Set<string> }[]=[]
    regions=regions.flatMap(region=>{
      if(regionArea(region)<2800||input.demand.at(interior(region))<.5||!frontages(region).some(front=>front.segment.road.width>=5.2))return [region]
      const business=acquireBusiness(region,programmes(region));businessSites.push(...business.acquired)
      if(business.acquired.length){const plans=programmes(region,false);ordinaryPlanning.push({original:region,plans,roadIds:new Set(plans.map(plan=>plan.front.segment.road.id))})}
      return business.remaining
    })
    let blockAccessArea = 0, throughAccesses = 0
    // Missing neighbourhood streets belong to transport, not a second street
    // generator hidden in cadastre. Only a few rear acquisitions are allowed.
    const laneBudget = 4
    for (let laneNumber = 0; laneNumber < laneBudget; laneNumber++) {
      let acquired = false
      for (const region of regions.slice().sort((a, b) => regionArea(b) - regionArea(a))) {
        if (input.demand.at(interior(region)) <= 0) continue
        const lane = sharedLane(region, region, `${block.id}-${laneNumber}`, throughAccesses === 0)
        if (!lane) continue
        const strips = lane.points.slice(1).map((b, i) => ({ polygon: corridorPolygon(lane.points[i]!, b, lane.width / 2 + .25) }))
        const next = regions.flatMap(part => subtractRegions(part, strips)), acquiredArea = sumArea(regions) - sumArea(next)
        if (acquiredArea < 1) continue
        accessRoads.push(lane); addRoad(lane); metrics.accessRoads++; throughAccesses += Number(lane.points.length === 3); blockAccessArea += acquiredArea; regions = next; acquired = true
        if ((lane.builtYear ?? 1650) <= endYear) events.push({ id: `continuous-road-${lane.id}`, year: lane.builtYear ?? 1650, kind: 'road', entityId: lane.id, reason: '住宅地への細い通りが開通' })
        break
      }
      if (!acquired) break
    }
    metrics.accessArea += blockAccessArea
    const pending: { cell: Cell; original: PolygonRegion; plans: FrontageProgramme[]; depth: number }[] = [...businessSites.map(site=>({cell:{...site.region,frontages:frontages(site.region).sort((a,b)=>Number(b.segment.road.id===site.roadId)-Number(a.segment.road.id===site.roadId)||b.length-a.length)},original:site.region,plans:site.plans,depth:0})),...regions.map(region=>{
      const prior=ordinaryPlanning.find(plan=>pointInRegion(interior(region),plan.original))
      if(prior){const added=programmes(region,false).filter(plan=>!prior.roadIds.has(plan.front.segment.road.id));return {cell:{...region,frontages:frontages(region)},original:prior.original,plans:[...prior.plans,...added],depth:0}}
      const intensity=clamp(input.demand.at(interior(region)),0,1),ordinary:Stock=intensity>=.72?'compact':intensity<.38?'garden':'ordinary'
      const plans=programmes(region).map(plan=>businessStock(plan.stock)?{...plan,stock:ordinary,holding:streetHolding(input.config.seed,plan.holdingKey??plan.front.segment.road.id,ordinary,intensity)}:plan)
      return {cell:{...region,frontages:frontages(region)},original:region,plans,depth:0}
    })]
    // A network-first coarse face can contain many real local trees while
    // remaining a single topological face. Budget its private cuts by ground
    // area/minimum48m² title, not the former tiny closed-street-block count.
    const processingBudget = clamp(Math.ceil(initialArea / 48) * 3, 4096, 80_000)
    let processed = 0
    while (pending.length) {
      const { cell, original, plans, depth } = pending.pop()!, cellSerial = serial++, p = interior(cell), intensity = clamp(input.demand.at(p), 0, 1), area = regionArea(cell)
      if (!intensity) {
        // Cover owns this ground's woodland/farm classification. Never publish
        // the working Cell (frontages retain complete road/segment objects).
        unassignedGround.push({ polygon: cell.polygon, ...(cell.holes?.length ? { holes: cell.holes } : {}) })
        metrics.unassignedArea += area
        continue
      }
      if (!cell.frontages.length) { metrics.frontageFailures++; open(cell, String(cellSerial), '実接道を確保できない街区内地'); continue }
      const front = cell.frontages[0]!, programme = titleProgramme(cell, original, plans), major = commercialStock(programme.stock), maximumArea = programme.maximumArea
      if ((area > maximumArea || programme.cuts.length || cell.holes?.length) && depth < 20 && processed++ < processingBudget) {
        const children = split(cell, programme)
        if (children) { for (const child of children) pending.push({ cell: child, original, plans, depth: depth + 1 }); continue }
      }
      let pad: ReturnType<typeof buildingPad> = null
      const tried = new Set<string>()
      for (const contact of cell.frontages) {
        const angle = Math.atan2(contact.b.y - contact.a.y, contact.b.x - contact.a.x), key = `${contact.segment.road.id}:${Math.round(angle * 12 / Math.PI)}`
        if (tried.has(key)) continue
        tried.add(key); pad = buildingPad(cell, contact, programme)
        if (pad || tried.size >= 8) break
      }
      // A surveyed business acquisition is a proposal, not permission to turn
      // an awkward residual into a vacant campus or a house-sized skyscraper.
      // Re-offer unsuitable ground to ordinary frontage ownership with all of
      // the same physical and access checks.
      if((businessStock(programme.stock)||programme.court)&&plans.every(plan=>businessStock(plan.stock)||plan.court)&&(!pad||polygonArea(pad.polygon)<Math.max(programme.stock==='office'?300:200,area*.2))){
        pending.push({cell:{...cell,frontages:frontages(cell)},original:cell,plans:programmes(cell,false).filter(plan=>!businessStock(plan.stock)&&!plan.court),depth:0})
        continue
      }

      const merged = major || programme.stock === 'walkup'
      const createdYear = Math.max(opening(p), ...(pad?.polygon ?? []).map(opening), (pad?.front ?? front).segment.road.builtYear ?? 1650, merged ? programme.route.availableYear : 1650,businessStock(programme.stock)?Math.max(programme.stock==='office'?1955:1970,programme.route.formAvailableYear):programme.court?Math.max(1955,programme.route.formAvailableYear):1650)
      if (!pad || !Number.isFinite(createdYear) || createdYear > 2025) { metrics.formationFailures++; open(cell, String(cellSerial), pad ? '将来形成する接道地' : '形状・地形上の建築不適地'); continue }
      if (area > maximumArea * 2 && polygonArea(pad.polygon) / area < .2) {
        const origin = pad.entrance, served = pad.front, u = { x: (served.b.x - served.a.x) / served.length, y: (served.b.y - served.a.y) / served.length }
        let n = { x: -u.y, y: u.x }
        if (!pointInRegion({ x: origin.x + n.x, y: origin.y + n.y }, cell)) n = { x: -n.x, y: -n.y }
        const reach = Math.hypot(boundsOf(cell.polygon).maxX - boundsOf(cell.polygon).minX, boundsOf(cell.polygon).maxY - boundsOf(cell.polygon).minY) * 2 + 10
        const servedDepth = Math.max(programme.depth, ...pad.polygon.map(q => (q.x - origin.x) * n.x + (q.y - origin.y) * n.y + 1.1))
        const world = (x: number, y: number) => ({ x: origin.x + u.x * x + n.x * y, y: origin.y + u.y * x + n.y * y })
        const band = { polygon: [world(-reach, -reach), world(reach, -reach), world(reach, servedDepth), world(-reach, servedDepth)] }, fronts = intersectRegions(cell, band), rear = subtractRegions(cell, [band])
        // Unserved land cannot be disguised as a many-thousand-square-metre
        // private garden. Retain the physically served acquisition; report the
        // remaining access deficit honestly until a street can be surveyed.
        if (sumArea(rear) > .5 && fronts.some(part => containsPolygon(part, pad.polygon))) {
          rear.forEach((part, i) => open(part, `${cellSerial}-rear-${i}`, '共有接道の延長を確保できない街区内地'))
          for (const part of fronts) pending.push({ cell: { ...part, frontages: frontages(part) }, original, plans, depth: depth + 1 })
          continue
        }
        metrics.formationFailures++; open(cell, String(cellSerial), '取得目的に対して過大な接道不成立地'); continue
      }
      const parcel: Parcel = { id: `cf-p-${cellSerial}`, polygon: cell.polygon, entrance: pad.entrance, access: [pad.attachment, pad.entrance], roadId: pad.front.segment.road.id, createdYear, developedYear: createdYear, use: major ? 'commercial' : 'residential' }
      metrics.parcelArea += area; metrics.lots++; metrics.courtyardLots += Number(programme.court); metrics.wingedRoofs += Number(pad.polygon.length === 6); if (area > maximumArea) metrics.oversizedLots++
      const stockMetrics = metrics.stock[programme.stock] ?? { count: 0, parcelArea: 0, roofArea: 0, parking: 0 }; stockMetrics.count++; stockMetrics.parcelArea += area; stockMetrics.roofArea += polygonArea(pad.polygon); stockMetrics.parking += Number(pad.parking); metrics.stock[programme.stock] = stockMetrics
      const versions: TimelineVersion<Building>[] = []
      for (let year = createdYear, frame = 0; year <= 2025 && frame < 10; frame++) {
        const random = seededRandom(`${input.config.seed}:${parcel.id}:${year}:frame`), height = year < 1955 || year < programme.route.formAvailableYear ? 1 + Number(random() < .45) : programme.stock==='office'?6+Math.floor(random()*7):programme.stock==='retail'?2+Math.floor(random()*3): major ? 3 + Math.floor(random() * (programme.route.distance < 350 ? 4 : 2)) : programme.stock === 'walkup' ? 3 + Math.floor(random() * 2) : programme.stock === 'compact' && programme.route.distance < 650 && intensity >= .85 ? 3 : 1 + Number(random() < .85)
        const building: Building = { id: `cf-b-${cellSerial}-${year}-${frame}`, polygon: pad.polygon.map(point => ({ ...point })), kind: major ? 'commercial' : 'residential', height, parcelId: parcel.id, builtYear: year, occupancy: 'occupied', occupiedHouseholds: major ? 0 : programme.stock === 'walkup' ? Math.max(2, Math.floor(polygonArea(pad.polygon) * height / 60)) : 1 }
        const next = year + buildingServiceYears(input.config.seed, building)
        versions.push({ from: year, ...(next <= 2025 ? { to: next } : {}), value: building }); year = next
      }
      const visible = versions.filter(version => version.from <= endYear)
      if (createdYear <= endYear && visible.length) {
        parcels.push(parcel); buildings.push({ ...visible.at(-1)!.value })
        history.parcels.push({ from: createdYear, value: parcel })
        history.buildings.push(...visible.map(version => version.to !== undefined && version.to > endYear ? { from: version.from, value: version.value } : version))
        for (const version of visible) {
          events.push({ id: `cf-c-${cellSerial}-${version.from}`, year: version.from, kind: 'construction', entityId: version.value.id, reason: version.from === createdYear ? major ? '店舗が開業' : '住宅を新築' : '同じ敷地で建物を建て替え' })
          if (version.to !== undefined && version.to <= endYear) events.push({ id: `cf-d-${cellSerial}-${version.to}`, year: version.to, kind: 'demolition', entityId: version.value.id, reason: '建て替えに伴い旧建物を解体' })
        }
        metrics.privateReplacements += visible.length - 1
      }
    }
    metrics.partitionAreaError += Math.abs(initialArea - blockAccessArea - (metrics.parcelArea - beforeLots) - (metrics.openSpaceArea - beforeOpen) - (metrics.unassignedArea - beforeUnassigned))
  }
  events.sort((a, b) => a.year - b.year || a.id.localeCompare(b.id))
  return { parcels, buildings, accessRoads: accessRoads.filter(road => (road.builtYear ?? 1650) <= endYear), openSpaces, unassignedGround, history, events, metrics }
}
