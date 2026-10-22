import type { Building, CityConfig, GrowthEvent, Parcel, Point, Road, SimulationSnapshot, Station } from './types'
import { boundsOf, distance, overlaps, polygonsOverlap, projectPoint, seededRandom } from './geometry'
import type { Bounds } from './geometry'
import { scenarioDemandAtYear } from './urban-growth'
import { roadTravelSpeed } from './road-graph'

export const GENERATOR_VERSION = '2.0.0'
export const EPOCH_YEAR = { historic: 1800, railway: 1930, present: 2025 } as const

interface Candidate {
  parcel: Parcel; footprint: Point[]; frontage: Point; road: Road; segment: number
  area: number; reluctance: number; capacity: number; building?: Building
}
interface DevelopmentInput {
  config: CityConfig; roads: Road[]; center: Point; stations: Station[]
  centers?: { point: Point; activeYear: number; catchment: number; weight: number; kind?: string }[]
  /** Tests the complete land polygon against physical obstacles present in this year. */
  canPlace(polygon: Point[], year: number): boolean
  slope(point: Point): number
}

// Spatial buckets keep full polygon tests local; no center-only collision test.
function index<T extends { bounds: Bounds }>() {
  const cells = new Map<string, T[]>()
  const keys = function* (b: Bounds) { for (let x = Math.floor(b.minX / 60); x <= Math.floor(b.maxX / 60); x++) for (let y = Math.floor(b.minY / 60); y <= Math.floor(b.maxY / 60); y++) yield `${x}:${y}` }
  return {
    add(item: T) { for (const key of keys(item.bounds)) { const list = cells.get(key) ?? []; list.push(item); cells.set(key, list) } },
    query(bounds: Bounds) { const found = new Set<T>(); for (const key of keys(bounds)) for (const item of cells.get(key) ?? []) if (overlaps(bounds, item.bounds)) found.add(item); return [...found] },
  }
}

/** Shared-point road graph. Curve samples are degree-two vertices, not intersections. */
function accessibility(roads: Road[], destinations: Point[]) {
  const ids = new Map<string, number[]>(), points: Point[] = [], edges: { to: number; cost: number }[][] = []
  const node = (p: Point) => {
    const x = Math.floor(p.x * 5), y = Math.floor(p.y * 5)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const id of ids.get(`${x + dx}:${y + dy}`) ?? []) if (distance(points[id]!, p) < .15) return id
    const key = `${x}:${y}`, id = points.length, list = ids.get(key) ?? []
    list.push(id); ids.set(key, list); points.push(p); edges.push([])
    return id
  }
  const roadNodes = new Map<string, number[]>()
  for (const road of roads) {
    const nodes = road.points.map(node); roadNodes.set(road.id, nodes)
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1]!, b = nodes[i]!, cost = distance(points[a]!, points[b]!) / roadTravelSpeed(road)
      edges[a]!.push({ to: b, cost }); edges[b]!.push({ to: a, cost })
    }
  }
  const times = new Float64Array(points.length).fill(Infinity)
  const sources: { roadId: string; segment: number; point: Point; walking: number }[] = []
  // Binary min-heap; the value is travel time in minutes, using relative speeds.
  const heap: { node: number; cost: number }[] = []
  const push = (item: { node: number; cost: number }) => { let i = heap.length; heap.push(item); while (i > 0) { const p = (i - 1) >> 1; if (heap[p]!.cost <= item.cost) break; heap[i] = heap[p]!; i = p } heap[i] = item }
  const pop = () => { const first = heap[0]!, last = heap.pop()!; if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let child = i * 2 + 1; if (child + 1 < heap.length && heap[child + 1]!.cost < heap[child]!.cost) child++; if (last.cost <= heap[child]!.cost) break; heap[i] = heap[child]!; i = child } heap[i] = last } return first }
  for (const destination of destinations) {
    let nearest: { road: Road; segment: number; point: Point; d: number } | null = null
    for (const road of roads) for (let i = 1; i < road.points.length; i++) {
      const p = projectPoint(destination, road.points[i - 1]!, road.points[i]!), d = distance(destination, p)
      if (!nearest || d < nearest.d) nearest = { road, segment: i, point: p, d }
    }
    if (nearest) {
      sources.push({ roadId: nearest.road.id, segment: nearest.segment, point: nearest.point, walking: nearest.d / 75 })
      const ids = roadNodes.get(nearest.road.id)!
      for (const i of [nearest.segment - 1, nearest.segment]) {
        const cost = nearest.d / 75 + distance(nearest.point, nearest.road.points[i]!) / roadTravelSpeed(nearest.road), id = ids[i]!
        if (cost < times[id]!) { times[id] = cost; push({ node: id, cost }) }
      }
    }
  }
  while (heap.length) {
    const item = pop(); if (item.cost !== times[item.node]) continue
    for (const edge of edges[item.node]!) if (item.cost + edge.cost < times[edge.to]!) { times[edge.to] = item.cost + edge.cost; push({ node: edge.to, cost: times[edge.to]! }) }
  }
  return (candidate: Candidate) => {
    const nodes = roadNodes.get(candidate.road.id)
    if (!nodes) return Infinity
    const a = Math.min(candidate.segment - 1, nodes.length - 1), b = Math.min(candidate.segment, nodes.length - 1)
    let direct = Infinity
    const speed = roadTravelSpeed(candidate.road)
    for (const source of sources) if (source.roadId === candidate.road.id && source.segment === candidate.segment) direct = Math.min(direct, source.walking + distance(source.point, candidate.frontage) / speed)
    return Math.min(direct, times[nodes[a]!]! + distance(candidate.frontage, candidate.road.points[a]!) / speed, times[nodes[b]!]! + distance(candidate.frontage, candidate.road.points[b]!) / speed)
  }
}

/**
 * Parcels precede buildings. Fixed frontages survive later periods; development consumes
 * housing demand in five-year steps. These are explicit scenario assumptions, not a
 * calibrated demographic forecast. No global tessellation or pixel-density stamping.
 */
export function developLand(input: DevelopmentInput) {
  const { config, center, canPlace, slope, stations } = input
  const industry = input.centers?.find(c => c.kind === 'industrial')
  const end = EPOCH_YEAR[config.era ?? 'present'], candidates: Candidate[] = [], events: GrowthEvent[] = [], snapshots: SimulationSnapshot[] = []
  const lots = index<{ polygon: Point[]; bounds: Bounds }>()
  const roads = [...input.roads].sort((a, b) => (a.builtYear ?? 1700) - (b.builtYear ?? 1700) || a.id.localeCompare(b.id))
  for (const road of roads) {
    if (road.bridge || road.role === 'bridge') continue
    const year = road.builtYear ?? 1700, random = seededRandom(`${config.seed}:parcels:${road.id}`)
    const old = year < 1900
    let remaining = 12 + random() * 8, serial = 0
    for (let segment = 1; segment < road.points.length; segment++) {
      const a = road.points[segment - 1]!, b = road.points[segment]!, length = distance(a, b)
      if (length < .001) continue
      const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length
      while (remaining < length) {
        const frontage = { x: a.x + ux * remaining, y: a.y + uy * remaining }
        const industrial = road.id.startsWith('industrial') || (config.type === 'port' && industry && distance(frontage, industry.point) < industry.catchment * .75 && road.role !== 'farm')
        const width = industrial ? 32 + random() * 20 : old ? 10 + random() * 9 : 13 + random() * 10
        for (const side of [-1, 1]) {
          const lotRandom = seededRandom(`${config.seed}:parcel:${road.id}:${serial}:${side}`)
          const depth = industrial ? 34 + lotRandom() * 19 : old ? 26 + lotRandom() * 13 : 25 + lotRandom() * 13
          const setback = road.width / 2 + 2.6
          const transform = (x: number, y: number): Point => ({ x: Math.round((frontage.x + x * ux - (setback + y) * uy * side) * 10) / 10, y: Math.round((frontage.y + x * uy + (setback + y) * ux * side) * 10) / 10 })
          const polygon = [transform(-width / 2 + .4, 0), transform(width / 2 - .4, 0), transform(width / 2 - .4, depth), transform(-width / 2 + .4, depth)]
          const bounds = boundsOf(polygon)
          if (!canPlace(polygon, year) || slope(transform(0, depth / 2)) > .22 || lots.query(bounds).some(lot => polygonsOverlap(lot.polygon, polygon))) continue
          const id = `parcel-${road.id}-${serial}-${side}`
          const reluctant = lotRandom(), buildingWidth = width * (industrial ? .8 : old ? .86 : .72), buildingDepth = depth * (industrial ? .8 : old ? .66 : .55)
          const garden = old ? 1.2 : 4 + lotRandom() * 3
          const cutCorner = !industrial && lotRandom() < .28
          const footprint = cutCorner ? [transform(-buildingWidth / 2, garden), transform(buildingWidth / 2, garden), transform(buildingWidth / 2, garden + buildingDepth * .63), transform(buildingWidth * .18, garden + buildingDepth * .63), transform(buildingWidth * .18, garden + buildingDepth), transform(-buildingWidth / 2, garden + buildingDepth)] : [transform(-buildingWidth / 2, garden), transform(buildingWidth / 2, garden), transform(buildingWidth / 2, garden + buildingDepth), transform(-buildingWidth / 2, garden + buildingDepth)]
          const parcel: Parcel = { id, polygon, entrance: transform(0, 0), roadId: road.id, createdYear: year, use: industrial ? 'industrial' : 'residential' }
          candidates.push({ parcel, footprint, frontage, road, segment, area: width * depth, reluctance: reluctant, capacity: 1 })
          lots.add({ polygon, bounds })
        }
        remaining += width + 1.2; serial++
      }
      remaining -= length
    }
  }
  let capacity = 0, industrialJobs = 0
  const built: Candidate[] = []
  for (let year = 1700; year <= end; year += 5) {
    const activeRoads = roads.filter(r => (r.builtYear ?? 1700) <= year)
    const activeStations = year >= 1900 ? stations : []
    const destinations = input.centers?.filter(c => c.activeYear <= year).map(c => c.point) ?? [center]
    const travel = accessibility(activeRoads, [...destinations, ...activeStations.map(s => s.point)])
    const { households, jobs } = scenarioDemandAtYear(config, year)
    // Reuse existing capacity before making a new development commitment.
    const shortage = Math.max(0, Math.ceil(households * 1.035) - capacity)
    if (shortage > 0) {
      const ranked = candidates.filter(c => !c.building && c.parcel.createdYear <= year && (c.parcel.use !== 'industrial' || year >= (industry?.activeYear ?? 1750))).map(c => {
        const time = travel(c)
        const station = activeStations.length ? Math.min(...activeStations.map(s => distance(c.frontage, s.point))) : Infinity
        const urban = Math.exp(-time * (year < 1900 ? 2.7 : year < 1950 ? 1.5 : 1) / 7)
        const centers = input.centers ?? [{ point: center, activeYear: 1650, catchment: 640, weight: 1.15 }]
        const reach = centers.filter(center => center.activeYear <= year).reduce((total, center) => total + center.weight * Math.exp(-distance(c.frontage, center.point) / (center.catchment * (year < 1900 ? .95 : 1.25))), 0)
        const pressure = 1 + .75 * Math.log1p(Math.max(0, households - 100) / 250)
        const suitability = Math.max(.25, 1 - slope(c.frontage) * 4)
        return { c, time, station, score: pressure * urban * reach * suitability - c.reluctance * (year < 1950 ? .30 : .22) - (c.road.role === 'farm' ? .12 : 0) }
      }).filter(r => Number.isFinite(r.time) && r.score > (year < 1900 ? .045 : .025)).sort((a, b) => b.score - a.score || a.c.parcel.id.localeCompare(b.c.parcel.id))
      let added = 0
      for (const { c, station, time } of ranked) {
        if (added >= shortage) break
        if (c.parcel.use === 'industrial' && industrialJobs >= jobs * .45) continue
        if (!canPlace(c.footprint, year)) continue
        const random = seededRandom(`${config.seed}:building:${c.parcel.id}`)
        const commercial = c.parcel.use !== 'industrial' && ((time < 2.5 && c.road.role !== 'farm' && random() < .48) || (station < 230 && random() < .72))
        const apartment = year >= 1960 && station < 550 && random() < .3
        c.parcel.use = c.parcel.use === 'industrial' ? 'industrial' : commercial ? 'commercial' : 'residential'
        c.parcel.developedYear = year
        const height = c.parcel.use === 'industrial' ? 1 : commercial ? year < 1900 ? 2 : 3 + Math.floor(random() * 3) : apartment ? 3 + Math.floor(random() * 5) : 1 + Math.floor(random() * 2)
        c.capacity = c.parcel.use === 'industrial' ? 0 : apartment ? height * 2 : commercial ? 1 : 1
        c.building = { id: `building-${c.parcel.id}`, parcelId: c.parcel.id, builtYear: year, polygon: c.footprint, kind: c.parcel.use, height }
        built.push(c); capacity += c.capacity; added += c.capacity
        if (c.parcel.use === 'industrial') industrialJobs += Math.round(c.area / 35)
        events.push({ id: `construction-${c.parcel.id}`, year, kind: 'construction', entityId: c.building.id, reason: c.parcel.use === 'industrial' ? '物流に接続した事業用地の供給' : '既存空室を使い切った後の住宅・商業需要' })
      }
    }
    // Station access can pay for rebuilding ageing stock after vacant capacity has
    // been used. Property boundaries survive; the old and new buildings are events.
    if (year >= 1960 && activeStations.length && capacity < households) {
      const random = seededRandom(`${config.seed}:redevelopment:${year}`)
      for (const c of [...built].sort((a, b) => a.parcel.id.localeCompare(b.parcel.id))) {
        if (capacity >= households * 1.035) break
        const old = c.building!
        if (old.kind === 'industrial' || c.capacity > 1 || year - (old.builtYear ?? year) < 35 || c.area < 320) continue
        const station = Math.min(...activeStations.map(s => distance(c.frontage, s.point)))
        if (station > 430 || random() > .055) continue
        const pressure = 1 + .75 * Math.log1p(Math.max(0, households - 100) / 250)
        const floors = station < 220 ? 5 : 3, newCapacity = floors * 2
        if ((newCapacity - c.capacity) * pressure < 4 + c.reluctance * 20) continue
        const [a, b, , d] = c.parcel.polygon
        const inset = (u: number, v: number) => ({ x: Math.round((a!.x + (b!.x - a!.x) * u + (d!.x - a!.x) * v) * 10) / 10, y: Math.round((a!.y + (b!.y - a!.y) * u + (d!.y - a!.y) * v) * 10) / 10 })
        const renewed = [inset(.07, .10), inset(.93, .10), inset(.93, .88), inset(.07, .88)]
        if (!canPlace(renewed, year)) continue
        events.push({ id: `redevelop-acquire-${year}-${c.parcel.id}`, year, kind: 'acquisition', entityId: old.id, reason: '駅周辺の住宅需要による老朽建物の建替え' })
        c.building = { ...old, id: `building-${c.parcel.id}-${year}`, builtYear: year, height: floors, polygon: renewed }
        capacity += newCapacity - c.capacity; c.capacity = newCapacity
        events.push({ id: `redevelop-build-${year}-${c.parcel.id}`, year, kind: 'construction', entityId: c.building.id, reason: '既存敷地を継承した共同住宅への建替え' })
      }
    }
    // Later road acquisition is explicit; surviving old lots keep their IDs and shape.
    for (let i = built.length - 1; i >= 0; i--) {
      const c = built[i]!
      if (!canPlace(c.building!.polygon, year)) {
        capacity -= c.capacity
        if (c.parcel.use === 'industrial') industrialJobs -= Math.round(c.area / 35)
        events.push({ id: `acquisition-${year}-${c.parcel.id}`, year, kind: 'acquisition', entityId: c.building!.id, reason: '後年の交通用地取得' })
        c.building = undefined; c.parcel.developedYear = undefined; built.splice(i, 1)
      }
    }
    if (year % 25 === 0 || year === end || year === 1930) snapshots.push({ year, households, capacity, vacant: Math.max(0, capacity - households), unmet: Math.max(0, households - capacity), roads: activeRoads.length, buildings: built.length })
  }
  return { buildings: built.map(c => c.building!), parcels: candidates.map(c => c.parcel), events, snapshots }
}
