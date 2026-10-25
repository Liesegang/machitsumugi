import type { CityConfig, Point, Road, Station } from './types'
import { boundsOf, distance, distanceToSegment, pointInPolygon, polygonArea, projectPoint } from './geometry'
import { controlledRoad } from './road-graph'

export interface LayoutLandBlock { id: string; polygon: Point[] }
export interface LayoutLandContextInput {
  roads: readonly Road[]
  center?: Point
  stations?: readonly Pick<Station, 'point' | 'entrance' | 'builtYear'>[]
  blocks?: readonly LayoutLandBlock[]
  settlement?: CityConfig['settlement']
}
export interface LayoutLandFrontage {
  stationWalk: number
  centerWalk: number
  blockId?: string
  form: 'house' | 'shop' | 'apartment'
  stockProfile: 'lowrise' | 'walkup' | 'main-street' | 'bar'
  titleProfile: 'ordinary' | 'compact'
  /** Opening of the actual route that supports compact inner-block holdings. */
  titleAvailableYear: number
  /** Opening of the complete route and station that justify this form. */
  formAvailableYear: number
  maximumFloors: number
  minimumFloors: number
}
interface Segment { road: Road; a: Point; b: Point; length: number; cuts: number[] }
interface Edge { road: Road; a: Point; b: Point; from: number; to: number; length: number }
interface Source { edge: Edge; point: Point; offset: number }
interface WalkingRoute { distance: number; availableYear: number }
const epsilon = 1e-6
const at = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const collector = (road: Road) => road.role === 'collector' || road.kind === 'arterial' && road.width >= 8
const key = (point: Point) => `${Math.round(point.x * 100000)},${Math.round(point.y * 100000)}`
const routeOrder = (a: WalkingRoute, b: WalkingRoute) => a.distance === b.distance || Math.abs(a.distance - b.distance) <= epsilon ? a.availableYear === b.availableYear ? 0 : a.availableYear - b.availableYear : a.distance - b.distance

/** Street accessibility is measured on accepted pavement. A nearby disconnected
 * street across water, a viaduct or a railway never inherits a station's mix. */
export function buildLayoutFirstLandContext(input: LayoutLandContextInput) {
  const segments: Segment[] = [], bins = new Map<string, number[]>()
  const binKeys = (a: Point, b: Point) => {
    const result: string[] = []
    for (let x = Math.floor(Math.min(a.x, b.x) / 120); x <= Math.floor(Math.max(a.x, b.x) / 120); x++) for (let y = Math.floor(Math.min(a.y, b.y) / 120); y <= Math.floor(Math.max(a.y, b.y) / 120); y++) result.push(`${x}:${y}`)
    return result
  }
  for (const road of input.roads) {
    if (controlledRoad(road) || (road.level ?? 0) !== 0 || road.role === 'farm') continue
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!, length = distance(a, b)
      if (length < epsilon) continue
      const current: Segment = { road, a, b, length, cuts: [0, 1] }, nearby = new Set<number>()
      // Long collector links still have a finite station-front / outer-front
      // transition; do not apply one midpoint classification to kilometres.
      for (let along = 100; along < length; along += 100) current.cuts.push(along / length)
      for (const bin of binKeys(a, b)) for (const index of bins.get(bin) ?? []) nearby.add(index)
      for (const index of nearby) {
        const other = segments[index]!, dx = b.x - a.x, dy = b.y - a.y, ox = other.b.x - other.a.x, oy = other.b.y - other.a.y
        const determinant = dx * oy - dy * ox
        if (Math.abs(determinant) > epsilon) {
          const x = other.a.x - a.x, y = other.a.y - a.y, t = (x * oy - y * ox) / determinant, u = (x * dy - y * dx) / determinant
          if (t >= -epsilon && t <= 1 + epsilon && u >= -epsilon && u <= 1 + epsilon) { current.cuts.push(Math.max(0, Math.min(1, t))); other.cuts.push(Math.max(0, Math.min(1, u))) }
        } else {
          // Exact collinear T contacts also subdivide the physical centreline.
          for (const p of [a, b]) if (distanceToSegment(p, other.a, other.b) < epsilon) other.cuts.push(distance(other.a, p) / other.length)
          for (const p of [other.a, other.b]) if (distanceToSegment(p, a, b) < epsilon) current.cuts.push(distance(a, p) / length)
        }
      }
      const index = segments.length
      segments.push(current)
      for (const bin of binKeys(a, b)) { const list = bins.get(bin) ?? []; list.push(index); bins.set(bin, list) }
    }
  }
  const nodes = new Map<string, number>(), adjacency: { to: number; length: number; builtYear: number }[][] = [], byRoad = new Map<string, Edge[]>(), edgeBins = new Map<string, Edge[]>()
  const node = (point: Point) => {
    const k = key(point), previous = nodes.get(k)
    if (previous !== undefined) return previous
    const id = adjacency.length; nodes.set(k, id); adjacency.push([]); return id
  }
  for (const segment of segments) {
    const cuts = [...new Set(segment.cuts.map(t => Math.round(t * 1e9) / 1e9))].sort((a, b) => a - b)
    for (let i = 1; i < cuts.length; i++) {
      const a = at(segment.a, segment.b, cuts[i - 1]!), b = at(segment.a, segment.b, cuts[i]!), length = distance(a, b)
      if (length < epsilon) continue
      const from = node(a), to = node(b), edge: Edge = { road: segment.road, a, b, from, to, length }
      const builtYear = segment.road.builtYear ?? 1650
      adjacency[from]!.push({ to, length, builtYear }); adjacency[to]!.push({ to: from, length, builtYear })
      const list = byRoad.get(segment.road.id) ?? []; list.push(edge); byRoad.set(segment.road.id, list)
      for (const bin of binKeys(a, b)) { const list = edgeBins.get(bin) ?? []; list.push(edge); edgeBins.set(bin, list) }
    }
  }
  const nearest = (point: Point, candidates?: readonly Edge[]) => {
    let nearby: Set<Edge> | undefined
    if (!candidates) {
      nearby = new Set<Edge>()
      for (const bin of binKeys({ x: point.x - 65, y: point.y - 65 }, { x: point.x + 65, y: point.y + 65 })) for (const edge of edgeBins.get(bin) ?? []) nearby.add(edge)
    }
    let best: { edge: Edge; point: Point; offset: number } | undefined, minimum = Infinity
    for (const edge of candidates ?? nearby!) { const projected = projectPoint(point, edge.a, edge.b), offset = distance(point, projected); if (offset < minimum) { best = { edge, point: projected, offset }; minimum = offset } }
    return best
  }
  const walking = (points: readonly { point: Point; builtYear: number }[]) => {
    const sources = points.map(source => { const hit = nearest(source.point); return hit ? { ...hit, builtYear: source.builtYear } : undefined }).filter((hit): hit is Source & { builtYear: number } => !!hit && hit.offset <= 65)
    const routes: WalkingRoute[] = adjacency.map(() => ({ distance: Infinity, availableYear: Infinity })), heap: (WalkingRoute & { node: number })[] = []
    const priority = (a: WalkingRoute & { node: number }, b: WalkingRoute & { node: number }) => routeOrder(a, b) || a.node - b.node
    const push = (node: number, distance: number, availableYear: number) => {
      const route = { distance, availableYear }
      if (routeOrder(route, routes[node]!) >= 0) return
      routes[node] = route
      let i = heap.length; const item = { node, ...route }; heap.push(item)
      while (i > 0) { const parent = (i - 1) >> 1; if (priority(heap[parent]!, item) <= 0) break; heap[i] = heap[parent]!; i = parent } heap[i] = item
    }
    for (const source of sources) for (const [node, point] of [[source.edge.from, source.edge.a], [source.edge.to, source.edge.b]] as const) {
      const length = source.offset + distance(point, source.point)
      push(node, length, Math.max(source.builtYear, length > epsilon ? source.edge.road.builtYear ?? 1650 : 1650))
    }
    while (heap.length) {
      const current = heap[0]!, last = heap.pop()!
      if (heap.length) {
        let i = 0
        while (i * 2 + 1 < heap.length) { let child = i * 2 + 1; if (child + 1 < heap.length && priority(heap[child + 1]!, heap[child]!) < 0) child++; if (priority(heap[child]!, last) >= 0) break; heap[i] = heap[child]!; i = child } heap[i] = last
      }
      if (routeOrder(current, routes[current.node]!) > 0) continue
      for (const next of adjacency[current.node]!) push(next.to, current.distance + next.length, Math.max(current.availableYear, next.builtYear))
    }
    return (edge: Edge, point: Point): WalkingRoute => {
      const candidates = ([{ node: edge.from, point: edge.a }, { node: edge.to, point: edge.b }]).map(end => {
        const length = distance(end.point, point), route = routes[end.node]!
        return { distance: route.distance + length, availableYear: Math.max(route.availableYear, length > epsilon ? edge.road.builtYear ?? 1650 : 1650) }
      })
      for (const source of sources) if (source.edge === edge) {
        const length = source.offset + distance(source.point, point)
        candidates.push({ distance: length, availableYear: Math.max(source.builtYear, length > epsilon ? edge.road.builtYear ?? 1650 : 1650) })
      }
      return candidates.sort(routeOrder)[0]!
    }
  }
  const stationWalking = walking((input.stations ?? []).map(station => ({ point: station.entrance ?? station.point, builtYear: station.builtYear ?? 1900 }))), centerWalking = walking(input.center ? [{ point: input.center, builtYear: 1650 }] : [])
  const blocks = (input.blocks ?? []).map(block => {
    const bounds = boundsOf(block.polygon)
    // Apartment frontage requires an actual adequately sized street block with
    // a collector edge, not the nominal colour of a large district polygon.
    const boundary = block.polygon.map((a, i) => nearest(at(a, block.polygon[(i + 1) % block.polygon.length]!, .5))).filter((hit): hit is Source => !!hit && hit.offset < 2)
    const span = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY), area = polygonArea(block.polygon)
    return { ...block, bounds, barSite: area >= 3800 && span >= 64, walkupSite: area >= 1400 && span >= 32,
      stationWalk: Math.min(Infinity, ...boundary.map(hit => stationWalking(hit.edge, hit.point).distance)), centerWalk: Math.min(Infinity, ...boundary.map(hit => centerWalking(hit.edge, hit.point).distance)) }
  })
  const settlement = input.settlement ?? 'regional-city', metropolitan = settlement === 'metropolis'
  const urban = metropolitan || settlement === 'regional-city'
  const stationWalkupReach = metropolitan ? 850 : 500, centerWalkupReach = metropolitan ? 1050 : 650
  const stationFrontageReach = metropolitan ? 320 : 180, centerFrontageReach = metropolitan ? 520 : 260
  const stationBarReach = metropolitan ? 750 : 520, centerBarReach = metropolitan ? 950 : 520
  const stationCompactReach = metropolitan ? 650 : 400, centerCompactReach = metropolitan ? 800 : 500
  const contextCache = new Map<Edge, { stationWalk: number; centerWalk: number }>()
  return {
    at(road: Road, point: Point, landPoint: Point = point): LayoutLandFrontage {
      const projection = nearest(point, byRoad.get(road.id) ?? [])
      if (!projection) return { stationWalk: Infinity, centerWalk: Infinity, form: 'house', stockProfile: 'lowrise', titleProfile: 'ordinary', titleAvailableYear: 1650, minimumFloors: 1, maximumFloors: 2, formAvailableYear: 1650 }
      const { edge } = projection
      let context = contextCache.get(edge)
      if (!context) {
        const middle = at(edge.a, edge.b, .5)
        context = { stationWalk: stationWalking(edge, middle).distance, centerWalk: centerWalking(edge, middle).distance }; contextCache.set(edge, context)
      }
      const stationRoute = stationWalking(edge, projection.point), centerRoute = centerWalking(edge, projection.point)
      const stationWalk = stationRoute.distance, centerWalk = centerRoute.distance
      const block = blocks.find(block => landPoint.x >= block.bounds.minX && landPoint.x <= block.bounds.maxX && landPoint.y >= block.bounds.minY && landPoint.y <= block.bounds.maxY && pointInPolygon(landPoint, block.polygon))
      const major = collector(road) && road.width >= 8
      const stationShop = major ? context.stationWalk <= stationFrontageReach : context.stationWalk <= 180
      const centerShop = major ? context.centerWalk <= centerFrontageReach : context.centerWalk <= 180 && road.width >= 6
      const shop = stationShop || centerShop
      const stationBars = major && context.stationWalk <= stationBarReach
      const centralBars = major && context.centerWalk <= centerBarReach
      const apartment = !shop && road.width >= 6 && (stationBars || centralBars) && (!block || block.barSite)
      // A local street gains compact walkups as part of an actual walkable
      // block catchment. Its buildings keep ordinary small footprints; this
      // profile never widens titles or flips individual plots into compounds.
      const stationWalkups = urban && !!block?.walkupSite && context.stationWalk <= stationWalkupReach && block.stationWalk <= stationWalkupReach * .9
      const centerWalkups = urban && !!block?.walkupSite && context.centerWalk <= centerWalkupReach && block.centerWalk <= centerWalkupReach * .9
      const walkup = !apartment && !major && road.width >= 5.2 && (stationWalkups || centerWalkups)
      // Fine-grain land division is a block catchment, including narrow public
      // lanes. It is distinct from the height profile of an individual building.
      const stationCompact = urban && road.width >= 4 && !!block?.walkupSite && context.stationWalk <= stationCompactReach && block.stationWalk <= stationCompactReach * .9
      const centerCompact = urban && road.width >= 4 && !!block?.walkupSite && context.centerWalk <= centerCompactReach && block.centerWalk <= centerCompactReach * .9
      const titleRoutes = [stationCompact ? stationRoute : undefined, centerCompact ? centerRoute : undefined].filter((route): route is WalkingRoute => !!route)
      const titleProfile = titleRoutes.length ? 'compact' : 'ordinary'
      const titleAvailableYear = titleRoutes.length ? titleRoutes.sort(routeOrder)[0]!.availableYear : 1650
      const qualifyingRoutes: WalkingRoute[] = []
      if (shop ? stationShop : apartment ? stationBars : walkup && stationWalkups) qualifyingRoutes.push(stationRoute)
      if (shop ? centerShop : apartment ? centralBars : walkup && centerWalkups) qualifyingRoutes.push(centerRoute)
      const formAvailableYear = qualifyingRoutes.length ? qualifyingRoutes.sort(routeOrder)[0]!.availableYear : 1650
      const mainStreet = urban && major && shop
      const coreFrontage = context.stationWalk <= (metropolitan ? 200 : 120) || context.centerWalk <= (metropolitan ? 320 : 180)
      const stockProfile = mainStreet ? 'main-street' : apartment ? 'bar' : walkup ? 'walkup' : 'lowrise'
      const minimumFloors = mainStreet || apartment ? urban ? 4 : 2 : walkup ? 3 : 1
      const maximumFloors = mainStreet ? metropolitan && coreFrontage ? 8 : 6 : apartment ? metropolitan ? 6 : urban ? 5 : settlement === 'village' ? 2 : 3 : walkup ? 4 : shop ? 3 : 2
      return { stationWalk, centerWalk, ...(block ? { blockId: block.id } : {}), form: shop ? 'shop' : apartment ? 'apartment' : 'house', stockProfile, titleProfile, titleAvailableYear, formAvailableYear, minimumFloors, maximumFloors }
    },
  }
}
