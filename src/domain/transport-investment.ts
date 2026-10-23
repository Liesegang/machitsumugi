import type { Point } from './types'
import type { GrowthCenter } from './urban-growth'
import { PlanarRoadGraph, projectOnRoadSegment, roadTravelSpeed } from './road-graph'
import { RoadPlanner } from './road-planner'
import type { PlannedRoute } from './road-planner'
import type { RoadRole } from './road-graph'

interface MarketSite { point: Point; households: number; capacity: number; landValue: number; roadDistance: number; frontageDepth: number }
export interface TransportProject { pair: string; route: PlannedRoute; role: RoadRole; width: number; served: MarketSite[]; benefit: number; trips: number; minutesSaved: number }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** Public links compete on ten-year travel savings and actual new frontage.
 * Credit is a relative 6m local-road construction unit; fees and tax rates live
 * in the simulation, not empirical currency or a calibrated transport forecast. */
export function transportProjects(input: {
  graph: PlanarRoadGraph; planner: RoadPlanner; centers: GrowthCenter[]; cells: MarketSite[]; year: number; funds: number; arterial: boolean
  completed: Set<string>; cache: Map<string, PlannedRoute | null>
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
    const role: RoadRole = input.arterial && trips >= 900 ? 'highway' : 'collector', width = role === 'highway' ? 13 : 9.5
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
        const key = `${pair}:${role}:${start.point.x.toFixed(1)},${start.point.y.toFixed(1)}:${end.point.x.toFixed(1)},${end.point.y.toFixed(1)}:${startHeading.toFixed(2)}:${endHeading.toFixed(2)}`
        let candidate = input.cache.get(key)
        if (candidate === undefined) { candidate = planner.plan(start.point, end.point, { role, width, startHeading, endHeading, allowBridge: true, maxNodes: 12000 }); input.cache.set(key, candidate) }
        if (candidate && !graph.hasAcuteMajorCrossing(candidate.points)) { route = candidate; break }
      }
      if (route) break
    }
    if (!route || route.cost > input.funds || route.length > distance(first.point, last.point) * 1.8) continue
    const impedance = year < 1900 ? 2.7 : year < 1950 ? 1.5 : 1
    const minutesSaved = Math.max(0, graph.travelTime(route.points[0]!, route.points.at(-1)!) - route.length / roadTravelSpeed({ role })) * impedance
    const minX = Math.min(...route.points.map(p => p.x)) - 42, maxX = Math.max(...route.points.map(p => p.x)) + 42, minY = Math.min(...route.points.map(p => p.y)) - 42, maxY = Math.max(...route.points.map(p => p.y)) + 42
    const served = cells.filter(cell => cell.households < cell.capacity && cell.landValue > .025 && cell.roadDistance > cell.frontageDepth && cell.point.x >= minX && cell.point.x <= maxX && cell.point.y >= minY && cell.point.y <= maxY && route!.points.slice(1).some((p, k) => distance(cell.point, projectOnRoadSegment(cell.point, route!.points[k]!, p).point) < cell.frontageDepth))
    const capacity = served.reduce((sum, cell) => sum + cell.capacity - cell.households, 0)
    // 250 trip-days/year, eight discounted years, .02 credit/person-hour.
    // These transparent scenario assumptions give time savings and construction
    // costs a common unit instead of arbitrarily rewarding a colored line.
    const benefit = minutesSaved * trips / 60 * 250 * 8 * .02 + capacity * (year < 1900 ? 28 : 36)
    if (benefit > route.cost) projects.push({ pair, route, role, width, served, benefit, trips, minutesSaved })
  }
  return projects.sort((a, b) => (b.benefit - b.route.cost) / b.route.cost - (a.benefit - a.route.cost) / a.route.cost || a.pair.localeCompare(b.pair))
}
