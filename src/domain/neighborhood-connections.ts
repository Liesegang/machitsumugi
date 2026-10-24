import type { Point } from './types'
import { PlanarRoadGraph, projectOnRoadSegment, roadTravelSpeed } from './road-graph'
import { occupiedSitesNear, surveyNeighborhoodConnections } from './neighborhood-survey'
import type { OccupiedSite } from './neighborhood-survey'
import { RoadPlanner, roadConstructionFactor } from './road-planner'
import type { PlannedRoute } from './road-planner'

export interface NeighborhoodConnection { route: PlannedRoute; width: number; trips: number; minutesSaved: number; benefit: number }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** Local through-links are purchased for existing residents, independently of
 * new housing supply. Surveys follow inhabited streets, never a world grid.
 * The generator reevaluates each detour after earlier links have been built. */
interface NeighborhoodInput {
  graph: PlanarRoadGraph; planner: RoadPlanner; cells: OccupiedSite[]; year: number
  availableFunds: () => number; cache: Map<string, PlannedRoute | null>
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
  for (const survey of surveys) {
    const lowerCost = survey.chord * roadConstructionFactor('lane')
    if (lowerCost > input.availableFunds()) continue
    const oldTime = graph.travelTime(survey.a, survey.b), directTime = survey.chord / roadTravelSpeed({ role: 'lane' })
    if (!Number.isFinite(oldTime) || (oldTime - directTime) * impedance * survey.trips * valueOfMinutes <= lowerCost) continue
    const startHeading = graph.junctionHeading(survey.a, survey.b), departure = graph.junctionHeading(survey.b, survey.a)
    if (startHeading === null || departure === null) continue
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
    const minutesSaved = Math.max(0, oldTime - route.length / roadTravelSpeed({ role: 'lane' })) * impedance
    const benefit = minutesSaved * survey.trips * valueOfMinutes
    if (cost > input.availableFunds() || benefit <= cost) continue
    yield { route: { ...route, cost }, width, trips: survey.trips, minutesSaved, benefit }
  }
}

/** Existing-resident transport investment is independent of new development
 * fees or population growth. Only committed projects consume the finite levy. */
export function investInNeighborhood(input: Omit<NeighborhoodInput, 'availableFunds'> & { funds: number; commit: (project: NeighborhoodConnection) => boolean }) {
  let spent = 0, completed = 0
  if (input.year < 1750 || input.year % 10 !== 0 || input.funds <= 70) return { spent, completed }
  for (const project of neighborhoodConnections({ ...input, availableFunds: () => input.funds - spent })) {
    if (!input.commit(project)) continue
    spent += project.route.cost; completed++
  }
  return { spent, completed }
}
