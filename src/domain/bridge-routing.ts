import type { Point } from './types'
import type { RoadRole } from './road-graph'
import type { PlannedRoute, SurveyedBridgeSpan } from './road-planner'

export interface BridgeRoutingInput {
  start: Point
  goal: Point
  pairs: { a: Point; b: Point }[]
  role: RoadRole
  width: number
  startHeading?: number
  endHeading?: number
  /** A physically validated land route; the caller may cache these expensive searches. */
  dry: (a: Point, b: Point, startHeading?: number, endHeading?: number) => PlannedRoute | null
  /** Construction cost of an already surveyed bridge or the assembled route. */
  cost: (points: Point[]) => PlannedRoute
  /** Admissible land construction-cost bound; zero remains a safe default. */
  lowerBound?: (a: Point, b: Point) => number
}

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y)
const angleDifference = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))

/** Lazy shortest paths on directed, surveyed bank pairs. No edge permits an unsurveyed water crossing.
 * Each state has a fixed departure tangent, so revisiting it with a larger cost cannot
 * improve any continuation. The land planner owns curvature, grade and obstacle checks. */
export function routeAcrossBridges(input: BridgeRoutingInput): PlannedRoute | null {
  if (!(input.width > 0) || !input.pairs.length) return null
  const crossings = input.pairs.flatMap(pair => distance(pair.a, pair.b) > 1e-6
    ? [{ entry: pair.a, exit: pair.b }, { entry: pair.b, exit: pair.a }]
    : []).map(pair => ({ ...pair, heading: Math.atan2(pair.exit.y - pair.entry.y, pair.exit.x - pair.entry.x), bridge: input.cost([pair.entry, pair.exit]) }))
  if (!crossings.length) return null
  const join = (a: Point[], b: Point[]) => a.concat(b.filter((p, i) => i !== 0 || !a.length || distance(a.at(-1)!, p) > 1e-6))
  const dry = (a: Point, b: Point, startHeading?: number, endHeading?: number): PlannedRoute | null => {
    if (distance(a, b) > 1e-6) return input.dry(a, b, startHeading, endHeading)
    if (startHeading !== undefined && endHeading !== undefined && angleDifference(startHeading, endHeading) > .06) return null
    return { points: [a], length: 0, cost: 0, bridgeLength: 0, method: 'direct' }
  }
  const count = crossings.length, start = count, goal = count + 1, nodes = count + 2
  const known = new Map<string, PlannedRoute | null>()
  const position = (node: number) => node === start ? input.start : crossings[node]!.exit
  const destination = (node: number) => node === goal ? input.goal : crossings[node]!.entry
  const edgeKey = (a: number, b: number) => `${a}:${b}`
  // Lazy shortest-path evaluation avoids planning every possible bank-to-bank
  // curve. Unknown land edges retain an admissible cost lower bound. A path is
  // accepted only when all of its edges are physically verified and it remains
  // shortest after replacing those bounds with actual costs. Every unsuccessful
  // iteration resolves at least one of the finite graph's unknown edges.
  for (let iteration = 0; iteration <= nodes * nodes; iteration++) {
    const best = new Float64Array(nodes).fill(Infinity), previous = new Int32Array(nodes).fill(-1), visited = new Uint8Array(nodes)
    best[start] = 0
    for (let step = 0; step < nodes; step++) {
      let current = -1
      for (let i = 0; i < nodes; i++) if (!visited[i] && Number.isFinite(best[i]!) && (current < 0 || best[i]! < best[current]!)) current = i
      if (current < 0 || current === goal) break
      visited[current] = 1
      for (let next = 0; next <= goal; next++) {
        if (next === start || next === current || visited[next]) continue
        const key = edgeKey(current, next), route = known.get(key)
        if (known.has(key) && !route) continue
        const landCost = route?.cost ?? input.lowerBound?.(position(current), destination(next)) ?? 0, bridgeCost = next < count ? crossings[next]!.bridge.cost : 0
        if (!(landCost >= 0) || !(bridgeCost >= 0) || !Number.isFinite(landCost + bridgeCost)) continue
        const cost = best[current]! + landCost + bridgeCost
        if (cost < best[next]!) { best[next] = cost; previous[next] = current }
      }
    }
    if (!Number.isFinite(best[goal]!)) return null
    const chain: number[] = []
    for (let node = goal; node !== start; node = previous[node]!) { if (node < 0) return null; chain.push(node) }
    chain.push(start); chain.reverse()
    let resolved = false
    for (let i = 1; i < chain.length; i++) {
      const from = chain[i - 1]!, to = chain[i]!, key = edgeKey(from, to)
      if (known.has(key)) continue
      const route = dry(position(from), destination(to), from === start ? input.startHeading : crossings[from]!.heading, to === goal ? input.endHeading : crossings[to]!.heading)
      known.set(key, route && Number.isFinite(route.cost) && route.cost >= 0 ? route : null)
      resolved = true
      if (!route) break
    }
    if (resolved) continue
    let points: Point[] = [input.start], cost = 0, bridges = 0
    const surveyedBridgeSpans: SurveyedBridgeSpan[] = []
    for (let i = 1; i < chain.length; i++) {
      const from = chain[i - 1]!, to = chain[i]!, leg = known.get(edgeKey(from, to))!
      points = join(points, leg!.points); cost += leg!.cost
      surveyedBridgeSpans.push(...(leg.surveyedBridgeSpans ?? []))
      if (to < count) { const crossing = crossings[to]!; points = join(points, [crossing.entry, crossing.exit]); cost += crossing.bridge.cost; bridges++; surveyedBridgeSpans.push({ bankA: crossing.entry, bankB: crossing.exit }) }
    }
    return { ...input.cost(points), cost, method: bridges ? 'bridge-project' : known.get(edgeKey(start, goal))!.method, ...(surveyedBridgeSpans.length ? { surveyedBridgeSpans } : {}) }
  }
  return null
}
