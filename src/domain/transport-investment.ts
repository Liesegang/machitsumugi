import type { Point } from './types'
import type { GrowthCenter } from './urban-growth'
import { PlanarRoadGraph, projectOnRoadSegment, roadTravelSpeed } from './road-graph'
import { RoadPlanner, roadConstructionFactor } from './road-planner'
import type { PlannedRoute } from './road-planner'
import type { RoadRole } from './road-graph'
import { frontageCapacity } from './frontage-supply'
import { routeAcrossBridges } from './bridge-routing'
import { alignmentDiagnostics } from './road-alignment'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'

interface MarketSite { point: Point; households: number; capacity: number; servicedCapacity?: number; area?: number; landValue: number; roadDistance: number; frontageDepth: number }
export interface TransportProject { pair: string; route: PlannedRoute; role: RoadRole; width: number; served: MarketSite[]; benefit: number; trips: number; minutesSaved: number }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const frontierDryKey = (revision: number, a: Point, b: Point, startHeading?: number, endHeading?: number) => `${revision}:frontier-dry:${a.x.toFixed(3)},${a.y.toFixed(3)}>${b.x.toFixed(3)},${b.y.toFixed(3)}:${startHeading?.toFixed(6)}:${endHeading?.toFixed(6)}`

/** A housing frontage may purchase one modest surveyed bridge. Ordinary local
 * street searches stay dry: this opt-in requires actual occupied approaches and
 * a cluster of affordable vacant pads on the other bank. Final frontage benefit,
 * land formation and budget checks remain in the urban investment transaction. */
export function planHousingCollectorBridge(input: {
  graph: PlanarRoadGraph; planner: RoadPlanner; year: number; settlement: string; funds: number; unmet: number
  start: Point; goal: Point; site: Point; oppositeBankSupply: number
  occupied: { point: Point; households: number }[]
  cache: Map<string, PlannedRoute | null>
  candidate?: { point: Point; bankA: Point; bankB: Point }
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
  const candidate = input.candidate
  if (candidate && !terrain.bridgeCandidates.some(pair => distance(pair.point, candidate.point) < .01 && distance(pair.bankA, candidate.bankA) < .01 && distance(pair.bankB, candidate.bankB) < .01)) return null
  if (candidate) {
    const angle = Math.atan2(candidate.bankB.y - candidate.bankA.y, candidate.bankB.x - candidate.bankA.x)
    const approaches = [frontierDryKey(planner.transportRevision, start, candidate.bankA, undefined, angle), frontierDryKey(planner.transportRevision, start, candidate.bankB, undefined, Math.atan2(candidate.bankA.y - candidate.bankB.y, candidate.bankA.x - candidate.bankB.x))]
    // Different vacant goals cannot repair two already failed dry approaches
    // to the same bridge. Reconsider them only after live transport changes.
    if (approaches.every(key => input.cache.has(key) && input.cache.get(key) === null)) return null
  }
  const key = `${planner.transportRevision}:${start.x.toFixed(2)},${start.y.toFixed(2)}:${goal.x.toFixed(2)},${goal.y.toFixed(2)}${candidate ? `:crossing:${candidate.point.x.toFixed(3)},${candidate.point.y.toFixed(3)}` : ''}`
  let route = input.cache.get(key)
  if (route === undefined) {
    if (candidate) {
      const span = { bankA: candidate.bankA, bankB: candidate.bankB }, deck = { points: [span.bankA, span.bankB], surveyedBridgeSpans: [span] }
      route = !planner.validate(deck.points, width, true) || !surveyedRoadGradeAllowed(deck, .08, terrain.elevation) ? null : routeAcrossBridges({
        start, goal, pairs: [{ a: span.bankA, b: span.bankB }], role: 'collector', width,
        lowerBound: (a, b) => distance(a, b) * roadConstructionFactor('collector'), cost: points => planner.cost(points, 'collector', true),
        dry: (a, b, startHeading, endHeading) => {
          const dryKey = frontierDryKey(planner.transportRevision, a, b, startHeading, endHeading)
          if (!input.cache.has(dryKey)) input.cache.set(dryKey, planner.plan(a, b, { role: 'collector', width, allowBridge: false, maximumGrade: .08, startHeading, endHeading, maxNodes: 6000 }))
          return input.cache.get(dryKey)!
        },
      })
      if (route && (alignmentDiagnostics(route.points).minimumRadius < 50 || !surveyedRoadGradeAllowed(route, .08, terrain.elevation))) route = null
    } else route = planner.plan(start, goal, { role: 'collector', width, allowBridge: true, maximumGrade: .08, maxNodes: 6000 })
    input.cache.set(key, route)
  }
  if (!route || route.bridgeLength <= 0 || route.bridgeLength > 110 || route.length > 720 || route.length > chord * 1.9 || route.cost > input.funds || route.surveyedBridgeSpans?.length !== 1) return null
  // A nearby existing bridge is reused through its bank roads; it is not a
  // licence to buy a parallel deck or reinsert the same graph edges.
  const span = route.surveyedBridgeSpans[0]!, middle = { x: (span.bankA.x + span.bankB.x) / 2, y: (span.bankA.y + span.bankB.y) / 2 }
  if (existingBridgeNear(middle)) return null
  return route
}

export interface FrontierMarketSite {
  point: Point; households: number; capacity: number; servicedCapacity?: number
  roadDistance: number; frontageDepth: number; area?: number
  suitability: number; formationCostPerHousehold: number
}
export interface HousingFrontierProject {
  route: PlannedRoute; role: 'collector'; width: number
  served: FrontierMarketSite[]; capacity: number; benefit: number
  accesses?: { route: PlannedRoute; role: 'access'; width: number }[]
}

/** Survey the whole short public access, including interior DEM samples. */
export function surveyHousingFrontageAccess(planner: RoadPlanner, start: Point, goal: Point, width: number): PlannedRoute | null {
  if (!(width > 0) || distance(start, goal) > 120) return null
  const route = planner.cost([start, goal], 'access'), terrain = planner.environment.terrain
  return Number.isFinite(route.cost) && !route.bridgeLength && planner.validate(route.points, width) && planner.railwayWidthAllows(route.points, .01, width, 'access') && (!terrain || surveyedRoadGradeAllowed(route, .08, terrain.elevation)) ? route : null
}

/** A first crossing must be considered before unserved land's current access
 * value. Otherwise the far bank needs a street to qualify for the very bridge
 * that would provide that street. Only actually surveyed additional frontage
 * contributes benefit; distant district capacity is not occupied in advance. */
export function planHousingFrontierBridge(input: {
  graph: PlanarRoadGraph; planner: RoadPlanner; cells: FrontierMarketSite[]
  year: number; settlement: string; funds: number; unmet: number
  cache: Map<string, PlannedRoute | null>
}): HousingFrontierProject | null {
  const { graph, planner, cells } = input, terrain = planner.environment.terrain
  if (input.year < 1900 || !['regional-city', 'metropolis'].includes(input.settlement) || input.unmet < 20 || !(input.funds > 420) || !terrain?.bridgeCandidates?.length) return null
  const vacant = cells.filter(cell => cell.capacity > cell.households && cell.suitability > .75 && cell.formationCostPerHousehold < 12 && terrain.slope(cell.point) <= .08 && !terrain.waterAt(cell.point))
  const pairs = terrain.bridgeCandidates.filter(pair => pair.width <= 110).flatMap(candidate => [[candidate.bankA, candidate.bankB], [candidate.bankB, candidate.bankA]].map(([entry, exit]) => ({ candidate, entry: entry!, exit: exit!, distance: graph.nearest(entry!, 430)?.distance ?? Infinity })))
    .filter(pair => pair.distance < 430).sort((a, b) => a.distance - b.distance || a.entry.x - b.entry.x || a.entry.y - b.entry.y)
  const appraise = (points: Point[], across: (point: Point) => boolean, accesses: Point[][] = []) => {
    const served: FrontierMarketSite[] = [], additional = new Map<FrontierMarketSite, number>()
    let farBankCapacity = 0
    for (const cell of vacant) {
      let nearest = cell.roadDistance
      for (const path of [points, ...accesses]) for (let i = 1; i < path.length; i++) nearest = Math.min(nearest, distance(cell.point, projectOnRoadSegment(cell.point, path[i - 1]!, path[i]!).point))
      // Occupancy requires the integration site's centre to have frontage;
      // a positive edge slice of its disk cannot pay for an unusable project.
      if (nearest >= cell.frontageDepth + 1) continue
      const prior = cell.roadDistance < cell.frontageDepth + 1 ? cell.servicedCapacity ?? frontageCapacity(cell, cell.roadDistance) : 0
      const capacity = Math.max(0, frontageCapacity(cell, nearest) - Math.max(cell.households, prior))
      if (capacity > 0) { served.push(cell); additional.set(cell, capacity); if (across(cell.point)) farBankCapacity += capacity }
    }
    const supplied = served.reduce((sum, cell) => sum + additional.get(cell)!, 0), capacity = Math.min(input.unmet, supplied)
    const formationCost = supplied ? capacity / supplied * served.reduce((sum, cell) => sum + additional.get(cell)! * cell.formationCostPerHousehold, 0) : 0
    return { served, capacity, farBankCapacity, benefit: capacity * 36 - formationCost }
  }
  const proposals: { anchor: Point; goal: Point; site: FrontierMarketSite; candidate: NonNullable<typeof terrain.bridgeCandidates>[number]; across: (point: Point) => boolean; available: number; round: number; approach: number; proximity: number; score: number }[] = []
  for (const { candidate, entry, exit } of pairs) {
    const dx = exit.x - entry.x, dy = exit.y - entry.y, length = distance(entry, exit)
    if (length < 1) continue
    const across = (point: Point) => ((point.x - exit.x) * dx + (point.y - exit.y) * dy) / length >= -8
    const supply = vacant.filter(cell => across(cell.point))
    const available = supply.filter(cell => distance(cell.point, exit) <= 330).reduce((sum, cell) => sum + cell.capacity - cell.households, 0)
    if (available < 90) continue
    // A real dry road already serving this bank uses normal organic extension;
    // a geometric nearest street across the water is not such a connection.
    const sameBank = graph.projections(exit, 180, 4).some(anchor => planner.validate([exit, anchor.point], 6.5))
    if (sameBank) continue
    const padGoals = supply.filter(cell => distance(cell.point, exit) >= 200 && distance(cell.point, exit) <= 450 && ((cell.point.x - exit.x) * dx + (cell.point.y - exit.y) * dy) / length >= 80)
      .map(site => ({ goal: site.point, site }))
    const straightGoals = [400, 320, 240, 160, 80].map(reach => ({ x: exit.x + dx / length * reach, y: exit.y + dy / length * reach }))
      .map(goal => ({ goal, site: supply.slice().sort((a, b) => distance(a.point, goal) - distance(b.point, goal))[0]! }))
      .filter(({ goal, site }) => distance(goal, site.point) < 150 && planner.suitable(goal, 6.5) && !terrain.waterAt(goal) && terrain.slope(goal) <= .08)
    const sites = [...padGoals, ...straightGoals]
    // The nearest pavement may leave less than one collector turning radius
    // before the pinned bank tangent. Prefer an approach with actual turning
    // space, then diversify crossings before trying several runout lengths.
    // This is only a search order: the planner still certifies every curve.
    const approachScore = (point: Point) => {
      const reach = distance(point, entry), dot = ((entry.x - point.x) * dx + (entry.y - point.y) * dy) / Math.max(1e-9, reach * length)
      const angle = Math.acos(Math.max(-1, Math.min(1, dot))), turnSpace = 100 * Math.sin(Math.min(Math.PI / 2, angle))
      return reach + Math.max(0, turnSpace - reach) * 4 + Math.max(0, angle - Math.PI / 2) * 100
    }
    const anchors = graph.projections(entry, 430, 4).filter(anchor => planner.suitable(anchor.point, 6.5)).sort((a, b) => approachScore(a.point) - approachScore(b.point))
    for (const [index, anchor] of anchors.entries()) for (const [runout, { goal, site }] of sites.entries()) {
      if (distance(anchor.point, goal) > 600) continue
      // A coarse line only orders proposals. The adopted curve, its actual
      // earthworks and exact occupiable frontage alone decide the investment.
      const approximate = [anchor.point, entry, exit, goal], estimate = planner.cost(approximate, 'collector', true).cost
      const score = Number.isFinite(estimate) && estimate > 0 ? (appraise(approximate, across).benefit - estimate) / estimate : -Infinity
      proposals.push({ anchor: anchor.point, goal, site, candidate, across, available, round: runout * 4 + index, approach: index, proximity: distance(anchor.point, entry), score })
    }
  }
  proposals.sort((a, b) => a.approach - b.approach || b.score - a.score || a.round - b.round || a.proximity - b.proximity || a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y)
  let surveys = 0
  for (const { anchor, goal, site, candidate, across, available } of proposals) {
    const before = input.cache.size
    const route = planHousingCollectorBridge({ ...input, start: anchor, goal, site: site.point, candidate, oppositeBankSupply: available, occupied: cells })
    if (input.cache.size > before) surveys++
    if (!route || !planner.railwayWidthAllows(route.points, .01, 6.5, 'collector')) { if (surveys >= 3) return null; continue }
    const { served, capacity, farBankCapacity, benefit } = appraise(route.points, across)
    if (farBankCapacity >= 20 && capacity >= 20 && benefit > route.cost && route.cost <= input.funds) return { route, role: 'collector', width: 6.5, served, capacity, benefit }
    // One actual local access may make a surveyed housing site usable. Its
    // pavement and cost are mandatory parts of this same bridge transaction;
    // no frontage is credited along an imaginary future neighbourhood street.
    const accessSites = vacant.filter(cell => across(cell.point)).flatMap(cell => {
      let anchor: Point | undefined, nearest = Infinity
      for (let i = 1; i < route.points.length; i++) {
        const point = projectOnRoadSegment(cell.point, route.points[i - 1]!, route.points[i]!).point, reach = distance(cell.point, point)
        if (reach < nearest) { anchor = point; nearest = reach }
      }
      if (!anchor || nearest < 6 || nearest > 120 || planner.waterAt(anchor)) return []
      const points = [anchor, cell.point], width = cell.frontageDepth < 25 ? 3.3 : 4.6, estimate = planner.cost(points, 'access').cost
      const score = appraise(route.points, across, [points]).benefit - route.cost - estimate
      return Number.isFinite(estimate) ? [{ points, width, score }] : []
    }).sort((a, b) => b.score - a.score).slice(0, 6)
    for (const access of accessSites) {
      if (access.score <= 0) continue
      const spur = surveyHousingFrontageAccess(planner, access.points[0]!, access.points[1]!, access.width)
      if (!spur) continue
      const totalCost = route.cost + spur.cost, actual = appraise(route.points, across, [spur.points])
      if (actual.farBankCapacity >= 20 && actual.capacity >= 20 && actual.benefit > totalCost && totalCost <= input.funds) return { route, role: 'collector', width: 6.5, served: actual.served, capacity: actual.capacity, benefit: actual.benefit, accesses: [{ route: spur, role: 'access', width: access.width }] }
    }
    if (surveys >= 3) return null
  }
  return null
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
