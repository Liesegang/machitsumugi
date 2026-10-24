import { union } from 'polygon-clipping'
import { provisionalPlaceName } from './place-names'
import type { Area, CityConfig, District, Facility, Parcel, Point, Road, Station } from './types'
import type { Bounds, PolygonRegion } from './geometry'
import { boundsOf, distance, intersectRegions, overlaps, pointInPolygon, pointInRegion, polygonArea, projectPoint, rectangle, regionArea, subtractRegions } from './geometry'

export interface DistrictInput {
  width: number; height: number; config: CityConfig; roads: Road[]
  blocks: { id: string; polygon: Point[] }[]; parcels: Parcel[]; areas: Area[]
  stations?: Station[]; facilities?: Facility[]
}
type Node = { id: string; regions: PolygonRegion[]; parcels: Parcel[]; point: Point; area: number; year: number; block?: string }
const vertexKey = (p: Point) => `${Math.round(p.x * 20)}:${Math.round(p.y * 20)}`
const edgeKey = (a: Point, b: Point) => { const x = vertexKey(a), y = vertexKey(b); return x < y ? `${x}|${y}` : `${y}|${x}` }
const center = (polygon: Point[]) => {
  const point = { x: polygon.reduce((n, p) => n + p.x, 0) / polygon.length, y: polygon.reduce((n, p) => n + p.y, 0) / polygon.length }
  if (pointInPolygon(point, polygon)) return point
  // A concave title's vertex mean need not be inside. Search inward from its
  // real edges; this is an anchor only and never manufactures a territory.
  const b = boundsOf(polygon)
  for (let y = b.minY + (b.maxY - b.minY) / 20; y < b.maxY; y += (b.maxY - b.minY) / 10 || 1) for (let x = b.minX + (b.maxX - b.minX) / 20; x < b.maxX; x += (b.maxX - b.minX) / 10 || 1) if (pointInPolygon({ x, y }, polygon)) return { x, y }
  return polygon[0]!
}
function spatial<T extends { bounds: Bounds }>(items: T[], step = 300) {
  const bins = new Map<string, T[]>(), large: T[] = []
  for (const item of items) {
    const b = item.bounds, x0 = Math.floor(b.minX / step), x1 = Math.floor(b.maxX / step), y0 = Math.floor(b.minY / step), y1 = Math.floor(b.maxY / step)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 300) { large.push(item); continue }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const key = `${x}:${y}`, group = bins.get(key) ?? []; group.push(item); bins.set(key, group) }
  }
  return (bounds: Bounds) => {
    const result = new Set(large.filter(item => overlaps(bounds, item.bounds)))
    for (let y = Math.floor(bounds.minY / step); y <= Math.floor(bounds.maxY / step); y++) for (let x = Math.floor(bounds.minX / step); x <= Math.floor(bounds.maxX / step); x++) for (const item of bins.get(`${x}:${y}`) ?? []) if (overlaps(bounds, item.bounds)) result.add(item)
    return [...result]
  }
}
function merge(regions: PolygonRegion[]): PolygonRegion[] {
  if (regions.length < 2) return regions
  const input = regions.map(region => [region.polygon, ...region.holes ?? []].map(ring => ring.map(p => [p.x, p.y] as [number, number])))
  return union(input[0]!, ...input.slice(1)).map(rings => ({ polygon: rings[0]!.slice(0, -1).map(([x, y]) => ({ x, y })), ...(rings.length > 1 ? { holes: rings.slice(1).map(ring => ring.slice(0, -1).map(([x, y]) => ({ x, y }))) } : {}) }))
}
function hash(text: string) { let value = 2166136261; for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619); return (value >>> 0).toString(36) }

/** Town territories are unions of occupied street faces and acquired frontage
 * parcels. A dual graph walks actual shared streets, with major-road impedance;
 * open countryside has no invented Voronoi/grid boundary. Recorded parcel years
 * describe local settlement history, not a claim of legal municipal founding.
 */
export function buildDistricts(input: DistrictInput): District[] {
  const active = input.parcels.filter(p => p.developedYear && !p.retiredYear).sort((a, b) => a.id.localeCompare(b.id))
  if (!active.length) return []
  const parcelPoints = new Map(active.map(p => [p.id, center(p.polygon)]))
  const candidates = spatial(active.map(parcel => ({ parcel, bounds: boundsOf(parcel.polygon) })))
  const natural = spatial(input.areas.filter(a => a.kind === 'water' || a.kind === 'forest').map(area => ({ ...area, bounds: boundsOf(area.polygon) })))
  const boundary = { polygon: rectangle(0, 0, input.width, input.height) }, nodes: Node[] = [], assigned = new Set<string>(), blockNodes = new Map<string, number[]>()
  for (const block of [...input.blocks].sort((a, b) => a.id.localeCompare(b.id))) {
    const b = boundsOf(block.polygon), nearby = candidates(b).map(p => p.parcel).filter(p => !assigned.has(p.id) && pointInPolygon(parcelPoints.get(p.id)!, block.polygon))
    if (!nearby.length) continue
    const pieces = intersectRegions(block, boundary).flatMap(region => subtractRegions(region, natural(boundsOf(region.polygon))))
    for (const region of pieces) {
      const parcels = nearby.filter(p => pointInRegion(parcelPoints.get(p.id)!, region)), area = regionArea(region)
      // A kilometre-wide road loop enclosing mostly countryside is not a town
      // block. Its inhabited frontage is handled from the acquired titles below.
      if (!parcels.length || area > 60_000 && parcels.reduce((n, p) => n + polygonArea(p.polygon), 0) / area < .08) continue
      const point = parcels.map(p => parcelPoints.get(p.id)!).reduce((s, p) => ({ x: s.x + p.x / parcels.length, y: s.y + p.y / parcels.length }), { x: 0, y: 0 })
      const ids = blockNodes.get(block.id) ?? []; ids.push(nodes.length); blockNodes.set(block.id, ids)
      nodes.push({ id: `${block.id}-${ids.length}`, regions: [region], parcels, point, area, year: Math.min(...parcels.map(p => p.createdYear)), block: block.id })
      for (const p of parcels) assigned.add(p.id)
    }
  }
  for (const parcel of active) if (!assigned.has(parcel.id)) {
    const regions = intersectRegions(parcel, boundary).flatMap(region => subtractRegions(region, natural(boundsOf(region.polygon))))
    if (!regions.length) continue
    nodes.push({ id: `frontage-${parcel.id}`, regions, parcels: [parcel], point: parcelPoints.get(parcel.id)!, area: regions.reduce((n, r) => n + regionArea(r), 0), year: parcel.createdYear })
  }
  if (!nodes.length) return []
  const adjacency = nodes.map(() => new Map<number, number>())
  const connect = (a: number, b: number, weight: number) => {
    if (a === b) return
    adjacency[a]!.set(b, Math.min(adjacency[a]!.get(b) ?? Infinity, weight))
    adjacency[b]!.set(a, Math.min(adjacency[b]!.get(a) ?? Infinity, weight))
  }
  const streetEdges = new Map<string, Road>()
  const surfaceRoads = input.roads.filter(r => !r.controlledAccess && r.role !== 'expressway' && r.role !== 'ramp').sort((a, b) => a.id.localeCompare(b.id))
  for (const road of surfaceRoads) for (let i = 1; i < road.points.length; i++) streetEdges.set(edgeKey(road.points[i - 1]!, road.points[i]!), road)
  const shared = new Map<string, { block: string; a: Point; b: Point }[]>()
  for (const block of input.blocks) if (blockNodes.has(block.id)) for (let i = 0; i < block.polygon.length; i++) {
    const a = block.polygon[i]!, b = block.polygon[(i + 1) % block.polygon.length]!, key = edgeKey(a, b), group = shared.get(key) ?? []
    group.push({ block: block.id, a, b }); shared.set(key, group)
  }
  for (const [key, faces] of shared) if (faces.length === 2) {
    const { a, b } = faces[0]!, midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, length = distance(a, b)
    if (!length) continue
    const onEdge = (index: number) => [-.5, .5].some(offset => pointInRegion({ x: midpoint.x - (b.y - a.y) / length * offset, y: midpoint.y + (b.x - a.x) / length * offset }, nodes[index]!.regions[0]!))
    const road = streetEdges.get(key), penalty = road?.kind === 'arterial' || (road?.width ?? 0) >= 9 ? 3 : 1
    for (const x of blockNodes.get(faces[0]!.block)!) if (onEdge(x)) for (const y of blockNodes.get(faces[1]!.block)!) if (onEdge(y)) connect(x, y, Math.max(30, distance(nodes[x]!.point, nodes[y]!.point)) * penalty)
  }
  // An unclosed village street has no planar face. Its real frontage chainage
  // connects titles along that road, and across actual normalized junctions.
  const roadById = new Map(surfaceRoads.map(r => [r.id, r]))
  const fronts = new Map<string, { node: number; chain: number }[]>()
  const chainAt = (road: Road, point: Point) => {
    let length = 0, chain = 0, best = Infinity
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!, foot = projectPoint(point, a, b), d = distance(point, foot)
      if (d < best) { best = d; chain = length + distance(a, foot) }
      length += distance(a, b)
    }
    return chain
  }
  for (const [index, node] of nodes.entries()) for (const parcel of node.parcels) {
    const road = roadById.get(parcel.roadId)
    if (!road) continue
    const group = fronts.get(road.id) ?? []; group.push({ node: index, chain: chainAt(road, parcel.entrance) }); fronts.set(road.id, group)
  }
  for (const entries of fronts.values()) {
    entries.sort((a, b) => a.chain - b.chain || a.node - b.node)
    for (let i = 1; i < entries.length; i++) {
      const a = entries[i - 1]!, b = entries[i]!
      // Closed faces already have the surveyed shared-edge connection. Do not
      // reconnect opposite river banks merely because one long road has a bridge.
      if (nodes[a.node]!.block && nodes[b.node]!.block) continue
      if (b.chain - a.chain <= 140) connect(a.node, b.node, Math.max(20, b.chain - a.chain))
    }
  }
  const junctions = new Map<string, { road: Road; chain: number }[]>()
  for (const road of surfaceRoads) {
    let chain = 0
    for (let i = 0; i < road.points.length; i++) {
      if (i) chain += distance(road.points[i - 1]!, road.points[i]!)
      const key = vertexKey(road.points[i]!), entries = junctions.get(key) ?? []; entries.push({ road, chain }); junctions.set(key, entries)
    }
  }
  for (const junction of junctions.values()) if (new Set(junction.map(j => j.road.id)).size > 1) {
    const near = junction.flatMap(j => {
      const entries = fronts.get(j.road.id) ?? [], closest = entries.reduce<{ node: number; d: number } | null>((best, entry) => !best || Math.abs(entry.chain - j.chain) < best.d ? { node: entry.node, d: Math.abs(entry.chain - j.chain) } : best, null)
      return closest && closest.d < 100 ? [closest] : []
    })
    for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) if (!nodes[near[i]!.node]!.block || !nodes[near[j]!.node]!.block) connect(near[i]!.node, near[j]!.node, Math.max(25, near[i]!.d + near[j]!.d))
  }
  const order = nodes.map((_, i) => i).sort((a, b) => nodes[a]!.year - nodes[b]!.year || nodes[a]!.id.localeCompare(nodes[b]!.id))
  const owner = new Int32Array(nodes.length).fill(-1), groups: number[][] = []
  const targetArea = input.config.settlement === 'village' ? 45_000 : input.config.settlement === 'rural-town' ? 80_000 : input.config.settlement === 'metropolis' ? 200_000 : 140_000
  for (const seed of order) if (owner[seed] === -1) {
    const group: number[] = [], pending = new Map([[seed, 0]]), cost = new Map<number, number>(), groupId = groups.length
    let area = 0
    while (pending.size) {
      let next = -1, best = Infinity
      for (const [index, distance] of pending) if (distance < best || distance === best && nodes[index]!.id < (nodes[next]?.id ?? '')) { next = index; best = distance }
      pending.delete(next)
      if (owner[next] !== -1 || cost.has(next)) continue
      cost.set(next, best)
      if (group.length && (area + nodes[next]!.area > targetArea * 1.25 || distance(nodes[next]!.point, nodes[seed]!.point) > 450)) continue
      owner[next] = groupId; group.push(next); area += nodes[next]!.area
      if (area >= targetArea) break
      for (const [neighbor, weight] of adjacency[next]!) if (owner[neighbor] === -1 && !cost.has(neighbor)) pending.set(neighbor, Math.min(pending.get(neighbor) ?? Infinity, best + weight))
    }
    groups.push(group)
  }
  // A small frontage remnant can be encountered after its neighbouring large
  // face filled a catchment. Attach it through the same street graph instead
  // of inventing a separately named town for each final house on that road.
  const groupArea = groups.map(group => group.reduce((sum, i) => sum + nodes[i]!.area, 0))
  for (const from of groups.map((_, i) => i).sort((a, b) => groupArea[a]! - groupArea[b]! || a - b)) {
    if (!groups[from]!.length || groupArea[from]! >= targetArea * .3) continue
    const neighbors = new Map<number, number>()
    for (const i of groups[from]!) for (const [j, cost] of adjacency[i]!) {
      const to = owner[j]!
      if (to !== from && groupArea[to]! + groupArea[from]! <= targetArea * 1.8 && distance(nodes[j]!.point, nodes[i]!.point) < 450) neighbors.set(to, Math.min(neighbors.get(to) ?? Infinity, cost))
    }
    const to = [...neighbors].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0]?.[0]
    if (to === undefined) continue
    for (const i of groups[from]!) { owner[i] = to; groups[to]!.push(i) }
    groupArea[to]! += groupArea[from]!; groupArea[from] = 0; groups[from] = []
  }
  const compactGroups = groups.filter(group => group.length)
  for (const [i, group] of compactGroups.entries()) for (const node of group) owner[node] = i
  const anchor = (members: number[], regions: PolygonRegion[]) => {
    const parcels = members.flatMap(i => nodes[i]!.parcels), total = parcels.length, mean = parcels.reduce((p, parcel) => ({ x: p.x + parcelPoints.get(parcel.id)!.x / total, y: p.y + parcelPoints.get(parcel.id)!.y / total }), { x: 0, y: 0 })
    const points = parcels.map(parcel => parcelPoints.get(parcel.id)!).sort((a, b) => distance(a, mean) - distance(b, mean))
    return points.find(point => regions.some(region => pointInRegion(point, region))) ?? center(regions[0]!.polygon)
  }
  const history = spatial(input.parcels.filter(p => p.developedYear).map(parcel => ({ parcel, point: center(parcel.polygon), bounds: boundsOf(parcel.polygon) })))
  const usedNames = new Set([input.config.name])
  const towns: District[] = compactGroups.map(members => {
    const regions = merge(members.flatMap(index => nodes[index]!.regions)), point = anchor(members, regions)
    let foundedYear = Math.min(...members.map(index => nodes[index]!.year))
    for (const region of regions) for (const record of history(boundsOf(region.polygon))) if (record.parcel.createdYear < foundedYear && pointInRegion(record.point, region)) foundedYear = record.parcel.createdYear
    const id = `town-${hash(members.map(index => nodes[index]!.id).sort().join('|'))}`
    const direction = point.y < input.height * .35 ? '北' : point.y > input.height * .65 ? '南' : point.x < input.width * .35 ? '西' : point.x > input.width * .65 ? '東' : '中'
    const name = provisionalPlaceName({ seed: input.config.seed, id, kind: 'town', direction }, usedNames)
    usedNames.add(name)
    return { id, name, kind: 'town', regions, point, foundedYear, namingSource: 'provisional' }
  })
  if (input.config.settlement !== 'metropolis' || towns.length < 8) return towns
  const townGraph = towns.map(() => new Set<number>())
  for (let i = 0; i < nodes.length; i++) for (const j of adjacency[i]!.keys()) if (owner[i] !== owner[j]) townGraph[owner[i]!]!.add(owner[j]!)
  const wardOwner = new Int32Array(towns.length).fill(-1), wards: District[] = []
  for (let seed = 0; seed < towns.length; seed++) if (wardOwner[seed] === -1) {
    const pending = [seed], members: number[] = [], id = `ward-${wards.length + 1}`
    while (pending.length && members.length < 8) {
      const next = pending.shift()!
      if (wardOwner[next] !== -1 || distance(towns[next]!.point, towns[seed]!.point) > 1800) continue
      wardOwner[next] = wards.length; members.push(next); towns[next]!.parentId = id
      pending.push(...[...townGraph[next]!].filter(index => wardOwner[index] === -1).sort((a, b) => distance(towns[a]!.point, towns[seed]!.point) - distance(towns[b]!.point, towns[seed]!.point)))
    }
    const regions = merge(members.flatMap(i => towns[i]!.regions!)), nodeMembers = members.flatMap(i => compactGroups[i]!)
    const name = provisionalPlaceName({ seed: input.config.seed, id, kind: 'ward' }, usedNames)
    usedNames.add(name)
    wards.push({ id, name, kind: 'ward', regions, point: anchor(nodeMembers, regions), foundedYear: Math.min(...members.map(i => towns[i]!.foundedYear!)), namingSource: 'provisional' })
  }
  return [...wards, ...towns]
}
