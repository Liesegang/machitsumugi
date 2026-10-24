import type { Point } from './types'
import { PlanarRoadGraph, projectOnRoadSegment, roadTravelSpeed } from './road-graph'
import type { RoadRole } from './road-graph'
import { occupiedSitesNear, surveyNeighborhoodConnections } from './neighborhood-survey'
import type { OccupiedSite } from './neighborhood-survey'
import { RoadPlanner, roadConstructionFactor } from './road-planner'
import type { PlannedRoute } from './road-planner'

export interface NeighborhoodConnection { route: PlannedRoute; width: number; trips: number; minutesSaved: number; benefit: number }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const MAX_ROUTE_SURVEYS = 6

/** Local through-links are purchased for existing residents, independently of
 * new housing supply. Surveys follow inhabited streets, never a world grid.
 * The generator reevaluates each detour after earlier links have been built. */
interface NeighborhoodInput {
  graph: PlanarRoadGraph; planner: RoadPlanner; cells: OccupiedSite[]; year: number
  availableFunds: () => number; cache: Map<string, PlannedRoute | null>
  trafficTime?: (a: Point, b: Point) => number
  networkBenefit?: (route: PlannedRoute, width: number, role: RoadRole) => number | undefined
}
export function* neighborhoodConnections(input: NeighborhoodInput): Generator<NeighborhoodConnection> {
  const { graph, planner, year } = input
  if (input.availableFunds() <= 0) return
  const surveys = surveyNeighborhoodConnections(input)
  const occupied = input.cells.filter(cell => cell.households > 0)
  const nearby = occupiedSitesNear(occupied)
  const width = year < 1900 ? 5.7 : 6.3, impedance = year < 1900 ? 2.7 : year < 1950 ? 1.5 : 1
  // Same transparent assumptions as public inter-market roads: 250 trip days,
  // eight discounted years and .02 construction credit per person-hour.
  const valueOfMinutes = 250 * 8 * .02 / 60
  let planned = 0
  for (const survey of surveys) {
    const lowerCost = survey.chord * roadConstructionFactor('lane')
    if (lowerCost > input.availableFunds()) continue
    const oldTime = (input.trafficTime ?? ((a, b) => graph.travelTime(a, b)))(survey.a, survey.b)
    // A disconnected catchment belongs to the separately surveyed bank / market
    // programme. Finite loaded detours may justify a local link, but never an
    // unlimited appraisal or an assumed source of construction funds.
    const baseline = Math.min(30, oldTime), speed = roadTravelSpeed({ role: 'lane', width })
    if (!Number.isFinite(oldTime) || (!input.networkBenefit && (baseline - survey.chord / speed) * impedance * survey.trips * valueOfMinutes <= lowerCost)) continue
    const startHeading = graph.junctionHeading(survey.a, survey.b), departure = graph.junctionHeading(survey.b, survey.a)
    if (startHeading === null || departure === null) continue
    // Explicit per-round survey budget, independent of how many homes produce
    // near-identical proposals. Every attempted route keeps its full survey.
    if (planned++ >= MAX_ROUTE_SURVEYS) break
    const endHeading = departure + Math.PI
    const key = `${planner.transportRevision}:${width}:${survey.a.x.toFixed(2)},${survey.a.y.toFixed(2)}:${survey.b.x.toFixed(2)},${survey.b.y.toFixed(2)}:${startHeading.toFixed(3)}:${endHeading.toFixed(3)}`
    let route = input.cache.get(key)
    if (route === undefined) {
      route = planner.plan(survey.a, survey.b, { role: 'lane', width, startHeading, endHeading, allowBridge: false, maxNodes: 2400 })
      input.cache.set(key, route)
    }
    if (!route || route.length > survey.chord * 1.55 || route.cost > input.availableFunds() || graph.hasAcuteMajorCrossing(route.points)) continue
    // Occupied market cells are area integrals, not individual house sites.
    // Charge displaced residential land in addition to the planner's terrain /
    // inherited ownership cost rather than treating an occupied block as free.
    const affected = new Set<OccupiedSite>()
    for (let i = 1; i < route.points.length; i++) for (const site of nearby(route.points[i]!)) if (distance(site.point, projectOnRoadSegment(site.point, route.points[i - 1]!, route.points[i]!).point) < 35) affected.add(site)
    const acquisition = [...affected].reduce((sum, site) => sum + site.households * Math.min(1, route.length * width / (site.area ?? 9500)) * 24, 0)
    const cost = route.cost + acquisition
    if (cost > input.availableFunds() || !(cost > 0) || !Number.isFinite(cost)) continue
    const minutesSaved = Math.max(0, baseline - route.length / speed) * impedance
    const localBenefit = minutesSaved * survey.trips * valueOfMinutes
    const network = input.networkBenefit?.({ ...route, cost }, width, 'lane')
    // Both estimates include local users. Taking the larger estimate, rather
    // than summing, avoids counting their time savings twice. An exhausted
    // network appraisal budget returns undefined and keeps the local estimate.
    const benefit = Math.max(localBenefit, Number.isFinite(network) ? network! : 0)
    if (!Number.isFinite(benefit) || benefit <= cost) continue
    yield { route: { ...route, cost }, width, trips: survey.trips, minutesSaved, benefit }
  }
}

/** Existing-resident transport investment is independent of new development
 * fees or population growth. Only committed projects consume the finite levy. */
export function investInNeighborhood(input: Omit<NeighborhoodInput, 'availableFunds'> & { funds: number; commit: (project: NeighborhoodConnection, remainingFunds: number) => boolean | { cost: number } }) {
  let spent = 0, completed = 0
  if (input.year < 1750 || input.year % 10 !== 0 || input.funds <= 70) return { spent, completed }
  for (const project of neighborhoodConnections({ ...input, availableFunds: () => input.funds - spent })) {
    const remainingFunds = input.funds - spent, committed = input.commit(project, remainingFunds)
    if (!committed) continue
    const cost = typeof committed === 'object' ? committed.cost : project.route.cost
    // The transaction must check its physical resurvey against this same limit
    // before mutation. Never silently hide a broken committed-cost contract.
    if (!Number.isFinite(cost) || cost < 0 || cost > remainingFunds) throw new RangeError('Committed neighborhood work exceeds its available construction funds')
    spent += cost; completed++
  }
  return { spent, completed }
}
