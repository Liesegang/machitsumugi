import type { Area, Point } from './types'
import { distanceToSegment, pointInRegion } from './geometry'
import { PlanarRoadGraph, projectOnRoadSegment, roadTravelSpeed } from './road-graph'
import { occupiedSitesNear } from './neighborhood-survey'
import type { OccupiedSite } from './neighborhood-survey'
import { RoadPlanner, roadConstructionFactor } from './road-planner'
import type { PlannedRoute } from './road-planner'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y)
const at = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const sea = (area: Area) => area.id === 'sea' || area.id.startsWith('sea-')
const MAX_WATER_SURVEYS = 48, MAX_ROUTE_SURVEYS = 3
const SHORE_REACH = 220, CROSSING_SEPARATION = 240

/** Fictional construction programme limits, not engineering certification.
 * Prewar local bridges carry a 6.5m street over at most120m of water. Postwar
 * urban collectors carry9.5m over at most320m (regional city) or480m (metropolis).
 * Housing-frontier bridges keep their separate110m cap. Seas are never crossed.
 */
export function bankBridgePolicy(year: number, settlement: string) {
  if (year < 1900 || !['regional-city', 'metropolis'].includes(settlement)) return null
  return year < 1955 ? { width: 6.5, maximumWaterSpan: 120 } : { width: 9.5, maximumWaterSpan: settlement === 'metropolis' ? 480 : 320 }
}

type ShoreEdge = { a: Point; b: Point; area: Area }
type ShoreIndex = { areas: Area[]; seas: Area[]; buckets: Map<string, ShoreEdge[]> }
const shorelineCaches = new WeakMap<RoadPlanner, ShoreIndex>()
function shoreIndex(planner: RoadPlanner) {
  let index = shorelineCaches.get(planner)
  if (index?.areas === planner.environment.areas) return index
  index = { areas: planner.environment.areas, seas: planner.environment.areas.filter(area => area.kind === 'water' && sea(area)), buckets: new Map() }
  for (const area of index.areas.filter(area => area.kind === 'water' && !sea(area))) for (const ring of [area.polygon, ...(area.holes ?? [])]) for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!, edge = { a, b, area }
    for (let x = Math.floor(Math.min(a.x, b.x) / 100); x <= Math.floor(Math.max(a.x, b.x) / 100); x++) for (let y = Math.floor(Math.min(a.y, b.y) / 100); y <= Math.floor(Math.max(a.y, b.y) / 100); y++) {
      const key = `${x}:${y}`, bucket = index.buckets.get(key) ?? []; bucket.push(edge); index.buckets.set(key, bucket)
    }
  }
  shorelineCaches.set(planner, index); return index
}
function nearestShore(index: ShoreIndex, point: Point) {
  let nearest: { point: Point; area: Area; distance: number } | undefined
  const tested = new Set<ShoreEdge>()
  for (let x = Math.floor((point.x - SHORE_REACH) / 100); x <= Math.floor((point.x + SHORE_REACH) / 100); x++) for (let y = Math.floor((point.y - SHORE_REACH) / 100); y <= Math.floor((point.y + SHORE_REACH) / 100); y++) for (const edge of index.buckets.get(`${x}:${y}`) ?? []) {
    if (tested.has(edge)) continue
    tested.add(edge)
    const p = projectOnRoadSegment(point, edge.a, edge.b).point, d = distance(point, p)
    if (d <= SHORE_REACH && (!nearest || d < nearest.distance)) nearest = { point: p, area: edge.area, distance: d }
  }
  return nearest
}

export interface BankConnectionSurvey {
  a: Point; b: Point; bankA: Point; bankB: Point; middle: Point
  waterSpan: number; chord: number; trips: number; waterId: string
}
interface BankInput {
  graph: PlanarRoadGraph; planner: RoadPlanner; cells: OccupiedSite[]; year: number; settlement: string
  cache: Map<string, PlannedRoute | null>
}
export interface BankConnectionProject { route: PlannedRoute; width: number; trips: number; minutesSaved: number; benefit: number; disconnected: boolean }

function existingCrossingNear(graph: PlanarRoadGraph, planner: RoadPlanner, survey: Pick<BankConnectionSurvey, 'middle' | 'bankA' | 'bankB' | 'waterId'>) {
  const dx = survey.bankB.x - survey.bankA.x, dy = survey.bankB.y - survey.bankA.y, length = distance(survey.bankA, survey.bankB)
  const water = planner.environment.areas.find(area => area.kind === 'water' && area.id === survey.waterId)
  if (!water) return false
  return graph.roads.some(road => (road.bridge || road.role === 'bridge') && road.points.length > 1 && !pointInRegion(road.points[0]!, water) && !pointInRegion(road.points.at(-1)!, water) && road.points.slice(1).some((b, i) => {
    const a = road.points[i]!, cosine = Math.abs((dx * (b.x - a.x) + dy * (b.y - a.y)) / (length * distance(a, b) || 1))
    if (cosine <= .5 || distanceToSegment(survey.middle, a, b) >= CROSSING_SEPARATION) return false
    // A nearby pond/canal deck is not a crossing of this river. Inspect its
    // real water footprint, including lake islands, rather than its colour/ID.
    const count = Math.max(1, Math.ceil(distance(a, b) / 4))
    for (let j = 0; j <= count; j++) if (pointInRegion(at(a, b, j / count), water)) return true
    return false
  }))
}

/** Survey actual occupied waterfront street pairs, not every pair of roads or
 * the globally cheapest narrow tributaries. Index cells/shore edges spatially;
 * merge nearby OD projections and physically inspect at most48 water corridors.
 */
export function surveyBankConnections(input: Omit<BankInput, 'cache'>): BankConnectionSurvey[] {
  const policy = bankBridgePolicy(input.year, input.settlement)
  if (!policy) return []
  const { graph, planner } = input, shores = shoreIndex(planner)
  if (!shores.buckets.size) return []
  const occupied = input.cells.filter(cell => cell.households > 0), nearby = occupiedSitesNear(occupied)
  const anchors: { point: Point; shore: NonNullable<ReturnType<typeof nearestShore>>; households: number }[] = []
  const anchorBins = new Map<string, typeof anchors>()
  // Sorting changes appraisal priority only; positions remain exact projections
  // onto existing streets. No regular grid positions a bridge or a road.
  for (const cell of [...occupied].sort((a, b) => b.households - a.households || a.point.x - b.point.x || a.point.y - b.point.y)) {
    const near = graph.nearest(cell.point, (cell.frontageDepth ?? 40) + 5)
    if (!near || near.road.bridge || (near.road.level ?? 0) !== 0 || planner.waterAt(near.point)) continue
    const shore = nearestShore(shores, near.point)
    if (!shore || shore.distance < 1) continue
    const gx = Math.floor(near.point.x / 65), gy = Math.floor(near.point.y / 65)
    let duplicate = false
    for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (const anchor of anchorBins.get(`${x}:${y}`) ?? []) {
      const sameBank = anchor.shore.area.id === shore.area.id && (anchor.point.x - anchor.shore.point.x) * (near.point.x - shore.point.x) + (anchor.point.y - anchor.shore.point.y) * (near.point.y - shore.point.y) > 0
      if (sameBank && distance(anchor.point, near.point) < 65) duplicate = true
    }
    if (duplicate) continue
    const households = nearby(near.point).reduce((sum, site) => sum + site.households * (1 - distance(site.point, near.point) / 150), 0)
    if (households < 20) continue
    const anchor = { point: near.point, shore, households }, key = `${gx}:${gy}`
    anchors.push(anchor)
    const bucket = anchorBins.get(key) ?? []; bucket.push(anchor); anchorBins.set(key, bucket)
  }
  // Find opposite-bank pairs before spending the physical survey budget. A
  // global first128 household ranking could discard every far-bank resident.
  // The unchanged48 corridor surveys below inspect at most96 distinct anchors.
  const reach = policy.maximumWaterSpan + SHORE_REACH * 2, bins = new Map<string, number[]>()
  for (const [i, anchor] of anchors.entries()) { const key = `${Math.floor(anchor.point.x / 250)}:${Math.floor(anchor.point.y / 250)}`, bucket = bins.get(key) ?? []; bucket.push(i); bins.set(key, bucket) }
  const pairs: { a: Point; b: Point; chord: number; trips: number; area: Area; middle: Point }[] = []
  for (const [i, first] of anchors.entries()) {
    const a = first.point, normalA = { x: a.x - first.shore.point.x, y: a.y - first.shore.point.y }
    for (let x = Math.floor((a.x - reach) / 250); x <= Math.floor((a.x + reach) / 250); x++) for (let y = Math.floor((a.y - reach) / 250); y <= Math.floor((a.y + reach) / 250); y++) for (const j of bins.get(`${x}:${y}`) ?? []) {
      if (j <= i) continue
      const last = anchors[j]!, b = last.point, chord = distance(a, b)
      if (chord < 35 || chord > reach || first.shore.area.id !== last.shore.area.id) continue
      const normalB = { x: b.x - last.shore.point.x, y: b.y - last.shore.point.y }
      if ((normalA.x * normalB.x + normalA.y * normalB.y) / (first.shore.distance * last.shore.distance) > -.25) continue
      const householdsA = nearby(a).filter(site => distance(site.point, a) < distance(site.point, b)).reduce((sum, site) => sum + site.households * (1 - distance(site.point, a) / 150), 0)
      const householdsB = nearby(b).filter(site => distance(site.point, b) <= distance(site.point, a)).reduce((sum, site) => sum + site.households * (1 - distance(site.point, b) / 150), 0)
      if (Math.min(householdsA, householdsB) < 20) continue
      pairs.push({ a, b, chord, trips: Math.min(4000, 2.4 * Math.sqrt(householdsA * householdsB)), area: first.shore.area, middle: at(a, b, .5) })
    }
  }
  pairs.sort((a, b) => b.trips / b.chord - a.trips / a.chord || a.middle.x - b.middle.x || a.middle.y - b.middle.y)
  const sampled: Point[] = [], result: BankConnectionSurvey[] = []
  for (const pair of pairs) {
    if (sampled.some(point => distance(point, pair.middle) < 140)) continue
    sampled.push(pair.middle)
    const count = Math.max(1, Math.ceil(pair.chord / 4)), wet = Array.from({ length: count + 1 }, (_, i) => planner.waterAt(at(pair.a, pair.b, i / count)))
    let firstWet = -1, lastWet = -1, runs = 0
    for (let i = 0; i < wet.length; i++) if (wet[i]) { if (!i || !wet[i - 1]) runs++; if (firstWet < 0) firstWet = i; lastWet = i }
    if (runs === 1 && firstWet > 0 && lastWet < count) {
      const boundary = (low: number, high: number, lowWater: boolean) => { for (let i = 0; i < 10; i++) { const middle = (low + high) / 2; if (planner.waterAt(at(pair.a, pair.b, middle)) === lowWater) low = middle; else high = middle } return (low + high) / 2 }
      const start = boundary((firstWet - 1) / count, firstWet / count, false), end = boundary(lastWet / count, (lastWet + 1) / count, true), waterSpan = (end - start) * pair.chord
      const bankA = at(pair.a, pair.b, Math.max(0, start - 25 / pair.chord)), bankB = at(pair.a, pair.b, Math.min(1, end + 25 / pair.chord)), middle = at(bankA, bankB, .5)
      const dryWidth = (point: Point) => [-1, 0, 1].every(side => !planner.waterAt({ x: point.x - (pair.b.y - pair.a.y) / pair.chord * policy.width / 2 * side, y: point.y + (pair.b.x - pair.a.x) / pair.chord * policy.width / 2 * side }))
      const crossesSea = Array.from({ length: count + 1 }, (_, i) => at(pair.a, pair.b, i / count)).some(p => planner.environment.terrain?.seaAt?.(p) || shores.seas.some(area => pointInRegion(p, area)))
      if (waterSpan >= 4 && waterSpan <= policy.maximumWaterSpan && dryWidth(bankA) && dryWidth(bankB) && !crossesSea && planner.suitable(bankA, policy.width) && planner.suitable(bankB, policy.width) && planner.validate([bankA, bankB], policy.width, true) && !existingCrossingNear(graph, planner, { middle, bankA, bankB, waterId: pair.area.id })) {
        const survey = { ...pair, bankA, bankB, middle, waterSpan, waterId: pair.area.id }
        if (result.every(other => distance(other.middle, middle) >= CROSSING_SEPARATION)) result.push(survey)
      }
    }
    if (sampled.length >= MAX_WATER_SURVEYS) break
  }
  return result.sort((a, b) => b.trips / (b.waterSpan * 13 + b.chord * 1.35 + 420) - a.trips / (a.waterSpan * 13 + a.chord * 1.35 + 420))
}

/** Missing connectivity has a finite15-minute scenario penalty. Existing
 * detours are capped at30 minutes for appraisal; neither Infinity nor speculative
 * new households can create unlimited benefit or construction funds.
 */
function appraisalTime(oldTime: number) { return Number.isFinite(oldTime) ? Math.min(30, oldTime) : 15 }
function planConnection(input: BankInput, survey: BankConnectionSurvey, width: number): PlannedRoute | null {
  const { planner, graph } = input, { a, b, bankA, bankB } = survey
  const startHeading = graph.junctionHeading(a, bankA), departure = graph.junctionHeading(b, bankB)
  if (startHeading === null || departure === null) return null
  const heading = Math.atan2(bankB.y - bankA.y, bankB.x - bankA.x), endHeading = departure + Math.PI
  const key = `bank:${planner.transportRevision}:${width}:${[a, b, bankA, bankB].map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(':')}:${startHeading.toFixed(3)}:${endHeading.toFixed(3)}`
  if (input.cache.has(key)) return input.cache.get(key)!
  const leg = (from: Point, to: Point, startHeading: number, endHeading: number): PlannedRoute | null => {
    if (distance(from, to) < .01) return { points: [from], length: 0, cost: 0, bridgeLength: 0, method: 'direct' }
    if (distance(from, to) < 16) {
      const angle = Math.atan2(to.y - from.y, to.x - from.x), compatible = (heading: number) => Math.abs(Math.atan2(Math.sin(angle - heading), Math.cos(angle - heading))) < .06
      return compatible(startHeading) && compatible(endHeading) && planner.validate([from, to], width) ? planner.cost([from, to], 'collector') : null
    }
    return planner.plan(from, to, { role: 'collector', width, startHeading, endHeading, maximumGrade: .08, allowBridge: false, maxNodes: 4000 })
  }
  const first = leg(a, bankA, startHeading, heading), last = first && leg(bankB, b, heading, endHeading)
  let route: PlannedRoute | null = null
  if (first && last) {
    const candidate = planner.cost([...first.points, bankB, ...last.points.slice(1)], 'collector', true)
    candidate.method = 'bridge-project'; candidate.surveyedBridgeSpans = [{ bankA, bankB }]
    if (candidate.length <= survey.chord * 2 + 100 && candidate.length <= 1400 && planner.validate(candidate.points, width, true) && planner.railwayAllows(candidate.points, 'collector') && !graph.hasAcuteMajorCrossing(candidate.points) && (!planner.environment.terrain || surveyedRoadGradeAllowed(candidate, .08, planner.environment.terrain.elevation))) route = candidate
  }
  if (input.cache.size >= 512) input.cache.delete(input.cache.keys().next().value!)
  input.cache.set(key, route); return route
}

export function* bankConnectionProjects(input: BankInput & { availableFunds: () => number }): Generator<BankConnectionProject> {
  const policy = bankBridgePolicy(input.year, input.settlement)
  if (!policy || input.availableFunds() <= 420) return
  const nearby = occupiedSitesNear(input.cells.filter(cell => cell.households > 0)), impedance = input.year < 1950 ? 1.5 : 1, valueOfMinutes = 250 * 8 * .02 / 60
  let planned = 0
  for (const survey of surveyBankConnections(input)) {
    const lowerCost = survey.waterSpan * 13 + Math.max(0, survey.chord - survey.waterSpan) * roadConstructionFactor('collector') + 420
    const oldTime = input.graph.travelTime(survey.a, survey.b), baseline = appraisalTime(oldTime)
    if (existingCrossingNear(input.graph, input.planner, survey) || lowerCost > input.availableFunds() || (baseline - survey.chord / roadTravelSpeed({ role: 'collector' })) * impedance * survey.trips * valueOfMinutes <= lowerCost) continue
    if (planned++ >= MAX_ROUTE_SURVEYS) break
    const route = planConnection(input, survey, policy.width)
    if (!route || route.bridgeLength < 4 || route.bridgeLength > policy.maximumWaterSpan || !Number.isFinite(route.cost) || !input.planner.railwayAllows(route.points, 'collector')) continue
    const affected = new Set<OccupiedSite>()
    for (let i = 1; i < route.points.length; i++) for (const site of nearby(route.points[i]!)) if (distanceToSegment(site.point, route.points[i - 1]!, route.points[i]!) < 35) affected.add(site)
    const acquisition = [...affected].reduce((sum, site) => sum + site.households * Math.min(1, route.length * policy.width / (site.area ?? 9500)) * 24, 0)
    const cost = route.cost + acquisition, minutesSaved = Math.max(0, baseline - route.length / roadTravelSpeed({ role: 'collector' })) * impedance, benefit = minutesSaved * survey.trips * valueOfMinutes
    if (cost > input.availableFunds() || !(cost > 0) || !Number.isFinite(benefit) || benefit <= cost) continue
    yield { route: { ...route, cost }, width: policy.width, trips: survey.trips, minutesSaved, benefit, disconnected: !Number.isFinite(oldTime) }
  }
}

/** Ten-year resident-funded programme, including stable/declining populations.
 * The caller's normal atomic transaction owns both approaches and the deck.
 */
export function investInBankConnections(input: BankInput & { funds: number; commit: (project: BankConnectionProject) => boolean }) {
  let spent = 0, completed = 0
  if (input.year % 10 !== 0 || !bankBridgePolicy(input.year, input.settlement)) return { spent, completed }
  for (const project of bankConnectionProjects({ ...input, availableFunds: () => input.funds - spent })) {
    if (!input.commit(project)) continue
    spent += project.route.cost; completed++
  }
  return { spent, completed }
}
