import type { CityType, Point } from './types'
import type { RoadRole } from './road-graph'
import { roadConstructionFactor } from './road-planner'

export interface NeighborhoodStreet {
  from: Point; to: Point; role: RoadRole; width: number
}

/** A bounded post-war readjustment programme, tied to a surveyed local axis.
 * The spines precede perimeter links and cross streets. Every later street
 * starts on an earlier street; the boundary is closed before interior infill.
 * Actual purchase still requires terrain, demand, title and funding surveys. */
export function plannedNeighborhoodStreets(center: Point, angle: number): NeighborhoodStreet[] {
  const along = { x: Math.cos(angle), y: Math.sin(angle) }, across = { x: -along.y, y: along.x }
  const at = (u: number, v: number): Point => ({ x: center.x + along.x * u + across.x * v, y: center.y + along.y * u + across.y * v })
  const projects: NeighborhoodStreet[] = []
  const add = (a: [number, number], b: [number, number], spine = false) => projects.push({ from: at(...a), to: at(...b), role: spine ? 'collector' : 'lane', width: spine ? 10 : 6.5 })
  for (const side of [-1, 1]) { add([0, 0], [side * 330, 0], true); add([0, 0], [0, side * 300], true) }
  for (const u of [-330, 330]) for (const side of [-1, 1]) add([u, 0], [u, side * 300])
  for (const v of [-300, 300, -150, 150]) for (const side of [-1, 1]) add([0, v], [side * 330, v])
  for (const u of [-165, 165]) for (const side of [-1, 1]) add([u, 0], [u, side * 300])
  return projects
}

export interface PlannedNeighborhood {
  center: Point; angle: number; year: number; completed: number
}
export interface NeighborhoodCell {
  point: Point; households: number; capacity: number; landValue: number
}

/** Only these dated, demand-backed commitments can reserve a new district.
 * Its later streets share one programme regardless of the town's origin type. */
export function canCommitPlannedNeighborhood(input: {
  year: number; unmetHouseholds: number; populationFalling: boolean; type: CityType
  settlement: 'village' | 'rural-town' | 'regional-city' | 'metropolis'
  targetHouseholds: number; districtCount: number; lastProjectYear: number
}): boolean {
  return input.year >= 1955 && input.unmetHouseholds > 90 && !input.populationFalling &&
    (input.settlement === 'regional-city' || input.settlement === 'metropolis' || (input.type === 'newtown' && input.targetHouseholds > 700)) &&
    input.districtCount < (input.type === 'newtown' ? 3 : 2) && input.year - input.lastProjectYear >= 10
}

/** The same surveyed district frame is used for both its residents and the
 * reservation against unrelated expansion. A nearby old town cannot justify
 * completing an otherwise empty housing estate. */
export function plannedNeighborhoodContains(point: Point, district: Pick<PlannedNeighborhood, 'center' | 'angle'>): boolean {
  const x = point.x - district.center.x, y = point.y - district.center.y, cos = Math.cos(district.angle), sin = Math.sin(district.angle)
  return Math.abs(x * cos + y * sin) <= 360 && Math.abs(-x * sin + y * cos) <= 360
}

export function plannedNeighborhoodDemand(district: Pick<PlannedNeighborhood, 'center' | 'angle'>, cells: readonly NeighborhoodCell[]) {
  let households = 0, unusedCapacity = 0
  for (const cell of cells) if (plannedNeighborhoodContains(cell.point, district)) {
    households += cell.households
    if (cell.landValue > .025) unusedCapacity += Math.max(0, cell.capacity - cell.households)
  }
  return { households, unusedCapacity }
}

/** Advance an already connected, finite programme using only its existing
 * development balance. Residents still need connected blocks after citywide
 * demand has been met; vacant estates need unserved demand to start building.
 * The caller retains the physical/full-width/dated acquisition survey and must
 * commit atomically within maximumCost, returning the actual charge or null. */
export function advancePlannedNeighborhood<Route extends { cost: number }>(input: {
  district: PlannedNeighborhood; year: number; unmetHouseholds: number; budget: number; cells: readonly NeighborhoodCell[]
  nearest(point: Point): Point | null
  suitable(point: Point, width: number): boolean
  plan(from: Point, street: NeighborhoodStreet): Route | null
  commit(route: Route, street: NeighborhoodStreet, maximumCost: number): number | null
}) {
  const demand = plannedNeighborhoodDemand(input.district, input.cells)
  const result = { completed: input.district.completed, accepted: 0, spent: 0, ...demand }
  if (input.year < 1955 || input.year <= input.district.year || !Number.isFinite(input.budget) || input.budget <= 0 || (!demand.households && input.unmetHouseholds <= 40)) return result
  const projects = plannedNeighborhoodStreets(input.district.center, input.district.angle), potential = demand.households + demand.unusedCapacity
  while (result.accepted < 2 && result.completed < projects.length) {
    const street = projects[result.completed]!, from = input.nearest(street.from), remaining = input.budget - result.spent
    if (!from || !input.suitable(street.to, street.width)) { result.completed++; continue }
    // The route cache also uses a funding lower bound. A temporary lack of
    // money must defer this street, rather than mark it geometrically rejected.
    const lowerBound = Math.hypot(street.to.x - from.x, street.to.y - from.y) * roadConstructionFactor(street.role)
    if (lowerBound > remaining || lowerBound > potential * 30) break
    const route = input.plan(from, street)
    if (!route || !Number.isFinite(route.cost) || route.cost < 0) { result.completed++; continue }
    if (route.cost > remaining || route.cost > potential * 30) break
    const cost = input.commit(route, street, remaining)
    if (cost !== null) {
      if (!Number.isFinite(cost) || cost < 0 || cost > remaining + 1e-7) throw new Error('Planned neighbourhood commitment exceeded its surveyed balance')
      result.spent += cost; result.accepted++
    }
    result.completed++
  }
  return result
}

/** A flat infill chord is surveyed before adding an arbitrary curve through
 * an opportunity centroid. It must actually service that land; off-chord land
 * keeps its separately surveyed access instead of forcing a decorative bend. */
export function canSurveyInfillChord(input: { site: Point; from: Point; to: Point; frontageDepth: number; year: number; slope(point: Point): number }): boolean {
  if (input.year < 1880) return false
  const dx = input.to.x - input.from.x, dy = input.to.y - input.from.y, length2 = dx * dx + dy * dy
  if (length2 < 90 * 90) return false
  const t = ((input.site.x - input.from.x) * dx + (input.site.y - input.from.y) * dy) / length2
  if (t <= 0 || t >= 1) return false
  const distance = Math.hypot(input.site.x - input.from.x - dx * t, input.site.y - input.from.y - dy * t)
  return distance < input.frontageDepth * .8 && [input.from, input.to, input.site, { x: input.from.x + dx / 2, y: input.from.y + dy / 2 }].every(point => input.slope(point) <= .055)
}
