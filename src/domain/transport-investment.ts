import type { Point } from './types'
import type { GrowthCenter } from './urban-growth'
import { PlanarRoadGraph, projectOnRoadSegment, roadTravelSpeed } from './road-graph'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute } from './road-planner'
import type { RoadRole } from './road-graph'
import { frontageCapacity } from './frontage-supply'

interface MarketSite { point: Point; households: number; capacity: number; servicedCapacity?: number; area?: number; landValue: number; roadDistance: number; frontageDepth: number }
export interface TransportProject { pair: string; route: PlannedRoute; role: RoadRole; width: number; served: MarketSite[]; benefit: number; trips: number; minutesSaved: number }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** A housing frontage may purchase one modest surveyed bridge. Ordinary local
 * street searches stay dry: this opt-in requires actual occupied approaches and
 * a cluster of affordable vacant pads on the other bank. Final frontage benefit,
 * land formation and budget checks remain in the urban investment transaction. */
export function planHousingCollectorBridge(input: {
  graph: PlanarRoadGraph; planner: RoadPlanner; year: number; settlement: string; funds: number; unmet: number
  start: Point; goal: Point; site: Point; oppositeBankSupply: number
  occupied: { point: Point; households: number }[]
  cache: Map<string, PlannedRoute | null>
}): PlannedRoute | null {
  const { planner, start, goal } = input, terrain = planner.environment.terrain
  const chord = distance(start, goal), width = 6.5
  if (input.year < 1900 || !['regional-city', 'metropolis'].includes(input.settlement) || input.unmet < 20 || input.oppositeBankSupply < 90 || chord < 35 || chord > 600 || chord * 1.35 + 420 > input.funds) return null
  if (!terrain?.bridgeCandidates?.length || terrain.slope(input.site) > .08 || terrain.slope(goal) > .08 || terrain.waterAt(goal)) return null
  if (input.occupied.filter(cell => cell.households > 0 && distance(cell.point, start) < 250).reduce((sum, cell) => sum + cell.households, 0) < 20) return null
  const steps = Math.max(1, Math.ceil(chord / 4))
  let crossesRiver = false
  for (let i = 0; i <= steps; i++) {
    const p = { x: start.x + (goal.x - start.x) * i / steps, y: start.y + (goal.y - start.y) * i / steps }
    if (terrain.seaAt?.(p)) return null
    if (planner.waterAt(p)) crossesRiver = true
  }
  if (!crossesRiver) return null
  // Most dry-route failures are nowhere near a useful surveyed crossing. Check
  // admissible bank-to-bank length before invoking the expensive route search.
  const maximumLength = Math.min(720, chord * 1.9)
  const existingBridgeNear = (point: Point) => input.graph.roads.some(road => (road.bridge || road.role === 'bridge') && road.points.some(p => distance(p, point) < 180))
  if (!terrain.bridgeCandidates.some(candidate => candidate.width <= 110 && !existingBridgeNear(candidate.point) && Math.min(
    distance(start, candidate.bankA) + distance(candidate.bankA, candidate.bankB) + distance(candidate.bankB, goal),
    distance(start, candidate.bankB) + distance(candidate.bankB, candidate.bankA) + distance(candidate.bankA, goal),
  ) <= maximumLength)) return null
  const key = `${planner.transportRevision}:${start.x.toFixed(2)},${start.y.toFixed(2)}:${goal.x.toFixed(2)},${goal.y.toFixed(2)}`
  let route = input.cache.get(key)
  if (route === undefined) {
    route = planner.plan(start, goal, { role: 'collector', width, allowBridge: true, maximumGrade: .08, maxNodes: 6000 })
    input.cache.set(key, route)
  }
  if (!route || route.bridgeLength <= 0 || route.bridgeLength > 110 || route.length > 720 || route.length > chord * 1.9 || route.cost > input.funds || route.surveyedBridgeSpans?.length !== 1) return null
  // A nearby existing bridge is reused through its bank roads; it is not a
  // licence to buy a parallel deck or reinsert the same graph edges.
  const span = route.surveyedBridgeSpans[0]!, middle = { x: (span.bankA.x + span.bankB.x) / 2, y: (span.bankA.y + span.bankB.y) / 2 }
  if (existingBridgeNear(middle)) return null
  return route
}

/** Public links compete on ten-year travel savings and actual new frontage.
 * Credit is a relative 6m local-road construction unit; fees and tax rates live
 * in the simulation, not empirical currency or a calibrated transport forecast. */
export function transportProjects(input: {
  graph: PlanarRoadGraph; planner: RoadPlanner; centers: GrowthCenter[]; cells: MarketSite[]; year: number; funds: number; arterial: boolean
  completed: Set<string>; cache: Map<string, PlannedRoute | null>; trafficTime?: (a: Point, b: Point) => number
}): TransportProject[] {
  const { graph, planner, cells, year } = input
  const centers = input.centers.filter(center => center.activeYear <= year)
  const households = centers.map(() => 0)
  for (const cell of cells) {
    if (!cell.households) continue
    const weights = centers.map(center => center.weight * Math.exp(-distance(cell.point, center.point) / center.catchment)), sum = weights.reduce((a, b) => a + b, 0)
    for (let i = 0; i < centers.length; i++) households[i]! += cell.households * weights[i]! / sum
  }
  const projects: TransportProject[] = []
  for (let i = 0; i < centers.length; i++) for (let j = i + 1; j < centers.length; j++) {
    const a = centers[i]!, b = centers[j]!, pair = `${a.point.x.toFixed(2)},${a.point.y.toFixed(2)}:${b.point.x.toFixed(2)},${b.point.y.toFixed(2)}`
    if (input.completed.has(pair) || distance(a.point, b.point) < 420 || distance(a.point, b.point) > 2400) continue
    const trips = Math.sqrt(households[i]! * households[j]!) * (a.kind === 'industrial' || b.kind === 'industrial' ? 3 : 2.4)
    if (trips < 80) continue
    const first = graph.nearest(a.point, 180), last = graph.nearest(b.point, 180)
    if (!first || !last) continue
    // This programme links internal markets/stations, so it is a collector
    // even at high traffic volumes. National through-routes are surveyed by
    // the separate boundary-to-boundary regional programme.
    const role: RoadRole = 'collector', width = input.arterial && trips >= 900 ? 13 : 9.5
    let route: PlannedRoute | null = null
    // Start with the market itself, then adjacent existing street sites if its
    // junction has no free approach sector. This also avoids piling five arms
    // into the same historic gate simply because it is the demand center.
    const starts = [first, ...graph.projections(a.point, 180, 3).filter(anchor => distance(anchor.point, first.point) > 40)]
    const ends = [last, ...graph.projections(b.point, 180, 3).filter(anchor => distance(anchor.point, last.point) > 40)]
    for (const start of starts) {
      for (const end of ends) {
        const startHeading = graph.junctionHeading(start.point, end.point), departure = graph.junctionHeading(end.point, start.point)
        if (startHeading === null || departure === null) continue
        const endHeading = departure + Math.PI
        const key = `${planner.transportRevision}:${pair}:${role}:${width}:${start.point.x.toFixed(1)},${start.point.y.toFixed(1)}:${end.point.x.toFixed(1)},${end.point.y.toFixed(1)}:${startHeading.toFixed(2)}:${endHeading.toFixed(2)}`
        let candidate = input.cache.get(key)
        if (candidate === undefined) { candidate = planner.plan(start.point, end.point, { role, width, startHeading, endHeading, allowBridge: true, maxNodes: 12000 }); input.cache.set(key, candidate) }
        if (candidate && !graph.hasAcuteMajorCrossing(candidate.points)) { route = candidate; break }
      }
      if (route) break
    }
    if (!route || route.cost > input.funds || route.length > distance(first.point, last.point) * 1.8) continue
    const impedance = year < 1900 ? 2.7 : year < 1950 ? 1.5 : 1
    const oldTime = (input.trafficTime ?? ((a, b) => graph.travelTime(a, b)))(route.points[0]!, route.points.at(-1)!)
    // The same finite scenario appraisal as resident-funded bank connections:
    // missing connectivity is a15-minute penalty, never infinite free benefit.
    const baseline = Number.isFinite(oldTime) ? Math.min(30, oldTime) : 15
    const minutesSaved = Math.max(0, baseline - route.length / roadTravelSpeed({ role })) * impedance
    const minX = Math.min(...route.points.map(p => p.x)) - 42, maxX = Math.max(...route.points.map(p => p.x)) + 42, minY = Math.min(...route.points.map(p => p.y)) - 42, maxY = Math.max(...route.points.map(p => p.y)) + 42
    const served = cells.filter(cell => cell.households < cell.capacity && cell.landValue > .025 && cell.roadDistance > cell.frontageDepth && cell.point.x >= minX && cell.point.x <= maxX && cell.point.y >= minY && cell.point.y <= maxY && route!.points.slice(1).some((p, k) => distance(cell.point, projectOnRoadSegment(cell.point, route!.points[k]!, p).point) < cell.frontageDepth))
    const capacity = served.reduce((sum, cell) => {
      let nearest = cell.roadDistance
      for (let i = 1; i < route!.points.length; i++) nearest = Math.min(nearest, distance(cell.point, projectOnRoadSegment(cell.point, route!.points[i - 1]!, route!.points[i]!).point))
      return sum + Math.max(0, frontageCapacity(cell, nearest) - Math.max(cell.households, cell.servicedCapacity ?? 0))
    }, 0)
    // 250 trip-days/year, eight discounted years, .02 credit/person-hour.
    // These transparent scenario assumptions give time savings and construction
    // costs a common unit instead of arbitrarily rewarding a colored line.
    const benefit = minutesSaved * trips / 60 * 250 * 8 * .02 + capacity * (year < 1900 ? 28 : 36)
    if (benefit > route.cost) projects.push({ pair, route, role, width, served, benefit, trips, minutesSaved })
  }
  return projects.sort((a, b) => (b.benefit - b.route.cost) / b.route.cost - (a.benefit - a.route.cost) / a.route.cost || a.pair.localeCompare(b.pair))
}
