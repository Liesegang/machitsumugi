import type { Point } from './types'
import { PlanarRoadGraph, projectOnRoadSegment, roadTravelSpeed } from './road-graph'
import { RoadPlanner, roadConstructionFactor } from './road-planner'
import type { PlannedRoute } from './road-planner'

interface OccupiedSite { point: Point; households: number; area?: number; frontageDepth?: number }
export interface NeighborhoodConnection { route: PlannedRoute; width: number; trips: number; minutesSaved: number; benefit: number }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** Local through-links are purchased for existing residents, independently of
 * new housing supply. Surveys follow inhabited streets, never a world grid.
 * The generator reevaluates each detour after earlier links have been built. */
export function* neighborhoodConnections(input: {
  graph: PlanarRoadGraph; planner: RoadPlanner; cells: OccupiedSite[]; year: number
  availableFunds: () => number; cache: Map<string, PlannedRoute | null>
}): Generator<NeighborhoodConnection> {
  const { graph, planner, year } = input
  const occupied = input.cells.filter(cell => cell.households > 0)
  if (!occupied.length || input.availableFunds() <= 0) return
  const buckets = new Map<string, OccupiedSite[]>()
  for (const cell of occupied) {
    const key = `${Math.floor(cell.point.x / 150)}:${Math.floor(cell.point.y / 150)}`, bucket = buckets.get(key) ?? []
    bucket.push(cell); buckets.set(key, bucket)
  }
  const nearby = (point: Point) => {
    const found: OccupiedSite[] = [], x = Math.floor(point.x / 150), y = Math.floor(point.y / 150)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const cell of buckets.get(`${x + dx}:${y + dy}`) ?? []) if (distance(point, cell.point) < 150) found.push(cell)
    return found
  }
  type Survey = { a: Point; b: Point; chord: number; trips: number; key: string }
  const surveys = new Map<string, Survey>()
  for (const cell of occupied) {
    const first = graph.nearest(cell.point, (cell.frontageDepth ?? 40) + 5)
    if (!first) continue
    for (const last of graph.projections(cell.point, 260, 5)) {
      const chord = distance(first.point, last.point)
      if (chord < 70 || chord > 300) continue
      // Disjoint residential catchments avoid counting a household's own trips
      // to itself where the two 150m walksheds overlap.
      const a = first.point, b = last.point
      const householdsA = nearby(a).filter(site => distance(site.point, a) < distance(site.point, b)).reduce((sum, site) => sum + site.households * (1 - distance(site.point, a) / 150), 0)
      const householdsB = nearby(b).filter(site => distance(site.point, b) <= distance(site.point, a)).reduce((sum, site) => sum + site.households * (1 - distance(site.point, b) / 150), 0)
      const trips = 2.4 * Math.sqrt(householdsA * householdsB)
      if (trips <= 0) continue
      // A 40m survey cell merges near-identical proposals; it never positions
      // a street. The endpoints remain exact projections on inherited roads.
      const ends = [a, b].map(p => `${Math.round(p.x / 40)},${Math.round(p.y / 40)}`).sort(), key = ends.join(':')
      const previous = surveys.get(key)
      if (!previous || trips / chord > previous.trips / previous.chord) surveys.set(key, { a, b, chord, trips, key })
    }
  }
  const width = year < 1900 ? 5.7 : 6.3, impedance = year < 1900 ? 2.7 : year < 1950 ? 1.5 : 1
  // Same transparent assumptions as public inter-market roads: 250 trip days,
  // eight discounted years and .02 construction credit per person-hour.
  const valueOfMinutes = 250 * 8 * .02 / 60
  for (const survey of [...surveys.values()].sort((a, b) => b.trips / b.chord - a.trips / a.chord || a.key.localeCompare(b.key))) {
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
