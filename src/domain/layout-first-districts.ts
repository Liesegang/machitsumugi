import { union } from 'polygon-clipping'
import { buildDistricts } from './districts'
import type { DistrictInput } from './districts'
import type { Bounds, PolygonRegion } from './geometry'
import type { District, Point } from './types'
import { boundsOf, distance, overlaps, pointInPolygon, pointInRegion, projectPoint, regionArea } from './geometry'
import { controlledRoad, materializeRoadJunctions, MinHeap, roadTravelSpeed } from './road-graph'
import { provisionalPlaceName } from './place-names'

interface Segment { a: Point; b: Point; roadId: string; cost: number; bounds: Bounds; cuts: { t: number; town: number; point: Point }[] }
interface Binding { node: number; walk: number; component: number }
function spatial<T extends { bounds: Bounds }>(items: T[], step = 250) {
  const bins = new Map<string, T[]>()
  for (const item of items) for (let x = Math.floor(item.bounds.minX / step); x <= Math.floor(item.bounds.maxX / step); x++) for (let y = Math.floor(item.bounds.minY / step); y <= Math.floor(item.bounds.maxY / step); y++) {
    const key = `${x}:${y}`, list = bins.get(key) ?? []; list.push(item); bins.set(key, list)
  }
  return (bounds: Bounds) => {
    const result = new Set<T>()
    for (let x = Math.floor(bounds.minX / step); x <= Math.floor(bounds.maxX / step); x++) for (let y = Math.floor(bounds.minY / step); y <= Math.floor(bounds.maxY / step); y++) for (const item of bins.get(`${x}:${y}`) ?? []) if (overlaps(bounds, item.bounds)) result.add(item)
    return [...result]
  }
}
function roadNetwork(input: DistrictInput, towns: District[]) {
  const roads = materializeRoadJunctions(input.roads.filter(road => !controlledRoad(road) && (road.level ?? 0) === 0).sort((a, b) => a.id.localeCompare(b.id)))
  const segments: Segment[] = []
  for (const road of roads) for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]!, b = road.points[i]!, length = distance(a, b)
    if (length > .001) segments.push({ a, b, roadId: road.id, cost: length / roadTravelSpeed(road), bounds: boundsOf([a, b]), cuts: [] })
  }
  const nearSegments = spatial(segments), parcels = spatial(input.parcels.filter(parcel => parcel.developedYear && parcel.retiredYear === undefined).map(parcel => ({ parcel, bounds: boundsOf(parcel.polygon) })))
  const bindings: (Binding | undefined)[] = new Array(towns.length)
  for (const [i, town] of towns.entries()) {
    const p = town.point
    // Use the anchor holding's recorded road, rather than snapping across an
    // unbridged river to whichever unrelated carriageway happens to be closer.
    const anchorRoads = new Set(parcels({ minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }).filter(record => pointInPolygon(p, record.parcel.polygon)).map(record => record.parcel.roadId))
    let nearest: { segment: Segment; point: Point; distance: number } | undefined
    for (const radius of [250, 750, Math.max(input.width, input.height)]) {
      for (const segment of nearSegments({ minX: p.x - radius, minY: p.y - radius, maxX: p.x + radius, maxY: p.y + radius })) {
        if (anchorRoads.size && !anchorRoads.has(segment.roadId)) continue
        const point = projectPoint(p, segment.a, segment.b), d = distance(point, p)
        if (!nearest || d < nearest.distance) nearest = { segment, point, distance: d }
      }
      if (nearest) break
    }
    if (!nearest) continue
    const length = distance(nearest.segment.a, nearest.segment.b), t = distance(nearest.segment.a, nearest.point) / length
    nearest.segment.cuts.push({ t, town: i, point: nearest.point })
    bindings[i] = { node: -1, walk: nearest.distance / 75, component: -1 }
  }
  const keys = new Map<string, number>(), edges: { to: number; cost: number }[][] = []
  const node = (point: Point) => {
    const key = `${Math.round(point.x * 10000)}:${Math.round(point.y * 10000)}`, existing = keys.get(key)
    if (existing !== undefined) return existing
    const id = edges.length; keys.set(key, id); edges.push([]); return id
  }
  for (const segment of segments) {
    const cuts = [{ t: 0, town: -1, point: segment.a }, ...segment.cuts, { t: 1, town: -1, point: segment.b }].sort((a, b) => a.t - b.t || a.town - b.town)
    for (let i = 0; i < cuts.length; i++) {
      const cut = cuts[i]!, id = node(cut.point)
      if (cut.town >= 0) bindings[cut.town]!.node = id
      if (!i) continue
      const previous = cuts[i - 1]!, from = node(previous.point), cost = (cut.t - previous.t) * segment.cost
      if (from !== id) { edges[from]!.push({ to: id, cost }); edges[id]!.push({ to: from, cost }) }
    }
  }
  const components = new Int32Array(edges.length).fill(-1)
  let component = 0
  for (let i = 0; i < edges.length; i++) if (components[i] === -1) {
    const queue = [i]; components[i] = component
    for (let j = 0; j < queue.length; j++) for (const edge of edges[queue[j]!]!) if (components[edge.to] === -1) { components[edge.to] = component; queue.push(edge.to) }
    component++
  }
  for (const binding of bindings) if (binding) binding.component = components[binding.node]!
  const timesFrom = (town: number) => {
    const times = new Float64Array(edges.length).fill(Infinity), queue = new MinHeap<number>(), start = bindings[town]!
    times[start.node] = start.walk; queue.push(start.node, start.walk)
    while (queue.size) {
      const item = queue.pop()!
      if (item.priority !== times[item.value]) continue
      for (const edge of edges[item.value]!) {
        const cost = item.priority + edge.cost
        if (cost < times[edge.to]!) { times[edge.to] = cost; queue.push(edge.to, cost) }
      }
    }
    return towns.map((_, i) => bindings[i] ? times[bindings[i]!.node]! + bindings[i]!.walk : Infinity)
  }
  return { bindings, timesFrom }
}
function mergedRegions(regions: PolygonRegion[]): PolygonRegion[] {
  if (regions.length < 2) return regions
  const polygons = regions.map(region => [region.polygon, ...(region.holes ?? [])].map(ring => ring.map(p => [p.x, p.y] as [number, number])))
  try {
    return union(polygons[0]!, ...polygons.slice(1)).map(rings => ({ polygon: rings[0]!.slice(0, -1).map(([x, y]) => ({ x, y })), ...(rings.length > 1 ? { holes: rings.slice(1).map(ring => ring.slice(0, -1).map(([x, y]) => ({ x, y }))) } : {}) }))
  } catch {
    // Town territories already have disjoint interiors. Keeping their exact
    // components represents the same union without inventing a countryside hull.
    return regions
  }
}
function groupId(ids: string[]) {
  let value = 2166136261
  for (const character of ids.slice().sort().join('|')) value = Math.imul(value ^ character.charCodeAt(0), 16777619)
  return `layout-ward-${(value >>> 0).toString(36)}`
}

/** Retain real occupied town regions. Upper wards require an actual broad urban
 * catchment, not one label for every disconnected face of a small map crop. */
export function buildLayoutFirstDistricts(input: DistrictInput): District[] {
  const townInput = input.config.settlement === 'metropolis' ? { ...input, config: { ...input.config, settlement: 'regional-city' as const } } : input
  const towns = buildDistricts(townInput)
  if (input.config.settlement !== 'metropolis' || input.width * input.height < 30_000_000 || towns.length < 8) return towns
  const areas = towns.map(town => (town.regions ?? []).reduce((sum, region) => sum + regionArea(region), 0))
  if (areas.reduce((sum, area) => sum + area, 0) < 18_000_000) return towns
  const network = roadNetwork(input, towns), components = new Map<number, number[]>()
  for (const [i, binding] of network.bindings.entries()) if (binding) { const list = components.get(binding.component) ?? []; list.push(i); components.set(binding.component, list) }
  const wards: District[] = [], parents = new Map<number, string>(), used = new Set([input.config.name, ...towns.map(town => town.name)])
  for (const members of [...components.values()].sort((a, b) => b.reduce((n, i) => n + areas[i]!, 0) - a.reduce((n, i) => n + areas[i]!, 0))) {
    const total = members.reduce((sum, i) => sum + areas[i]!, 0), remaining = 6 - wards.length
    if (remaining < 2 || total < 18_000_000 || members.length < 8) continue
    const count = Math.max(2, Math.min(remaining, Math.floor(total / 10_000_000), Math.ceil(total / 22_000_000)))
    const first = members.slice().sort((a, b) => (towns[a]!.foundedYear ?? 2025) - (towns[b]!.foundedYear ?? 2025) || towns[a]!.id.localeCompare(towns[b]!.id))[0]!
    const seeds = [first], distances = [network.timesFrom(first)]
    while (seeds.length < count) {
      const next = members.filter(i => !seeds.includes(i)).sort((a, b) => Math.min(...distances.map(times => times[b]!)) - Math.min(...distances.map(times => times[a]!)) || towns[a]!.id.localeCompare(towns[b]!.id))[0]
      if (next === undefined) break
      seeds.push(next); distances.push(network.timesFrom(next))
    }
    const groups = seeds.map(seed => [seed]), groupArea = seeds.map(seed => areas[seed]!), target = total / seeds.length
    const certainty = (i: number) => { const ordered = distances.map(times => times[i]!).sort((a, b) => a - b); return (ordered[1] ?? ordered[0]!) - ordered[0]! }
    const pending = members.filter(i => !seeds.includes(i)).sort((a, b) => certainty(b) - certainty(a) || towns[a]!.id.localeCompare(towns[b]!.id))
    for (const town of pending) {
      const available = groups.map((_, i) => i).filter(i => groupArea[i]! + areas[town]! <= 30_000_000)
      const selected = (available.length ? available : groups.map((_, i) => i)).sort((a, b) => distances[a]![town]! + (groupArea[a]! / target) ** 3 * 4 - distances[b]![town]! - (groupArea[b]! / target) ** 3 * 4 || a - b)[0]!
      groups[selected]!.push(town); groupArea[selected]! += areas[town]!
    }
    // Move the least costly boundary holdings until no tiny administrative
    // catchment remains. The donor keeps at least8km² of actual town territory.
    for (let pass = 0; pass < members.length; pass++) {
      const small = groupArea.findIndex(area => area < 8_000_000)
      if (small < 0) break
      let best: { from: number; town: number; penalty: number } | undefined
      for (let from = 0; from < groups.length; from++) if (from !== small) for (const town of groups[from]!) {
        if (seeds.includes(town) || groupArea[from]! - areas[town]! < 8_000_000) continue
        const penalty = distances[small]![town]! - distances[from]![town]!
        if (!best || penalty < best.penalty) best = { from, town, penalty }
      }
      if (!best) break
      groups[best.from] = groups[best.from]!.filter(i => i !== best.town); groupArea[best.from]! -= areas[best.town]!
      groups[small]!.push(best.town); groupArea[small]! += areas[best.town]!
    }
    if (groupArea.some(area => area < 8_000_000 || area > 30_000_000)) continue
    for (const [i, group] of groups.entries()) {
      const children = group.map(index => towns[index]!), regions = mergedRegions(children.flatMap(town => town.regions ?? [])), id = groupId(children.map(town => town.id))
      const seed = towns[seeds[i]!]!, anchor = regions.some(region => pointInRegion(seed.point, region)) ? seed.point : children[0]!.point
      const direction = anchor.x < input.width * .35 ? '西' : anchor.x > input.width * .65 ? '東' : anchor.y < input.height * .35 ? '北' : '南'
      const name = provisionalPlaceName({ seed: input.config.seed, id, kind: 'ward', direction }, used)
      used.add(name); wards.push({ id, kind: 'ward', name, point: anchor, regions, foundedYear: Math.min(...children.map(town => town.foundedYear ?? 2025)), namingSource: 'provisional' })
      for (const town of group) parents.set(town, id)
    }
  }
  return [...wards, ...towns.map((town, i) => parents.has(i) ? { ...town, parentId: parents.get(i)! } : town)]
}
