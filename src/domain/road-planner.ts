import type { Area, Point } from './types'
import { MinHeap, roadLength } from './road-graph'
import type { RoadRole } from './road-graph'

export interface PlanningTerrain {
  elevation(point: Point): number
  slope(point: Point): number
  waterAt(point: Point): boolean
  bridgeSites: Point[]
  bridgeCandidates?: { point: Point; bankA: Point; bankB: Point; width: number; cost: number }[]
  rivers?: { id: string; points: Point[] }[]
  wetness?: (point: Point) => number
  terrainCost?: (point: Point) => number
}
export interface PlanningEnvironment { width: number; height: number; areas: Area[]; core: Point[] | null; terrain?: PlanningTerrain; bridgeSites?: Point[]; landCost?: (point: Point) => number }
export interface PlannedRoute { points: Point[]; length: number; cost: number; bridgeLength: number; method: 'direct' | 'heading-search' | 'bridge-project' }
export interface PlanningOptions { role: RoadRole; width: number; allowBridge?: boolean; startHeading?: number; endHeading?: number; through?: Point; maxNodes?: number }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const turn = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
function inside(p: Point, polygon: Point[]) { let hit = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i]!, b = polygon[j]!; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit } return hit }
function pointSegmentDistance(p: Point, a: Point, b: Point) { const x = b.x - a.x, y = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * x + (p.y - a.y) * y) / (x * x + y * y || 1))); return distance(p, lerp(a, b, t)) }

/** Heading-aware continuous motion primitives. Curvature is chosen during planning, before parcels exist. */
export class RoadPlanner {
  readonly environment: PlanningEnvironment
  private cache = new Map<string, { water: boolean; sea: boolean; grade: number; cost: number; coreDistance: number }>()
  private earthCache = new Map<string, { grade: number; cost: number }>()
  private waterAreas: Area[]
  private seaAreas: Area[]
  private forests: Area[]
  private bridgeBankCache = new Map<Point, [Point, Point] | null>()
  constructor(environment: PlanningEnvironment) {
    this.environment = environment
    this.waterAreas = environment.areas.filter(a => a.kind === 'water')
    this.seaAreas = this.waterAreas.filter(a => a.id === 'sea')
    this.forests = environment.areas.filter(a => a.kind === 'forest')
  }
  private field(p: Point) {
    const k = `${Math.round(p.x / 6)},${Math.round(p.y / 6)}`
    let value = this.cache.get(k)
    if (value) return value
    const terrain = this.environment.terrain
    const water = terrain ? terrain.waterAt(p) : this.waterAreas.some(a => inside(p, a.polygon))
    const sea = water && this.seaAreas.some(a => inside(p, a.polygon))
    const earthKey = `${Math.round(p.x / 24)},${Math.round(p.y / 24)}`
    let earth = this.earthCache.get(earthKey)
    if (!earth) {
      const q = { x: Math.round(p.x / 24) * 24, y: Math.round(p.y / 24) * 24 }, grade = terrain?.slope(q) ?? 0
      const forest = this.forests.some(a => inside(q, a.polygon))
      earth = { grade, cost: 1 + grade * grade * 95 + Math.max(0, terrain?.elevation(q) ?? 0) / 500 + (forest ? 2.4 : 0) + (terrain?.wetness?.(q) ?? 0) * .55 + (this.environment.landCost?.(q) ?? 0) }
      this.earthCache.set(earthKey, earth)
    }
    const grade = earth.grade
    const core = this.environment.core
    const coreDistance = core ? inside(p, core) ? -1 : Math.min(...core.map((a, i) => pointSegmentDistance(p, a, core[(i + 1) % core.length]!))) : Infinity
    // Relative construction cost, not yen or a claim of engineering calibration.
    const cost = earth.cost
    value = { water, sea, grade, cost, coreDistance }; this.cache.set(k, value)
    return value
  }
  waterAt(p: Point) { return this.environment.terrain?.waterAt(p) ?? this.waterAreas.some(a => inside(p, a.polygon)) }
  suitable(p: Point, width = 6) {
    if (p.x < width || p.y < width || p.x > this.environment.width - width || p.y > this.environment.height - width) return false
    const f = this.field(p)
    return !f.water && f.grade < .20 && f.coreDistance > width / 2 + 4
  }
  private validSegment(a: Point, b: Point, width: number, bridge = false) {
    const n = Math.max(1, Math.ceil(distance(a, b) / 6)), angle = Math.atan2(b.y - a.y, b.x - a.x)
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
        if (this.seaAreas.some(region => inside(q, region.polygon))) return false
        if (this.environment.core && (inside(q, this.environment.core) || this.environment.core.some((p, k, polygon) => pointSegmentDistance(q, p, polygon[(k + 1) % polygon.length]!) < 2))) return false
      }
      if (!this.validSegment(a, b, width, allowBridge)) return false
    }
    return true
  }
  cost(path: Point[], role: RoadRole): PlannedRoute {
    const dense: Point[] = [path[0]!]
    for (let i = 1; i < path.length; i++) { const a = path[i - 1]!, b = path[i]!, n = Math.max(1, Math.ceil(distance(a, b) / 12)); for (let j = 1; j <= n; j++) dense.push(lerp(a, b, j / n)) }
    path = dense
    let length = 0, cost = 0, bridgeLength = 0
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, n = distance(a, b), middle = lerp(a, b, .5), f = this.field(middle)
      length += n
      if (f.water) { bridgeLength += n; cost += n * 13 }
      else cost += n * f.cost * (role === 'highway' ? 1.8 : role === 'collector' ? 1.35 : role === 'farm' ? .38 : role === 'access' ? .68 : 1)
    }
    if (bridgeLength) cost += 420
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
  /** Hierarchical alternative to the local heading search for long regional journeys.
   * A coarse least-cost corridor bounds the search, then validated tangent fillets
   * replace its corners. The corridor is geographic, never a drawn road grid. */
  private corridor(start: Point, goal: Point, options: PlanningOptions): PlannedRoute | null {
    const spacing = 55, width = Math.ceil(this.environment.width / spacing) + 1
    type Cell = { p: Point; index: number; cost: number; previous: Cell | null }
    const index = (p: Point) => Math.round(p.y / spacing) * width + Math.round(p.x / spacing)
    const queue = new MinHeap<Cell>(), values = new Map<number, number>()
    const initial: Cell = { p: start, index: index(start), cost: 0, previous: null }
    queue.push(initial, distance(start, goal)); values.set(initial.index, 0)
    let last: Cell | null = null
    for (let n = 0; queue.size && n < 7000; n++) {
      const current = queue.pop()!.value
      if (current.cost > (values.get(current.index) ?? Infinity)) continue
      if (distance(current.p, goal) < spacing * 1.6 && this.validSegment(current.p, goal, options.width)) { last = current; break }
      const gx = Math.round(current.p.x / spacing), gy = Math.round(current.p.y / spacing)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const p = { x: (gx + dx!) * spacing, y: (gy + dy!) * spacing }, k = index(p)
        if (!this.suitable(p, options.width) || !this.validSegment(current.p, p, options.width)) continue
        const cost = current.cost + distance(current.p, p) * this.field(p).cost
        if (cost >= (values.get(k) ?? Infinity)) continue
        values.set(k, cost); queue.push({ p, index: k, cost, previous: current }, cost + distance(p, goal) * 1.25)
      }
    }
    if (!last) return null
    const coarse: Point[] = [goal]
    for (let state: Cell | null = last; state; state = state.previous) coarse.push(state.p)
    coarse.reverse()
    const simple: Point[] = [start]
    for (let i = 0; i < coarse.length - 1;) {
      let chosen = i + 1
      for (let j = coarse.length - 1; j > i + 1; j--) {
        if (!this.validSegment(coarse[i]!, coarse[j]!, options.width)) continue
        const shortcut = this.cost([coarse[i]!, coarse[j]!], options.role), followed = this.cost(coarse.slice(i, j + 1), options.role)
        if (shortcut.cost <= followed.cost * 1.1) { chosen = j; break }
      }
      simple.push(coarse[chosen]!); i = chosen
    }
    const rounded: Point[] = [simple[0]!]
    for (let i = 1; i < simple.length - 1; i++) {
      const a = simple[i - 1]!, b = simple[i]!, c = simple[i + 1]!, trim = Math.min(75, distance(a, b) * .3, distance(b, c) * .3)
      const entry = lerp(b, a, trim / distance(a, b)), exit = lerp(b, c, trim / distance(b, c)), curve: Point[] = [entry]
      for (let j = 1; j <= 16; j++) { const t = j / 16; curve.push({ x: (1 - t) ** 2 * entry.x + 2 * (1 - t) * t * b.x + t * t * exit.x, y: (1 - t) ** 2 * entry.y + 2 * (1 - t) * t * b.y + t * t * exit.y }) }
      if (!this.validate(curve, options.width)) return null
      rounded.push(...curve)
    }
    rounded.push(goal)
    if (!this.validate(rounded, options.width)) return null
    const dense: Point[] = [rounded[0]!]
    for (let i = 1; i < rounded.length; i++) { const a = rounded[i - 1]!, b = rounded[i]!, n = Math.ceil(distance(a, b) / 12); for (let j = 1; j <= n; j++) dense.push(lerp(a, b, j / n)) }
    return this.cost(dense, options.role)
  }
  plan(start: Point, goal: Point, options: PlanningOptions): PlannedRoute | null {
    if (distance(start, goal) < 16 || !this.suitable(start, options.width) || !this.suitable(goal, options.width)) return null
    if (options.through && distance(start, options.through) > 20 && distance(goal, options.through) > 20) {
      const corner = options.through
      // Short town lanes follow property edges with a small corner radius. Treating
      // every 5m lane as a highway-radius curve produced repeated suburban U-loops.
      if (this.validate([start, corner, goal], options.width)) {
        const trim = Math.min(options.role === 'collector' ? 24 : 12, distance(start, corner) * .3, distance(goal, corner) * .3)
        const entry = lerp(corner, start, trim / distance(start, corner)), exit = lerp(corner, goal, trim / distance(goal, corner))
        const points = [start, entry]
        for (let i = 1; i <= 12; i++) { const t = i / 12; points.push({ x: (1 - t) ** 2 * entry.x + 2 * (1 - t) * t * corner.x + t * t * exit.x, y: (1 - t) ** 2 * entry.y + 2 * (1 - t) * t * corner.y + t * t * exit.y }) }
        points.push(goal)
        if (this.validate(points, options.width)) return this.cost(points, options.role)
      }
      const a = this.plan(start, options.through, { ...options, through: undefined, endHeading: undefined })
      if (!a) return null
      const last = a.points.at(-1)!, before = a.points.at(-2)!, heading = Math.atan2(last.y - before.y, last.x - before.x)
      const b = this.plan(options.through, goal, { ...options, through: undefined, startHeading: heading })
      if (!b) return null
      const result = this.cost([...a.points, ...b.points.slice(1)], options.role)
      if (result.length > distance(start, goal) * 2.3) return null
      return result
    }
    const crossSamples = Math.ceil(distance(start, goal) / 25)
    const crosses = Array.from({ length: crossSamples + 1 }, (_, i) => lerp(start, goal, i / Math.max(1, crossSamples))).some(p => this.waterAt(p))
    if (crosses && options.allowBridge) {
      const sites = this.environment.bridgeSites ?? this.environment.terrain?.bridgeSites ?? []
      const candidates = sites.map(site => ({ site, cost: distance(start, site) + distance(goal, site) })).sort((a, b) => a.cost - b.cost)
      let best: PlannedRoute | null = null
      for (const candidate of candidates.slice(0, 3)) {
        const pair = this.banks(candidate.site)
        if (!pair) continue
        const [entry, exit] = distance(start, pair[0]) < distance(start, pair[1]) ? pair : [pair[1], pair[0]]
        const a = this.plan(start, entry, { ...options, allowBridge: false, endHeading: undefined, maxNodes: options.maxNodes ?? 9000 })
        if (!a) continue
        const b = this.plan(exit, goal, { ...options, allowBridge: false, startHeading: undefined, maxNodes: options.maxNodes ?? 9000 })
        if (!b) continue
        const bridgeSteps = Math.ceil(distance(entry, exit) / 8), points = [...a.points]
        for (let i = 1; i <= bridgeSteps; i++) points.push(lerp(entry, exit, i / bridgeSteps))
        points.push(...b.points.slice(1))
        const route = this.cost(points, options.role); route.method = 'bridge-project'
        if (!best || route.cost < best.cost) best = route
      }
      if (best) return best
    }
    if (distance(start, goal) > 650 && options.startHeading === undefined) return this.corridor(start, goal, options)
    const direct = this.cost([start, goal], options.role)
    if (distance(start, goal) < 480 && this.validate([start, goal], options.width) && (options.startHeading === undefined || Math.abs(turn(Math.atan2(goal.y - start.y, goal.x - start.x) - options.startHeading)) < .40) && direct.cost / direct.length < 1.55) {
      const n = Math.ceil(direct.length / 12); direct.points = Array.from({ length: n + 1 }, (_, i) => lerp(start, goal, i / n)); direct.method = 'direct'; return direct
    }
    const major = options.role === 'highway' || options.role === 'collector', step = major ? 46 : 18, bin = Math.PI / 16, quantum = step * .52
    type State = { p: Point; heading: number; cost: number; previous: State | null; arc: Point[]; key: string }
    const stateKey = (p: Point, h: number) => `${Math.round(p.x / quantum)},${Math.round(p.y / quantum)},${(h + 32) % 32}`
    const queue = new MinHeap<State>(), best = new Map<string, number>(), initial = options.startHeading ?? Math.atan2(goal.y - start.y, goal.x - start.x)
    for (const delta of options.startHeading === undefined ? [-2, 0, 2] : [0]) {
      const heading = (Math.round(initial / bin) + delta + 32) % 32, k = stateKey(start, heading), state: State = { p: start, heading, cost: 0, previous: null, arc: [], key: k }
      best.set(k, 0); queue.push(state, distance(start, goal))
    }
    let finish: State | null = null, finalArc: Point[] = []
    const margin = Math.max(220, distance(start, goal) * .35), minX = Math.min(start.x, goal.x) - margin, maxX = Math.max(start.x, goal.x) + margin, minY = Math.min(start.y, goal.y) - margin, maxY = Math.max(start.y, goal.y) + margin
    for (let count = 0; queue.size && count < (options.maxNodes ?? (major ? 14000 : 4600)); count++) {
      const item = queue.pop()!, state = item.value
      if (state.cost > (best.get(state.key) ?? Infinity) + .001) continue
      const d = distance(state.p, goal), direction = Math.atan2(goal.y - state.p.y, goal.x - state.p.x)
      if (d < step * 1.8 && Math.abs(turn(direction - state.heading * bin)) < .54 && this.validSegment(state.p, goal, options.width)) {
        finish = state; const n = Math.max(1, Math.ceil(d / 10)); finalArc = Array.from({ length: n }, (_, i) => lerp(state.p, goal, (i + 1) / n)); break
      }
      for (const delta of major ? [-2, -1, 0, 1, 2] : [-4, -2, -1, 0, 1, 2, 4]) {
        const change = delta * bin, angle = state.heading * bin, arc: Point[] = []
        for (let j = 1; j <= 4; j++) {
          const t = j / 4
          arc.push(Math.abs(change) < 1e-8 ? { x: state.p.x + Math.cos(angle) * step * t, y: state.p.y + Math.sin(angle) * step * t } : { x: state.p.x + step / change * (Math.sin(angle + change * t) - Math.sin(angle)), y: state.p.y - step / change * (Math.cos(angle + change * t) - Math.cos(angle)) })
        }
        const p = arc.at(-1)!
        if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY || !this.suitable(p, options.width)) continue
        let previous = state.p, allowed = true, routeCost = 0
        for (const q of arc) { if (!this.validSegment(previous, q, options.width)) { allowed = false; break } routeCost += distance(previous, q) * this.field(q).cost; previous = q }
        if (!allowed) continue
        const heading = (state.heading + delta + 32) % 32, k = stateKey(p, heading), cost = state.cost + routeCost + (major ? 7 : 3.5) * delta * delta
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
