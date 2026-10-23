import type { Area, Point, Road } from './types'
import { MinHeap } from './road-graph.ts'
import { railwayRoadCost } from './railway-road-cost.ts'

export interface RailwaySettlement { point: Point; demand: number }
export interface RailwayCorridorInput {
  width: number; height: number; core?: Point[] | null; origin: Point
  terrain: { areas: Area[]; elevation(p: Point): number; waterAt(p: Point): boolean; slope?(p: Point): number; channelAt?(p: Point): { bankDistance: number; width: number } | null }
  settlements: RailwaySettlement[]
  allowTerminus?: boolean
  inheritedRoads?: Road[]
}
export interface RailwayCorridor { points: Point[]; from: Point; to: Point; station: Point; score: number; terminus?: boolean }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
function inside(p: Point, polygon: Point[]) { let hit = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i]!, b = polygon[j]!; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit } return hit }
function segmentDistance(p: Point, a: Point, b: Point) { const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))); return distance(p, { x: a.x + dx * t, y: a.y + dy * t }) }

/** Geographic corridor precedes the rail alignment. Endpoints are dry lowland
 * exits of the surveyed window, ranked by actual valley drainage and terrain,
 * not remote fictional cities fabricated just to justify a curve. A station
 * serves an inherited settlement; its land acquisition/access tradeoff chooses
 * among real dry sites. This coarse A* does not itself approve rail engineering. */
export function railwayCorridors(input: RailwayCorridorInput): RailwayCorridor[] {
  const streetCost = railwayRoadCost(input.inheritedRoads ?? [])
  const columns = Math.ceil(input.width / 75) + 1, rows = Math.ceil(input.height / 75) + 1, dx = input.width / (columns - 1), dy = input.height / (rows - 1)
  const occupied = (p: Point, a: Area) => inside(p, a.polygon) && !a.holes?.some(h => inside(p, h))
  const seas = input.terrain.areas.filter(a => a.kind === 'water' && a.id.startsWith('sea')), forests = input.terrain.areas.filter(a => a.kind === 'forest')
  const reserved = input.terrain.areas.filter(a => a.id === 'historic-core' || a.id.startsWith('moat-'))
  const field = (p: Point) => {
    const core = input.core, grade = input.terrain.slope?.(p) ?? 0, z = input.terrain.elevation(p), water = input.terrain.waterAt(p)
    const blocked = seas.some(a => occupied(p, a)) || reserved.some(a => occupied(p, a) || a.polygon.some((b, i) => segmentDistance(p, b, a.polygon[(i + 1) % a.polygon.length]!) < 30)) || !!core && (inside(p, core) || core.some((a, i) => segmentDistance(p, a, core[(i + 1) % core.length]!) < 45))
    const channel = input.terrain.channelAt?.(p)
    return { blocked, grade, water, channel, cost: 1 + Math.max(0, z) * .0015 + grade * grade * 240 + streetCost.pointCost(p) + (forests.some(a => occupied(p, a)) ? 1.1 : 0) + (water ? 13 : channel && channel.bankDistance < 65 ? (65 - Math.max(0, channel.bankDistance)) / 65 * 1.7 : 0) }
  }
  const points = Array.from({ length: rows * columns }, (_, i) => ({ x: i % columns * dx, y: Math.floor(i / columns) * dy })), fields = points.map(field)
  const index = (p: Point) => Math.max(0, Math.min(rows - 1, Math.round(p.y / dy))) * columns + Math.max(0, Math.min(columns - 1, Math.round(p.x / dx)))
  const paths = new Map<string, { points: Point[]; cost: number } | null>()
  const edges = new Map<string, ReturnType<typeof field>>()
  const crossingCosts = new Map<string, number>()
  const route = (from: number, to: number) => {
    const key = `${from}:${to}`
    if (paths.has(key)) return paths.get(key)!
    const costs = new Float64Array(points.length).fill(Infinity), parents = new Int32Array(points.length).fill(-1), queue = new MinHeap<number>()
    costs[from] = 0; queue.push(from, distance(points[from]!, points[to]!))
    let result: { points: Point[]; cost: number } | null = null
    while (queue.size) {
      const next = queue.pop()!, current = next.value
      if (next.priority > costs[current]! + distance(points[current]!, points[to]!) + 1e-6) continue
      if (current === to) { const line: Point[] = []; for (let i = current; i >= 0; i = parents[i]!) line.push(points[i]!); result = { points: line.reverse(), cost: costs[current]! }; break }
      const x = current % columns, y = Math.floor(current / columns)
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const nx = x + ox, ny = y + oy
        if ((!ox && !oy) || nx < 0 || nx >= columns || ny < 0 || ny >= rows) continue
        const n = ny * columns + nx
        if (fields[n]!.blocked) continue
        const a = points[current]!, b = points[n]!, edgeKey = `${Math.min(current, n)}:${Math.max(current, n)}`
        let mid = edges.get(edgeKey)
        if (!mid) { mid = field({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); edges.set(edgeKey, mid) }
        if (mid.blocked) continue
        const length = distance(a, b), groundGrade = Math.abs(input.terrain.elevation(b) - input.terrain.elevation(a)) / length
        // Prefer a contour-following approach before the engineering DP. A
        // locally flat high terrace is not a cheap exit if reaching it requires
        // a sustained 8% climb. The later profile still enforces the hard 3.5%.
        const gradeCost = Math.max(0, groundGrade - .025) ** 2 * 8000
        const acquisitionKey = `${current}:${n}`
        let acquisition = crossingCosts.get(acquisitionKey)
        if (acquisition === undefined) { acquisition = streetCost.edgeCost(a, b); crossingCosts.set(acquisitionKey, acquisition) }
        const value = costs[current]! + length * ((fields[n]!.cost + fields[current]!.cost + mid.cost * 2) / 4 + gradeCost) + acquisition
        if (value >= costs[n]!) continue
        costs[n] = value; parents[n] = current; queue.push(n, value + distance(b, points[to]!))
      }
    }
    paths.set(key, result); return result
  }
  const exits: { index: number; side: number; importance: number; score: number }[] = []
  for (let side = 0; side < 4; side++) {
    const candidates: typeof exits = []
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!, f = fields[i]!
      const onSide = side === 0 ? p.y === 0 : side === 1 ? p.x === input.width : side === 2 ? p.y === input.height : p.x === 0
      if (!onSide || f.blocked || f.water || f.grade > .12) continue
      const importance = f.channel ? Math.min(2, f.channel.width / 18) * Math.max(0, 1 - Math.abs(f.channel.bankDistance - 180) / 500) : 0
      candidates.push({ index: i, side, importance, score: f.cost - importance * .8 + distance(p, input.origin) * .00015 })
    }
    candidates.sort((a, b) => a.score - b.score)
    for (const candidate of candidates) if (exits.filter(e => e.side === side).every(e => distance(points[e.index]!, points[candidate.index]!) > 400)) { exits.push(candidate); if (exits.filter(e => e.side === side).length >= 2) break }
  }
  const settlements = input.settlements.filter(s => s.demand > 0).sort((a, b) => b.demand - a.demand), hub = settlements[0]?.point ?? input.origin
  const stationCandidates = [{ point: hub, access: 0 }, ...[150, 300, 450, 650, 850].flatMap(radius => Array.from({ length: 12 }, (_, i) => ({ point: { x: hub.x + Math.cos(i * Math.PI / 6) * radius, y: hub.y + Math.sin(i * Math.PI / 6) * radius }, access: radius })))].filter(({ point: p }) => p.x > 100 && p.y > 100 && p.x < input.width - 100 && p.y < input.height - 100)
    .map(candidate => ({ ...candidate, cell: index(candidate.point), f: field(candidate.point) }))
    .filter(c => !c.f.blocked && !c.f.water && c.f.grade < .09 && !forests.some(a => occupied(c.point, a)))
    .sort((a, b) => a.access * .6 + a.f.grade * 2500 + a.f.cost * 100 - b.access * .6 - b.f.grade * 2500 - b.f.cost * 100)
    .filter((candidate, i, all) => all.findIndex(c => c.cell === candidate.cell) === i).slice(0, 9)
  const plans: RailwayCorridor[] = []
  for (const station of stationCandidates) for (const a of exits) {
    const first = route(a.index, station.cell)
    if (!first) continue
    if (input.allowTerminus && first.cost > 1500 && distance(points[a.index]!, points[station.cell]!) > 1400) plans.push({ points: first.points, from: points[a.index]!, to: points[station.cell]!, station: points[station.cell]!, terminus: true, score: first.cost / distance(points[a.index]!, points[station.cell]!) + station.access * .001 - a.importance * .12 + .15 })
    for (const b of exits) {
      if (a.side >= b.side || (b.side - a.side !== 2) || distance(points[a.index]!, points[b.index]!) < Math.min(input.width, input.height) * .8) continue
      const second = route(station.cell, b.index)
      if (!second) continue
      const span = distance(points[a.index]!, points[b.index]!)
      plans.push({ points: first.points.concat(second.points.slice(1)), from: points[a.index]!, to: points[b.index]!, station: points[station.cell]!, score: (first.cost + second.cost) / span + station.access * .001 - (a.importance + b.importance) * .12 })
    }
  }
  plans.sort((a, b) => a.score - b.score)
  const selected: RailwayCorridor[] = []
  for (const plan of plans) if (selected.filter(previous => distance(previous.station, plan.station) < 100).length < 2 && selected.every(previous => distance(previous.from, plan.from) + distance(previous.to, plan.to) + distance(previous.station, plan.station) > 150)) { selected.push(plan); if (selected.length >= 12) break }
  if (input.allowTerminus) for (const plan of plans.filter(p => p.terminus).slice(0, 3)) if (!selected.includes(plan)) selected.push(plan)
  return selected
}
