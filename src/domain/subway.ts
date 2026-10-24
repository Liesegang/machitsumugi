import type { Building, CityConfig, Point, Railway, Road, Station, TimelineVersion } from './types'
import { distance, distanceToSegment, projectPoint, segmentsCross } from './geometry'
import { MinHeap } from './road-graph'

interface SubwayInput {
  config: CityConfig; throughYear: number; roads: TimelineVersion<Road>[]; buildings: TimelineVersion<Building>[]; stations: Station[]
  terrain: { elevation(p: Point): number; waterAt(p: Point): boolean; slope(p: Point): number }
}
type Node = { point: Point; links: { to: number; length: number; cost: number }[]; entrance: boolean }
type Candidate = { node: number; demand: number; interchange?: Station }
const active = <T>(v: TimelineVersion<T>, year: number) => v.from <= year && (v.to === undefined || year < v.to)

/** A bounded late-century investment in an already built city. This survey never
 * adds a ground corridor or runs the urban/terrain simulation again. */
export function planSubway(input: SubwayInput): { railway: Railway; stations: Station[] } | null {
  if (!input.config.subway || input.config.settlement !== 'metropolis' || input.throughYear < 1965) return null
  for (const year of [1965, 1980, 1995, 2010]) {
    if (year > input.throughYear) break
    const stock = input.buildings.filter(v => active(v, year) && v.value.kind !== 'industrial').map(v => v.value)
    if (stock.length < 240) continue
    const plan = survey(input, year, stock)
    if (plan) return plan
  }
  return null
}

function survey(input: SubwayInput, year: number, stock: Building[]) {
  const nodes: Node[] = [], nodeIds = new Map<string, number>()
  const node = (p: Point, entrance: boolean) => {
    const key = `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`
    const existing = nodeIds.get(key)
    if (existing !== undefined) { nodes[existing]!.entrance ||= entrance; return existing }
    const id = nodes.length; nodes.push({ point: p, links: [], entrance }); nodeIds.set(key, id); return id
  }
  for (const { value: road } of input.roads.filter(v => active(v, year))) {
    if (road.controlledAccess || road.role === 'expressway' || road.role === 'ramp' || road.role === 'farm' || (road.level ?? 0) < 0) continue
    const ids: number[] = []
    // Sample long roads too: an entrance need not coincide with a graph junction.
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!, count = Math.max(1, Math.ceil(distance(a, b) / 150))
      if (i === 1) ids.push(node(a, !road.bridge))
      for (let j = 1; j <= count; j++) ids.push(node({ x: a.x + (b.x - a.x) * j / count, y: a.y + (b.y - a.y) * j / count }, !road.bridge))
    }
    if (nodes.length > 16000) return null
    for (let i = 1; i < ids.length; i++) {
      const a = ids[i - 1]!, b = ids[i]!, length = distance(nodes[a]!.point, nodes[b]!.point)
      if (length < .1) continue
      // Existing wide roads provide the least disruptive tunnel survey corridor.
      const cost = length * (road.width >= 8 ? 1 : 1.2)
      nodes[a]!.links.push({ to: b, length, cost }); nodes[b]!.links.push({ to: a, length, cost })
    }
  }
  if (!nodes.length) return null
  const stockBuckets = new Map<string, Point[]>()
  for (const building of stock) {
    const p = building.polygon.reduce((sum, q) => ({ x: sum.x + q.x / building.polygon.length, y: sum.y + q.y / building.polygon.length }), { x: 0, y: 0 })
    const key = `${Math.floor(p.x / 400)},${Math.floor(p.y / 400)}`, bucket = stockBuckets.get(key) ?? []
    bucket.push(p); stockBuckets.set(key, bucket)
  }
  const demandAt = (p: Point) => {
    let count = 0
    for (let y = Math.floor((p.y - 500) / 400); y <= Math.floor((p.y + 500) / 400); y++) for (let x = Math.floor((p.x - 500) / 400); x <= Math.floor((p.x + 500) / 400); x++) for (const q of stockBuckets.get(`${x},${y}`) ?? []) if (distance(p, q) <= 500) count++
    return count
  }
  const candidates: Candidate[] = []
  for (const [i, n] of nodes.entries()) {
    if (!n.entrance || input.terrain.waterAt(n.point) || input.terrain.slope(n.point) > .12) continue
    const demand = demandAt(n.point)
    if (demand < 18) continue
    const interchange = input.stations.filter(s => s.mode !== 'subway' && (s.builtYear ?? 1900) <= year && distance(s.point, n.point) <= 240).sort((a, b) => distance(a.point, n.point) - distance(b.point, n.point))[0]
    candidates.push({ node: i, demand, interchange })
  }
  // Keep spatially separated endpoints, but retain the finer candidates for stops.
  const endpoints: Candidate[] = []
  for (const candidate of [...candidates].sort((a, b) => Number(!!b.interchange) - Number(!!a.interchange) || b.demand - a.demand || a.node - b.node)) {
    if (endpoints.every(other => distance(nodes[other.node]!.point, nodes[candidate.node]!.point) >= 650)) endpoints.push(candidate)
    if (endpoints.length === 16) break
  }
  if (endpoints.length < 3) return null
  const pairs = endpoints.flatMap((a, i) => endpoints.slice(i + 1).map(b => ({ a, b, score: distance(nodes[a.node]!.point, nodes[b.node]!.point) }))).filter(pair => pair.score >= 2000).sort((a, b) => Number(!!(b.a.interchange || b.b.interchange)) - Number(!!(a.a.interchange || a.b.interchange)) || b.score - a.score).slice(0, 16)
  const trees = new Map<number, { costs: Float64Array; parents: Int32Array }>()
  for (const { a, b } of pairs) {
    let tree = trees.get(a.node)
    if (!tree) { tree = shortestPaths(nodes, a.node); trees.set(a.node, tree) }
    if (!Number.isFinite(tree.costs[b.node]!)) continue
    const raw: Point[] = []
    for (let at = b.node; at >= 0; at = tree.parents[at]!) { raw.push(nodes[at]!.point); if (at === a.node) break }
    raw.reverse()
    const rawLength = pathLength(raw), direct = distance(raw[0]!, raw.at(-1)!)
    if (rawLength < 2000 || rawLength > direct * 1.65 || rawLength > 15000) continue
    const points = roundedAlignment(simplify(raw, 75), 110)
    if (!points || hasSelfCrossing(points)) continue
    const length = pathLength(points), positions = chainages(points)
    const options = candidates.map(c => {
      const projection = nearestPosition(nodes[c.node]!.point, points, positions)
      return { ...c, ...projection, entrance: nodes[c.node]!.point }
    }).filter(c => c.distance <= 180).sort((a, b) => a.along - b.along)
    const selected: typeof options = []
    const first = options.find(c => c.node === a.node), last = options.find(c => c.node === b.node)
    if (!first || !last) continue
    selected.push(first)
    while (length - selected.at(-1)!.along >= 1300 && selected.length < 11) {
      const previous = selected.at(-1)!, available = options.filter(c => c.along - previous.along >= 650 && c.along - previous.along <= 1300 && last.along - c.along >= 650)
      available.sort((a, b) => (b.demand + (b.interchange ? 60 : 0) - Math.abs(b.along - previous.along - 950) / 15) - (a.demand + (a.interchange ? 60 : 0) - Math.abs(a.along - previous.along - 950) / 15))
      if (!available.length) break
      selected.push(available[0]!)
    }
    if (last.along - selected.at(-1)!.along < 650) continue
    selected.push(last)
    if (selected.length < 3 || selected.some((s, i) => i && s.along - selected[i - 1]!.along > 1500)) continue
    const elevations = points.map(p => input.terrain.elevation(p) - 18)
    for (let i = 1; i < points.length; i++) elevations[i] = Math.min(elevations[i]!, elevations[i - 1]! + .035 * distance(points[i - 1]!, points[i]!))
    for (let i = points.length - 2; i >= 0; i--) elevations[i] = Math.min(elevations[i]!, elevations[i + 1]! + .035 * distance(points[i]!, points[i + 1]!))
    if (elevations.some((z, i) => !Number.isFinite(z) || input.terrain.elevation(points[i]!) - z > 80)) continue
    const base = input.config.name.replace(/[市町村]$/, ''), id = 'subway-main'
    const usedNames = new Set<string>()
    const stations: Station[] = selected.map((s, i) => {
      const dx = s.point.x - selected[Math.floor(selected.length / 2)]!.point.x, dy = s.point.y - selected[Math.floor(selected.length / 2)]!.point.y
      const direction = Math.abs(dx) > Math.abs(dy) ? dx < 0 ? '西' : '東' : dy < 0 ? '北' : '南'
      let name = s.interchange?.name ?? `${base}${i === Math.floor(selected.length / 2) ? '中央' : `${direction}${i > 0 && i < selected.length - 1 ? '本町' : '町'}`}駅`
      if (usedNames.has(name)) name = `${base}${['若葉', '栄', '本通', '新町', 'けやき', '旭', '緑町', '千代田', '常盤', '桜町', '大手', '末広'][i]}駅`
      usedNames.add(name)
      return { id: `subway-station-${i}`, name, point: s.point, entrance: s.entrance, mode: 'subway', railwayId: id, builtYear: year }
    })
    return { railway: { id, name: `${base}地下鉄本線`, mode: 'subway' as const, points, elevations, builtYear: year }, stations }
  }
  return null
}

function shortestPaths(nodes: Node[], start: number) {
  const costs = new Float64Array(nodes.length).fill(Infinity), parents = new Int32Array(nodes.length).fill(-1)
  const heap = new MinHeap<{ id: number; cost: number }>()
  costs[start] = 0; heap.push({ id: start, cost: 0 }, 0)
  while (heap.size) {
    const current = heap.pop()!.value
    if (current.cost !== costs[current.id]) continue
    for (const edge of nodes[current.id]!.links) if (current.cost + edge.cost < costs[edge.to]!) {
      costs[edge.to] = current.cost + edge.cost; parents[edge.to] = current.id; heap.push({ id: edge.to, cost: costs[edge.to]! }, costs[edge.to]!)
    }
  }
  return { costs, parents }
}

const pathLength = (points: Point[]) => points.slice(1).reduce((sum, p, i) => sum + distance(points[i]!, p), 0)
function chainages(points: Point[]) { const result = [0]; for (let i = 1; i < points.length; i++) result.push(result[i - 1]! + distance(points[i - 1]!, points[i]!)); return result }
function nearestPosition(p: Point, points: Point[], along: number[]) {
  let result = { point: points[0]!, distance: Infinity, along: 0 }
  for (let i = 1; i < points.length; i++) { const q = projectPoint(p, points[i - 1]!, points[i]!), d = distance(p, q); if (d < result.distance) result = { point: q, distance: d, along: along[i - 1]! + distance(points[i - 1]!, q) } }
  return result
}
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points
  let farthest = tolerance, index = -1
  for (let i = 1; i < points.length - 1; i++) { const d = distanceToSegment(points[i]!, points[0]!, points.at(-1)!); if (d > farthest) { farthest = d; index = i } }
  return index < 0 ? [points[0]!, points.at(-1)!] : [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)]
}
/** Circular 110m-radius curves, sampled at <=15m. Short corners are rejected,
 * rather than hiding tram-like right angles in a smooth renderer. */
function roundedAlignment(points: Point[], radius: number): Point[] | null {
  const corners: { start: Point; end: Point; center: Point; angle: number; turn: number }[] = []
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!, before = distance(a, b), after = distance(b, c)
    const u = { x: (b.x - a.x) / before, y: (b.y - a.y) / before }, v = { x: (c.x - b.x) / after, y: (c.y - b.y) / after }
    const turn = Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y), setback = radius * Math.tan(Math.abs(turn) / 2)
    if (setback > before * .45 || setback > after * .45) return null
    const start = { x: b.x - u.x * setback, y: b.y - u.y * setback }, end = { x: b.x + v.x * setback, y: b.y + v.y * setback }
    const sign = Math.sign(turn), center = { x: start.x - u.y * radius * sign, y: start.y + u.x * radius * sign }
    corners.push({ start, end, center, angle: Math.atan2(start.y - center.y, start.x - center.x), turn })
  }
  const result = [points[0]!]
  const line = (end: Point) => { const start = result.at(-1)!, steps = Math.max(1, Math.ceil(distance(start, end) / 15)); for (let i = 1; i <= steps; i++) result.push({ x: start.x + (end.x - start.x) * i / steps, y: start.y + (end.y - start.y) * i / steps }) }
  for (const corner of corners) {
    line(corner.start)
    if (Math.abs(corner.turn) < 1e-6) continue
    const steps = Math.max(2, Math.ceil(Math.abs(corner.turn) * radius / 15))
    for (let i = 1; i <= steps; i++) { const angle = corner.angle + corner.turn * i / steps; result.push({ x: corner.center.x + Math.cos(angle) * radius, y: corner.center.y + Math.sin(angle) * radius }) }
  }
  line(points.at(-1)!)
  return result
}
function hasSelfCrossing(points: Point[]) {
  for (let i = 1; i < points.length; i++) for (let j = i + 2; j < points.length; j++) if (segmentsCross(points[i - 1]!, points[i]!, points[j - 1]!, points[j]!)) return true
  return false
}
