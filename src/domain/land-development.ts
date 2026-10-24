import type { Building, BuildingState, CityConfig, GrowthEvent, Parcel, Point, Road, SimulationSnapshot, Station, TimelineVersion } from './types'
import { buildingGeometry } from './timeline'
import { boundsOf, distance, overlaps, pointInPolygon, polygonArea, polygonsOverlap, projectPoint, seededRandom } from './geometry'
import type { Bounds } from './geometry'
import { scenarioDemandAtYear } from './urban-growth'
import type { DemographicScenario } from './urban-growth'
import { controlledRoad, roadLevelAt, roadTravelSpeed } from './road-graph'
import { createUrbanZoning } from './urban-zoning'
import { developmentClimbMinutes, surveyDevelopmentSite } from './development-terrain'
import type { DevelopmentSiteSurvey } from './development-terrain'
import { surveyResidentialEstate } from './residential-estate'
import { rearPrivateAccess } from './rear-private-access'
import { isConstructionYear, simulationEndYear, simulationYears } from './simulation-calendar'

export const GENERATOR_VERSION = '2.5.0'
export { EPOCH_YEAR } from './simulation-calendar'

interface Candidate {
  parcel: Parcel; footprint: Point[]; frontage: Point; road: Road; segment: number
  area: number; reluctance: number; capacity: number; formation: DevelopmentSiteSurvey; form: 'house' | 'apartment' | 'retail' | 'workshop'; building?: Building
  availableYear?: number; infillParent?: Candidate
  /** A road-fronting option is not an acquired residential title. */
  acquiredYear?: number
}
interface DevelopmentInput {
  config: CityConfig; roads: Road[]; center: Point; stations: Station[]
  roadHistory?: TimelineVersion<Road>[]
  /** A surveyed bath/spring centre; onsen scenarios otherwise use their historic nucleus. */
  thermalCenter?: Point
  centers?: { point: Point; activeYear: number; catchment: number; weight: number; kind?: string }[]
  /** Tests the complete land polygon against physical obstacles present in this year. */
  canPlace(polygon: Point[], year: number): boolean
  slope(point: Point): number
  elevation?: (point: Point) => number
}

function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  const half = (list: Point[]) => { const hull: Point[] = []; for (const point of list) { while (hull.length > 1 && cross(hull.at(-2)!, hull.at(-1)!, point) <= 0) hull.pop(); hull.push(point) } return hull.slice(0, -1) }
  return [...half(sorted), ...half(sorted.reverse())]
}

/** Fictional visitor-room demand, separate from residents and housing capacity.
 * Small inns precede post-war hotel investment; this is not a tourism forecast. */
function lodgingDemand(config: CityConfig, year: number): number {
  if (config.density <= 0) return 0
  const scale = config.settlement === 'village' ? .18 : config.settlement === 'rural-town' ? .55 : config.settlement === 'metropolis' ? 1.4 : 1
  const stage = year < 1800 ? .10 + (year - 1700) / 100 * .08 : year < 1900 ? .18 + (year - 1800) / 100 * .12 : year < 1955 ? .30 + (year - 1900) / 55 * .15 : .45 + Math.min(1, (year - 1955) / 35) * .55
  const decline = config.populationTrend === 'declining' && year > 1990 ? 1 - (year - 1990) / 35 * .25 : 1
  return Math.max(0, Math.round((180 + config.density * 5.5) * scale * stage * decline))
}

// Spatial buckets keep full polygon tests local; no center-only collision test.
function index<T extends { bounds: Bounds }>() {
  const cells = new Map<string, T[]>()
  const keys = function* (b: Bounds) { for (let x = Math.floor(b.minX / 60); x <= Math.floor(b.maxX / 60); x++) for (let y = Math.floor(b.minY / 60); y <= Math.floor(b.maxY / 60); y++) yield `${x}:${y}` }
  return {
    add(item: T) { for (const key of keys(item.bounds)) { const list = cells.get(key) ?? []; list.push(item); cells.set(key, list) } },
    query(bounds: Bounds) { const found = new Set<T>(); for (const key of keys(bounds)) for (const item of cells.get(key) ?? []) if (overlaps(bounds, item.bounds)) found.add(item); return [...found] },
  }
}

/** Shared-point road graph. Curve samples are degree-two vertices, not intersections. */
function accessibility(roads: Road[], destinations: Point[]) {
  const activeById = new Map(roads.map(road => [road.id, road]))
  const ids = new Map<string, number[]>(), points: Point[] = [], edges: { to: number; cost: number }[][] = []
  const node = (p: Point, road: Road) => {
    const x = Math.floor(p.x * 5), y = Math.floor(p.y * 5)
    const level = roadLevelAt(road, p)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const id of ids.get(`${level}:${x + dx}:${y + dy}`) ?? []) if (distance(points[id]!, p) < .15) return id
    const key = `${level}:${x}:${y}`, id = points.length, list = ids.get(key) ?? []
    list.push(id); ids.set(key, list); points.push(p); edges.push([])
    return id
  }
  const roadNodes = new Map<string, number[]>()
  for (const road of roads) {
    const nodes = road.points.map(point => node(point, road)); roadNodes.set(road.id, nodes)
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1]!, b = nodes[i]!, cost = distance(points[a]!, points[b]!) / roadTravelSpeed(road)
      edges[a]!.push({ to: b, cost }); edges[b]!.push({ to: a, cost })
    }
  }
  const times = new Float64Array(points.length).fill(Infinity)
  const sources: { roadId: string; segment: number; point: Point; walking: number }[] = []
  // Binary min-heap; the value is travel time in minutes, using relative speeds.
  const heap: { node: number; cost: number }[] = []
  const push = (item: { node: number; cost: number }) => { let i = heap.length; heap.push(item); while (i > 0) { const p = (i - 1) >> 1; if (heap[p]!.cost <= item.cost) break; heap[i] = heap[p]!; i = p } heap[i] = item }
  const pop = () => { const first = heap[0]!, last = heap.pop()!; if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let child = i * 2 + 1; if (child + 1 < heap.length && heap[child + 1]!.cost < heap[child]!.cost) child++; if (last.cost <= heap[child]!.cost) break; heap[i] = heap[child]!; i = child } heap[i] = last } return first }
  for (const destination of destinations) {
    let nearest: { road: Road; segment: number; point: Point; d: number } | null = null
    for (const road of roads.filter(road => !controlledRoad(road))) for (let i = 1; i < road.points.length; i++) {
      const p = projectPoint(destination, road.points[i - 1]!, road.points[i]!), d = distance(destination, p)
      if (!nearest || d < nearest.d) nearest = { road, segment: i, point: p, d }
    }
    if (nearest) {
      sources.push({ roadId: nearest.road.id, segment: nearest.segment, point: nearest.point, walking: nearest.d / 75 })
      const ids = roadNodes.get(nearest.road.id)!
      for (const i of [nearest.segment - 1, nearest.segment]) {
        const cost = nearest.d / 75 + distance(nearest.point, nearest.road.points[i]!) / roadTravelSpeed(nearest.road), id = ids[i]!
        if (cost < times[id]!) { times[id] = cost; push({ node: id, cost }) }
      }
    }
  }
  while (heap.length) {
    const item = pop(); if (item.cost !== times[item.node]) continue
    for (const edge of edges[item.node]!) if (item.cost + edge.cost < times[edge.to]!) { times[edge.to] = item.cost + edge.cost; push({ node: edge.to, cost: times[edge.to]! }) }
  }
  const values = new WeakMap<Candidate, number>()
  return (candidate: Candidate) => {
    const cached = values.get(candidate)
    if (cached !== undefined) return cached
    const nodes = roadNodes.get(candidate.road.id)
    if (!nodes) return Infinity
    const road = activeById.get(candidate.road.id)!
    let segment = 1, nearest = Infinity
    for (let i = 1; i < road.points.length; i++) { const d = distance(candidate.frontage, projectPoint(candidate.frontage, road.points[i - 1]!, road.points[i]!)); if (d < nearest) { nearest = d; segment = i } }
    const a = segment - 1, b = segment
    let direct = Infinity
    const speed = roadTravelSpeed(road)
    for (const source of sources) if (source.roadId === road.id && source.segment === segment) direct = Math.min(direct, source.walking + distance(source.point, candidate.frontage) / speed)
    const value = Math.min(direct, times[nodes[a]!]! + distance(candidate.frontage, road.points[a]!) / speed, times[nodes[b]!]! + distance(candidate.frontage, road.points[b]!) / speed)
    values.set(candidate, value)
    return value
  }
}

/**
 * Parcels precede buildings. Fixed frontages survive later periods; development consumes
 * housing demand in five-year steps. These are explicit scenario assumptions, not a
 * calibrated demographic forecast. No global tessellation or pixel-density stamping.
 */
export function developLand(input: DevelopmentInput) {
  const { config, center, canPlace, slope, stations } = input
  const scenario: DemographicScenario = config, settlement = scenario.settlement ?? 'regional-city'
  const terrain = { slope, elevation: input.elevation }
  const survey = (footprint: Point[]) => surveyDevelopmentSite(terrain, footprint.reduce((sum, p) => ({ x: sum.x + p.x / footprint.length, y: sum.y + p.y / footprint.length }), { x: 0, y: 0 }), footprint)
  const thermalCenter = input.thermalCenter ?? (config.type === 'onsen' ? center : undefined)
  const zoning = createUrbanZoning({ roads: input.roads, stations, center, thermalCenter, centers: input.centers, metropolitan: settlement === 'metropolis', terrain })
  const industry = input.centers?.find(c => c.kind === 'industrial')
  const end = simulationEndYear(config), candidates: Candidate[] = [], events: GrowthEvent[] = [], snapshots: SimulationSnapshot[] = []
  const history = { buildings: [] as TimelineVersion<Building>[], parcels: [] as TimelineVersion<Parcel>[], buildingStates: [] as BuildingState[] }
  const liveBuildings = new Map<string, TimelineVersion<Building>>(), liveParcels = new Map<string, TimelineVersion<Parcel>>()
  const occupancyStates = new Map<string, BuildingState>()
  const inheritedGardens = new Map<Candidate, Candidate[]>()
  const acquireTitle = (candidate: Candidate, year: number) => {
    if (candidate.acquiredYear !== undefined) return
    candidate.acquiredYear = year
    candidate.parcel.createdYear = year
    events.push({ id: `title-acquisition-${candidate.parcel.id}`, year, kind: 'acquisition', entityId: candidate.parcel.id, reason: '接道する用地を需要に応じて取得し宅地を成立' })
    // The separately surveyed garden belongs to an actual old street holding,
    // not to every possible frontage along an otherwise rural through road.
    for (const garden of inheritedGardens.get(candidate) ?? []) {
      garden.acquiredYear = year; garden.parcel.createdYear = year
      events.push({ id: `title-acquisition-${garden.parcel.id}`, year, kind: 'acquisition', entityId: garden.parcel.id, reason: '旧街道の世帯敷地と一体の裏庭持分を取得' })
    }
  }
  function recordStock(year: number, stock: Candidate[]) {
    const existing = new Set(stock.map(c => c.building!.id))
    for (const [id, version] of liveBuildings) if (!existing.has(id)) { version.to = year; liveBuildings.delete(id); occupancyStates.delete(id) }
    for (const c of stock) {
      const building = c.building!
      if (!liveBuildings.has(building.id)) {
        const version = { from: year, value: buildingGeometry(building) }
        history.buildings.push(version); liveBuildings.set(building.id, version)
      }
      const previous = occupancyStates.get(building.id)
      if (!previous || previous.occupancy !== building.occupancy || previous.occupiedHouseholds !== building.occupiedHouseholds) {
        const state = { id: building.id, from: year, occupancy: building.occupancy, occupiedHouseholds: building.occupiedHouseholds }
        history.buildingStates.push(state); occupancyStates.set(building.id, state)
      }
    }
    for (const c of candidates) {
      if (c.acquiredYear === undefined) continue
      const parcel = c.parcel
      if (parcel.createdYear > year) continue
      const previous = liveParcels.get(parcel.id)
      if (parcel.retiredYear !== undefined && parcel.retiredYear <= year) {
        if (previous) { previous.to = year; liveParcels.delete(parcel.id) }
        continue
      }
      if (previous && previous.value.use === parcel.use && previous.value.developedYear === parcel.developedYear) continue
      if (previous) previous.to = year
      const version = { from: year, value: { ...parcel } }
      history.parcels.push(version); liveParcels.set(parcel.id, version)
    }
  }
  const lots = index<{ polygon: Point[]; bounds: Bounds }>()
  const earliestRoads = new Map<string, Road>()
  for (const version of [...(input.roadHistory ?? [])].sort((a, b) => a.from - b.from)) if (!earliestRoads.has(version.value.id)) earliestRoads.set(version.value.id, version.value)
  for (const road of input.roads) if (!earliestRoads.has(road.id)) earliestRoads.set(road.id, road)
  const roads = [...earliestRoads.values()].filter(road => (road.builtYear ?? 1700) <= end).sort((a, b) => (a.builtYear ?? 1700) - (b.builtYear ?? 1700) || a.id.localeCompare(b.id))
  for (const road of roads) {
    if (road.bridge || road.role === 'bridge' || controlledRoad(road)) continue
    const year = road.builtYear ?? 1700, random = seededRandom(`${config.seed}:parcels:${road.id}`)
    const old = year < 1900
    let remaining = 12 + random() * 8, serial = 0
    for (let segment = 1; segment < road.points.length; segment++) {
      const a = road.points[segment - 1]!, b = road.points[segment]!, length = distance(a, b)
      if (length < .001) continue
      const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length
      while (remaining < length) {
        const frontage = { x: a.x + ux * remaining, y: a.y + uy * remaining }
        const zone = zoning(frontage, year)
        const industrial = road.role !== 'farm' && (road.id.startsWith('industrial') || zone.industrialShare > .5 && random() < zone.industrialShare || (config.type === 'port' && industry && industry.activeYear <= year && distance(frontage, industry.point) < industry.catchment * .75))
        // Large modern plots belong to station/estate development, rather than
        // stretching every detached house to the same size along every street.
        const stationDistance = year >= 1900 && stations.length ? Math.min(...stations.map(s => distance(frontage, s.point))) : Infinity
        const estate = (settlement === 'regional-city' || settlement === 'metropolis') && config.type === 'newtown' && year >= 1955 && (stationDistance < 850 || distance(frontage, center) < 600)
        const districtApartment = settlement !== 'village' && year >= 1955 && random() < zone.apartmentShare
        const form: Candidate['form'] = industrial ? 'workshop' : districtApartment || (estate && random() < .24) ? 'apartment' : year >= 1955 && (road.role === 'collector' || road.role === 'highway') && random() < zone.retailShare * .4 ? 'retail' : 'house'
        const width = industrial ? 32 + random() * 24 : form === 'apartment' ? 28 + random() * 16 : form === 'retail' ? 25 + random() * 23 : old ? 9 + random() * 10 : 10 + random() * 9
        for (const side of [-1, 1]) {
          const lotRandom = seededRandom(`${config.seed}:parcel:${road.id}:${serial}:${side}`)
          const depth = industrial ? 34 + lotRandom() * 24 : form === 'apartment' || form === 'retail' ? 30 + lotRandom() * 15 : old ? 26 + lotRandom() * 13 : 23 + lotRandom() * 11
          const setback = road.width / 2 + 2.6
          const transform = (x: number, y: number): Point => ({ x: Math.round((frontage.x + x * ux - (setback + y) * uy * side) * 10) / 10, y: Math.round((frontage.y + x * uy + (setback + y) * ux * side) * 10) / 10 })
          let polygon = [transform(-width / 2 + .4, 0), transform(width / 2 - .4, 0), transform(width / 2 - .4, depth), transform(-width / 2 + .4, depth)]
          let rear: { polygon: Point[]; footprint: Point[]; entrance: Point; access: Point[] } | undefined
          let inheritedRear = false
          // A rear subdivision is a flag-shaped property with its own 2.8m
          // connection to the public road. It is considered only when the whole
          // stem and rear garden fit; never stamp an inaccessible second row.
          if (year >= 1955 && form === 'house' && width >= 17.5 && lotRandom() < .32) {
            const stemLeft = width / 2 - 3.2, backDepth = 21 + lotRandom() * 7
            const front = [transform(-width / 2 + .4, 0), transform(stemLeft - .4, 0), transform(stemLeft - .4, depth), transform(-width / 2 + .4, depth)]
            const back = [transform(stemLeft, 0), transform(width / 2 - .4, 0), transform(width / 2 - .4, depth + backDepth), transform(-width / 2 + .4, depth + backDepth), transform(-width / 2 + .4, depth + 1), transform(stemLeft, depth + 1)]
            const backBounds = boundsOf(back)
            if (canPlace(front, year) && canPlace(back, year) && slope(transform(0, depth + backDepth / 2)) <= .18 && !lots.query(backBounds).some(lot => polygonsOverlap(lot.polygon, back))) {
              polygon = front
              const footprint = [transform(-width * .32, depth + 4), transform(width * .32, depth + 4), transform(width * .32, depth + 17), transform(-width * .32, depth + 17)]
              rear = { polygon: back, footprint, entrance: transform(width / 2 - 1.8, 0), access: rearPrivateAccess(transform(width / 2 - 1.8, -setback), transform(width / 2 - 1.8, depth + 3), transform(width * .28, depth + 3), footprint, back) }
            }
          }
          // Some old street family holdings include a separately titled rear
          // garden. Survey both shares now, including space beside the first
          // house; a later owner may buy the garden for infill without moving
          // that house or taking a neighbour's land. The same survey runs for
          // historic views, so future demand cannot rewrite the old titles.
          const gardenRandom = seededRandom(`${config.seed}:inherited-garden:${road.id}:${serial}:${side}`)
          if (old && form === 'house' && road.role !== 'farm' && width >= 17.5 && gardenRandom() < .35) {
            const stemLeft = width / 2 - 3.2, backDepth = 24 + gardenRandom() * 8
            const full = [transform(-width / 2 + .4, 0), transform(width / 2 - .4, 0), transform(width / 2 - .4, depth + backDepth), transform(-width / 2 + .4, depth + backDepth)]
            const front = [transform(-width / 2 + .4, 0), transform(stemLeft - .4, 0), transform(stemLeft - .4, depth), transform(-width / 2 + .4, depth)]
            const back = [transform(stemLeft, 0), transform(width / 2 - .4, 0), transform(width / 2 - .4, depth + backDepth), transform(-width / 2 + .4, depth + backDepth), transform(-width / 2 + .4, depth + 1), transform(stemLeft, depth + 1)]
            const footprint = [transform(-width * .32, depth + 4), transform(width * .32, depth + 4), transform(width * .32, depth + 18), transform(-width * .32, depth + 18)]
            if (canPlace(full, year) && full.every(point => slope(point) <= .18) && survey(footprint).viable && !lots.query(boundsOf(full)).some(lot => polygonsOverlap(lot.polygon, full))) {
              polygon = front; inheritedRear = true
              rear = { polygon: back, footprint, entrance: transform(width / 2 - 1.8, 0), access: rearPrivateAccess(transform(width / 2 - 1.8, -setback), transform(width / 2 - 1.8, depth + 3), transform(width * .28, depth + 3), footprint, back) }
            }
          }
          const bounds = boundsOf(polygon)
          if (!canPlace(polygon, year) || slope(transform(0, depth / 2)) > .22 || lots.query(bounds).some(lot => polygonsOverlap(lot.polygon, polygon))) continue
          const id = `parcel-${road.id}-${serial}-${side}`
          const hasSideAccess = rear
          const reluctant = lotRandom(), buildingWidth = (width - (hasSideAccess ? 3.6 : 0)) * (industrial ? .8 : form === 'apartment' || form === 'retail' ? .86 : old ? .80 : .67), buildingDepth = depth * (industrial ? .8 : form === 'apartment' ? .43 : form === 'retail' ? .76 : old ? .56 : .46)
          const garden = old ? 1.2 : form === 'retail' ? 2 : 4 + lotRandom() * 3
          const cutCorner = form === 'house' && lotRandom() < .35
          const house = (x: number, y: number) => transform(x - (hasSideAccess ? 1.8 : 0), y)
          const footprint = cutCorner ? [house(-buildingWidth / 2, garden), house(buildingWidth / 2, garden), house(buildingWidth / 2, garden + buildingDepth * .63), house(buildingWidth * .18, garden + buildingDepth * .63), house(buildingWidth * .18, garden + buildingDepth), house(-buildingWidth / 2, garden + buildingDepth)] : [house(-buildingWidth / 2, garden), house(buildingWidth / 2, garden), house(buildingWidth / 2, garden + buildingDepth), house(-buildingWidth / 2, garden + buildingDepth)]
          const formation = survey(footprint)
          if (!formation.viable) continue
          const parcel: Parcel = { id, polygon, entrance: transform(0, 0), roadId: road.id, createdYear: year, use: industrial ? 'industrial' : 'residential' }
          const candidate: Candidate = { parcel, footprint, frontage, road, segment, area: width * depth, reluctance: reluctant, capacity: 1, formation, form }
          candidates.push(candidate)
          lots.add({ polygon, bounds })
          if (rear) {
            const rearFormation = survey(rear.footprint)
            if (!rearFormation.viable) continue
            const rearParcel: Parcel = { id: `${id}-rear`, polygon: rear.polygon, entrance: rear.entrance, access: rear.access, roadId: road.id, createdYear: year, use: 'residential' }
            const rearFrontage = transform(width / 2 - 1.8, -setback)
            const rearCandidate: Candidate = { parcel: rearParcel, footprint: rear.footprint, frontage: rearFrontage, road, segment, area: width * 24 + depth * 2.8, reluctance: lotRandom(), capacity: 1, formation: rearFormation, form: 'house', ...(inheritedRear ? { availableYear: 1955, infillParent: candidate } : {}) }
            candidates.push(rearCandidate)
            if (inheritedRear) inheritedGardens.set(candidate, [rearCandidate])
            lots.add({ polygon: rear.polygon, bounds: boundsOf(rear.polygon) })
          }
        }
        remaining += width + 1.2; serial++
      }
      remaining -= length
    }
  }
  let capacity = 0, industrialJobs = 0
  let lodgingSerial = 0, lastHotelYear = -Infinity
  const built: Candidate[] = []
  const optionIndex = index<{ candidate: Candidate; bounds: Bounds }>()
  for (const candidate of candidates) optionIndex.add({ candidate, bounds: boundsOf(candidate.parcel.polygon) })
  const modernHolding = (candidate: Candidate, year: number, zone: ReturnType<typeof zoning>, affordable: (formation: DevelopmentSiteSurvey) => boolean) => {
    if (candidate.acquiredYear !== undefined || candidate.parcel.access || candidate.infillParent) return null
    const a = candidate.road.points[candidate.segment - 1]!, b = candidate.road.points[candidate.segment]!, length = distance(a, b)
    if (length < 1) return null
    const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length, p = candidate.frontage
    const normal = (lot: Candidate) => lot.parcel.polygon.reduce((sum, point) => sum + (point.x - p.x) * -uy + (point.y - p.y) * ux, 0) / lot.parcel.polygon.length
    const nearby = [...new Set(optionIndex.query({ minX: p.x - 95, maxX: p.x + 95, minY: p.y - 95, maxY: p.y + 95 }).map(record => record.candidate))]
      .filter(lot => !lot.parcel.retiredYear && lot.acquiredYear === undefined && lot.parcel.createdYear <= year && !lot.parcel.access && !lot.infillParent && lot.road.id === candidate.road.id && normal(lot) * normal(candidate) > 0 && Math.abs((lot.frontage.x - p.x) * -uy + (lot.frontage.y - p.y) * ux) < 9)
      .sort((left, right) => (left.frontage.x - right.frontage.x) * ux + (left.frontage.y - right.frontage.y) * uy)
    const anchor = nearby.indexOf(candidate)
    if (anchor < 0) return null
    const stationDistance = stations.length ? Math.min(...stations.map(station => distance(p, station.point))) : Infinity
    const deepEligible = year >= 1955 && settlement !== 'village' && settlement !== 'rural-town' && (
      (config.type === 'newtown' || settlement === 'metropolis') && (zone.kind === 'residential-mid' || zone.kind === 'station-centre') ||
      settlement === 'regional-city' && zone.kind === 'station-centre' && stationDistance <= 450
    )
    for (const count of [4, 3, 2]) {
      const members = nearby.slice(Math.max(0, anchor - 1), Math.max(0, anchor - 1) + count)
      if (members.length !== count || !members.includes(candidate) || members.some((lot, i) => i > 0 && distance(lot.frontage, members[i - 1]!.frontage) > (deepEligible ? 60 : 34))) continue
      const polygon = convexHull(members.flatMap(lot => lot.parcel.polygon)), area = polygonArea(polygon)
      const included = new Set(members.flatMap(lot => [lot, ...inheritedGardens.get(lot) ?? []]))
      if (area < 400) continue
      if (deepEligible) {
        const estate = surveyResidentialEstate({ frontage: p, along: { x: ux, y: uy }, roadWidth: candidate.road.width, frontTitles: members.map(lot => lot.parcel.polygon), terrain,
          canPlace: polygon => canPlace(polygon, year), affordable,
          occupied: polygon => optionIndex.query(boundsOf(polygon)).some(({ candidate: other }) => other.acquiredYear !== undefined && (!other.parcel.retiredYear || other.parcel.retiredYear > year) && polygonsOverlap(polygon, other.parcel.polygon)),
        })
        if (estate) {
          const consumed = new Set(optionIndex.query(boundsOf(estate.polygon)).map(record => record.candidate).filter(other => !other.parcel.retiredYear && polygonsOverlap(estate.polygon, other.parcel.polygon)))
          for (const member of included) consumed.add(member)
          return { ...estate, members: [...consumed], deep: true }
        }
      }
      if (area < 850 || area > (settlement === 'metropolis' ? 3600 : 2500) || !canPlace(polygon, year) || polygon.some(point => slope(point) > .12)) continue
      if (optionIndex.query(boundsOf(polygon)).some(({ candidate: other }) => !other.parcel.retiredYear && !included.has(other) && polygonsOverlap(polygon, other.parcel.polygon))) continue
      const centroid = polygon.reduce((sum, point) => ({ x: sum.x + point.x / polygon.length, y: sum.y + point.y / polygon.length }), { x: 0, y: 0 })
      const footprint = polygon.map(point => ({ x: Math.round((centroid.x + (point.x - centroid.x) * .82) * 10) / 10, y: Math.round((centroid.y + (point.y - centroid.y) * .82) * 10) / 10 }))
      const formation = survey(footprint)
      if (!formation.viable || formation.maximumFloors < 3 || !canPlace(footprint, year) || !affordable(formation)) continue
      return { polygon, footprint, formation, area, members: [...included], deep: false, access: undefined, entrance: candidate.parcel.entrance }
    }
    return null
  }
  const versionedIds = new Set(input.roadHistory?.map(version => version.value.id))
  for (const year of simulationYears(end)) {
    const constructionYear = isConstructionYear(year)
    const activeRoads = input.roadHistory ? [...input.roadHistory.filter(version => version.from <= year && (version.to === undefined || year < version.to)).map(version => version.value), ...roads.filter(road => !versionedIds.has(road.id) && (road.builtYear ?? 1700) <= year)] : roads.filter(r => (r.builtYear ?? 1700) <= year)
    const activeStations = year >= 1900 ? stations : []
    const destinations = input.centers?.filter(c => c.activeYear <= year).map(c => c.point) ?? [center]
    const travel = accessibility(activeRoads, [...destinations, ...activeStations.map(s => s.point)])
    const { households, jobs } = scenarioDemandAtYear(config, year)
    if (thermalCenter && constructionYear) {
      const target = lodgingDemand(config, year)
      let rooms = built.reduce((sum, c) => sum + (c.building?.guestRooms ?? 0), 0)
      const eligible = candidates.filter(c => !c.parcel.retiredYear && !c.parcel.access && c.parcel.createdYear <= year && c.parcel.use !== 'industrial' && c.road.role !== 'farm' && c.building?.use !== 'lodging' && distance(c.frontage, thermalCenter) < 750 && travel(c) < 12 && slope(c.frontage) < .12)
      const ranked = eligible.map(c => ({ c, score: Math.exp(-distance(c.frontage, thermalCenter) / 320 - developmentClimbMinutes(c.frontage, thermalCenter, input.elevation, year) / 7) * c.formation.suitability - c.reluctance * .16 - c.formation.formationCostPerHousehold / 36 })).filter(candidate => candidate.score > 0).sort((a, b) => b.score - a.score || a.c.parcel.id.localeCompare(b.c.parcel.id))
      const retireBuilding = (c: Candidate, reason: string) => {
        if (!c.building) return
        capacity -= c.capacity
        events.push({ id: `lodging-acquisition-${year}-${c.parcel.id}`, year, kind: 'acquisition', entityId: c.building.id, reason })
        built.splice(built.indexOf(c), 1); c.building = undefined; c.capacity = 0
      }
      const open = (c: Candidate, footprint: Point[], height: number, kind: 'ryokan' | 'hotel', formation: DevelopmentSiteSurvey) => {
        // Gross floor area per guest room includes corridors, baths and dining.
        // It is a scenario assumption, never counted as resident households.
        const guestRooms = Math.max(5, Math.floor(polygonArea(footprint) * height / (kind === 'hotel' ? 48 : 42)))
        retireBuilding(c, '温泉街の宿泊需要に伴う沿道敷地の取得・建替え')
        const stem = ['松風', '川音', '山水', '若葉', '紅葉', '清流', '朝霧', '菊乃', '月見', '白雲', '春木', '水明', '桜井', '竹風', '深山', '千景'][lodgingSerial % 16]!
        const suffix = lodgingSerial >= 16 ? `${Math.floor(lodgingSerial / 16) + 1}` : ''
        lodgingSerial++
        acquireTitle(c, year)
        c.parcel.use = 'commercial'; c.parcel.developedYear = year; c.capacity = 0
        c.building = { id: `lodging-${c.parcel.id}-${year}`, parcelId: c.parcel.id, polygon: footprint, kind: 'commercial', use: 'lodging', lodgingType: kind, guestRooms, name: kind === 'hotel' ? `ホテル${stem}${suffix}` : `${stem}${suffix}旅館`, height, builtYear: year, occupiedHouseholds: 0, occupancy: 'occupied' }
        c.footprint = footprint; c.formation = formation; built.push(c); rooms += guestRooms
        events.push({ id: `lodging-construction-${year}-${c.parcel.id}`, year, kind: 'construction', entityId: c.building.id, reason: kind === 'hotel' ? '連続する沿道敷地を取得した温泉ホテルの開業' : '湯の徒歩圏に立地する小旅館の開業' })
      }
      // A hotel must acquire a continuous, gently turning stretch on one road
      // side. The acquired hull is checked in full, including the gaps between
      // old properties; it cannot consume a different owner's intervening lot.
      const hotelRooms = built.reduce((sum, c) => sum + (c.building?.lodgingType === 'hotel' ? c.building.guestRooms ?? 0 : 0), 0)
      if (year >= 1960 && target >= 220 && year - lastHotelYear >= 15 && rooms < target && hotelRooms < target * .65) for (const { c } of ranked.slice(0, 48)) {
        const a = c.road.points[c.segment - 1]!, b = c.road.points[c.segment]!, length = distance(a, b)
        if (length < 1) continue
        const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length
        const normal = (lot: Candidate) => lot.parcel.polygon.reduce((sum, p) => sum + (p.x - c.frontage.x) * -uy + (p.y - c.frontage.y) * ux, 0) / lot.parcel.polygon.length
        const sameSide = eligible.filter(n => n.road.id === c.road.id && normal(n) * normal(c) > 0 && distance(n.frontage, c.frontage) < 85 && Math.abs((n.frontage.x - c.frontage.x) * -uy + (n.frontage.y - c.frontage.y) * ux) < 9).sort((p, q) => (p.frontage.x - q.frontage.x) * ux + (p.frontage.y - q.frontage.y) * uy)
        const anchor = sameSide.indexOf(c)
        for (const count of [4, 3, 2]) {
          const selected = sameSide.slice(Math.max(0, anchor - 1), Math.max(0, anchor - 1) + count)
          if (selected.length !== count || selected.some((lot, i) => i > 0 && distance(lot.frontage, selected[i - 1]!.frontage) > 38)) continue
          const polygon = convexHull(selected.flatMap(lot => lot.parcel.polygon)), area = polygonArea(polygon), selectedSet = new Set(selected)
          if (area < 900 || area > 4200 || !canPlace(polygon, year) || polygon.some(p => slope(p) > .12) || candidates.some(lot => !lot.parcel.retiredYear && !selectedSet.has(lot) && polygonsOverlap(polygon, lot.parcel.polygon))) continue
          const centroid = polygon.reduce((p, q) => ({ x: p.x + q.x / polygon.length, y: p.y + q.y / polygon.length }), { x: 0, y: 0 })
          if (slope(centroid) > .12) continue
          const footprint = polygon.map(p => ({ x: Math.round((centroid.x + (p.x - centroid.x) * .79) * 10) / 10, y: Math.round((centroid.y + (p.y - centroid.y) * .79) * 10) / 10 }))
          if (!canPlace(footprint, year)) continue
          const formation = survey(footprint)
          if (!formation.viable || formation.maximumFloors < 4) continue
          for (const previous of selected) {
            retireBuilding(previous, '隣接する宿泊用地の集約に伴う土地・建物の取得')
            if (previous.acquiredYear !== undefined) events.push({ id: `hotel-land-acquisition-${year}-${previous.parcel.id}`, year, kind: 'acquisition', entityId: previous.parcel.id, reason: '温泉ホテル用地として隣接敷地を一体取得' })
            previous.parcel.retiredYear = year; previous.parcel.developedYear = undefined
          }
          const parcel: Parcel = { id: `hotel-parcel-${c.parcel.id}-${year}`, polygon, entrance: c.parcel.entrance, roadId: c.road.id, createdYear: year, developedYear: year, use: 'commercial' }
          const hotel: Candidate = { ...c, parcel, footprint, formation, area, capacity: 0, building: undefined, acquiredYear: undefined }
          candidates.push(hotel)
          optionIndex.add({ candidate: hotel, bounds: boundsOf(parcel.polygon) })
          open(hotel, footprint, Math.min(formation.maximumFloors, 7, 4 + Math.floor(seededRandom(`${config.seed}:hotel:${year}`)() * 4)), 'hotel', formation)
          lastHotelYear = year
          break
        }
        if (lastHotelYear === year) break
      }
      // Small inns use existing frontages rather than inserting a second,
      // inaccessible row or blanket-converting every house in the town.
      for (const { c } of ranked) {
        if (rooms >= target || c.parcel.retiredYear || c.building?.use === 'lodging' || c.building && year < 1900) continue
        if (!canPlace(c.parcel.polygon, year)) continue
        const polygon = c.parcel.polygon
        if (polygon.length !== 4) continue
        const [a, b, , d] = polygon
        const inset = (u: number, v: number) => ({ x: Math.round((a!.x + (b!.x - a!.x) * u + (d!.x - a!.x) * v) * 10) / 10, y: Math.round((a!.y + (b!.y - a!.y) * u + (d!.y - a!.y) * v) * 10) / 10 })
        const footprint = [inset(.07, .10), inset(.93, .10), inset(.93, .78), inset(.55, .78), inset(.55, .91), inset(.07, .91)]
        if (!footprint.every(p => pointInPolygon(p, polygon)) || !canPlace(footprint, year)) continue
        const formation = survey(footprint)
        if (!formation.viable) continue
        const height = Math.min(formation.maximumFloors, year < 1900 ? 2 : 2 + (seededRandom(`${config.seed}:inn:${c.parcel.id}`)() < .55 ? 1 : 0))
        open(c, footprint, height, 'ryokan', formation)
      }
    }
    // Reuse existing capacity before making a new development commitment.
    const shortage = Math.max(0, Math.ceil(households * 1.035) - capacity)
    if (shortage > 0 && constructionYear) {
      const ranked = candidates.filter(c => !c.parcel.retiredYear && !c.building && c.parcel.createdYear <= year && (c.availableYear ?? c.parcel.createdYear) <= year && (!c.infillParent || c.infillParent.building && !c.infillParent.parcel.retiredYear && c.infillParent.parcel.use === 'residential' && c.infillParent.building.height <= 2 && c.infillParent.building.use !== 'lodging') && (c.parcel.use !== 'industrial' || year >= (industry?.activeYear ?? 1750))).map(c => {
        const time = travel(c)
        const station = activeStations.length ? Math.min(...activeStations.map(s => distance(c.frontage, s.point))) : Infinity
        const urban = Math.exp(-time * (year < 1900 ? 2.7 : year < 1950 ? 1.5 : 1) / 7)
        const centers = input.centers ?? [{ point: center, activeYear: 1650, catchment: 640, weight: 1.15 }]
        const reach = centers.filter(center => center.activeYear <= year).reduce((total, center) => total + center.weight * Math.exp(-distance(c.frontage, center.point) / (center.catchment * (year < 1900 ? .95 : 1.25)) - developmentClimbMinutes(c.frontage, center.point, input.elevation, year) / 7), 0)
        const pressure = 1 + .75 * Math.log1p(Math.max(0, households - 100) / 250)
        return { c, time, station, gross: pressure * urban * reach, score: pressure * urban * reach * c.formation.suitability - c.reluctance * (year < 1950 ? .30 : .22) - (c.road.role === 'farm' ? .12 : 0) - c.formation.formationCostPerHousehold / (year < 1900 ? 28 : 36) }
      }).filter(r => Number.isFinite(r.time) && r.score > (year < 1900 ? .045 : .025)).sort((a, b) => b.score - a.score || a.c.parcel.id.localeCompare(b.c.parcel.id))
      let added = 0
      for (const { c, time, gross } of ranked) {
        if (added >= shortage) break
        if (c.parcel.retiredYear) continue
        if (c.parcel.use === 'industrial' && industrialJobs >= jobs * .45) continue
        if (!canPlace(c.footprint, year)) continue
        if (c.acquiredYear === undefined && !canPlace(c.parcel.polygon, year)) continue
        if (c.infillParent && !canPlace(c.parcel.polygon, year)) continue
        const random = seededRandom(`${config.seed}:building:${c.parcel.id}`)
        const zone = zoning(c.frontage, year)
        const commercial = !c.parcel.access && c.parcel.use !== 'industrial' && c.form !== 'apartment' && (c.form === 'retail' || time < 10 && c.road.role !== 'farm' && random() < zone.retailShare)
        const apartment = !commercial && settlement !== 'village' && !c.parcel.access && year >= 1955 && (c.form === 'apartment' || year >= 1960 && random() < zone.apartmentShare)
        const affordable = (formation: DevelopmentSiteSurvey) => gross * formation.suitability - c.reluctance * (year < 1950 ? .30 : .22) - (c.road.role === 'farm' ? .12 : 0) - formation.formationCostPerHousehold / (year < 1900 ? 28 : 36) > (year < 1900 ? .045 : .025)
        const assembly = apartment ? modernHolding(c, year, zone, affordable) : null
        let footprint = assembly?.footprint ?? c.footprint, formation = assembly?.formation ?? c.formation
        // Construction form belongs to the investment year, not to the year
        // the old road opened. Reuse a real title for a larger modern pad;
        // unacquired adjoining options can instead be bought as one holding.
        if (!assembly && year >= 1955 && (apartment || commercial) && c.parcel.polygon.length === 4) {
          const [a, b, , d] = c.parcel.polygon
          const inset = (u: number, v: number) => ({ x: Math.round((a!.x + (b!.x - a!.x) * u + (d!.x - a!.x) * v) * 10) / 10, y: Math.round((a!.y + (b!.y - a!.y) * u + (d!.y - a!.y) * v) * 10) / 10 })
          footprint = [inset(.07, .10), inset(.93, .10), inset(.93, .88), inset(.07, .88)]
          formation = survey(footprint)
          if (!formation.viable || !canPlace(footprint, year) || !affordable(formation)) continue
        }
        c.parcel.use = c.parcel.use === 'industrial' ? 'industrial' : commercial ? 'commercial' : 'residential'
        c.parcel.developedYear = year
        const apartmentLimit = zone.kind === 'station-centre' ? settlement === 'metropolis' ? 10 : 8 : config.type === 'newtown' ? 5 : 6
        const apartmentFloors = apartment ? 3 + Math.floor(random() * Math.max(1, (assembly?.deep ? Math.min(6, apartmentLimit) : apartmentLimit) - 2)) : 0
        const height = Math.min(zone.maximumFloors, formation.maximumFloors, c.parcel.use === 'industrial' ? 1 : commercial ? year < 1900 ? 2 : 3 + Math.floor(random() * (settlement === 'metropolis' ? 9 : 3)) : apartment ? apartmentFloors : 1 + Math.floor(random() * 2))
        if (height < 1) { c.parcel.developedYear = undefined; continue }
        if (assembly) {
          let titleHash = 2166136261
          const identity = `${assembly.members.map(member => member.parcel.id).sort().join('|')}|${assembly.polygon.map(p => `${p.x},${p.y}`).join(';')}`
          for (const character of identity) titleHash = Math.imul(titleHash ^ character.charCodeAt(0), 16777619)
          for (const previous of assembly.members) {
            if (previous !== c) previous.parcel.retiredYear = year
            if (previous.infillParent) inheritedGardens.set(previous.infillParent, (inheritedGardens.get(previous.infillParent) ?? []).filter(garden => garden !== previous))
            inheritedGardens.delete(previous)
          }
          c.parcel = { ...c.parcel, id: `housing-${c.road.id}-${year}-${(titleHash >>> 0).toString(36)}`, polygon: assembly.polygon, entrance: assembly.entrance, ...(assembly.access ? { access: assembly.access } : {}), createdYear: year }
          c.area = assembly.area
          optionIndex.add({ candidate: c, bounds: boundsOf(c.parcel.polygon) })
        }
        c.footprint = footprint; c.formation = formation
        acquireTitle(c, year)
        if (c.infillParent) events.push({ id: `infill-acquire-${year}-${c.parcel.id}`, year, kind: 'acquisition', entityId: c.parcel.id, reason: '旧街道沿いの裏庭の既存持分を取得し、側方の専用通路で住宅地へ転用' })
        // Gross floor space includes shared access/circulation: a scenario
        // allowance of90m² per household, rather than two units for any pad size.
        c.capacity = c.parcel.use === 'industrial' ? 0 : apartment ? height * Math.max(2, Math.floor(polygonArea(c.footprint) / 90)) : commercial ? 1 : 1
        c.building = { id: `building-${c.parcel.id}`, parcelId: c.parcel.id, builtYear: year, polygon: c.footprint, kind: c.parcel.use, height }
        built.push(c); capacity += c.capacity; added += c.capacity
        if (c.parcel.use === 'industrial') industrialJobs += Math.round(c.area / 35)
        events.push({ id: `construction-${year}-${c.parcel.id}`, year, kind: 'construction', entityId: c.building.id, reason: c.parcel.use === 'industrial' ? '物流に接続した事業用地の供給' : '既存空室を使い切った後の住宅・商業需要' })
      }
    }
    // Station access can pay for rebuilding ageing stock after vacant capacity has
    // been used. Property boundaries survive; the old and new buildings are events.
    if (constructionYear && settlement !== 'village' && year >= 1960 && activeStations.length && capacity < households) {
      const random = seededRandom(`${config.seed}:redevelopment:${year}`)
      for (const c of [...built].sort((a, b) => a.parcel.id.localeCompare(b.parcel.id))) {
        if (capacity >= households * 1.035) break
        const old = c.building!
        if (old.kind === 'industrial' || old.use === 'lodging' || c.parcel.polygon.length !== 4 || c.capacity > 1 || year - (old.builtYear ?? year) < 35 || c.area < 320) continue
        const station = Math.min(...activeStations.map(s => distance(c.frontage, s.point)))
        if (station > (settlement === 'metropolis' ? 1200 : 430) || random() > (settlement === 'metropolis' ? .13 : .055)) continue
        const pressure = 1 + .75 * Math.log1p(Math.max(0, households - 100) / 250)
        const [a, b, , d] = c.parcel.polygon
        const inset = (u: number, v: number) => ({ x: Math.round((a!.x + (b!.x - a!.x) * u + (d!.x - a!.x) * v) * 10) / 10, y: Math.round((a!.y + (b!.y - a!.y) * u + (d!.y - a!.y) * v) * 10) / 10 })
        const renewed = [inset(.07, .10), inset(.93, .10), inset(.93, .88), inset(.07, .88)]
        if (!canPlace(renewed, year)) continue
        const formation = survey(renewed)
        if (!formation.viable) continue
        const floors = Math.min(zoning(c.frontage, year).maximumFloors, formation.maximumFloors, settlement === 'metropolis' ? station < 550 ? 10 : 6 : station < 220 ? 5 : 3), newCapacity = floors * 2
        if ((newCapacity - c.capacity) * pressure < 4 + c.reluctance * 20 + formation.formationCostPerHousehold / 6) continue
        events.push({ id: `redevelop-acquire-${year}-${c.parcel.id}`, year, kind: 'acquisition', entityId: old.id, reason: '駅周辺の住宅需要による老朽建物の建替え' })
        c.building = { ...old, id: `building-${c.parcel.id}-${year}`, builtYear: year, height: floors, polygon: renewed }
        capacity += newCapacity - c.capacity; c.capacity = newCapacity; c.formation = formation
        events.push({ id: `redevelop-build-${year}-${c.parcel.id}`, year, kind: 'construction', entityId: c.building.id, reason: '既存敷地を継承した共同住宅への建替え' })
      }
    }
    // Later road acquisition is explicit; surviving old lots keep their IDs and shape.
    for (let i = built.length - 1; i >= 0; i--) {
      const c = built[i]!
      if (!canPlace(c.building!.polygon, year)) {
        capacity -= c.capacity
        if (c.parcel.use === 'industrial') industrialJobs -= Math.round(c.area / 35)
        events.push({ id: `acquisition-${year}-${c.parcel.id}`, year, kind: 'acquisition', entityId: c.building!.id, reason: '後年の交通用地取得' })
        c.building = undefined; c.parcel.developedYear = undefined; built.splice(i, 1)
      }
    }
    // Falling population vacates properties; it does not erase their parcel,
    // footprint or history. Accessible homes retain use longest in this model.
    let residents = households
    const occupied = built.map(c => ({ c, value: travel(c) + distance(c.frontage, center) / 500 })).sort((a, b) => a.value - b.value || a.c.parcel.id.localeCompare(b.c.parcel.id))
    for (const { c } of occupied) {
      const used = Math.min(c.capacity, residents)
      residents -= used
      Object.assign(c.building!, { occupiedHouseholds: used, occupancy: c.building!.use === 'lodging' ? 'occupied' : c.capacity === 0 ? jobs < industrialJobs * .6 ? 'underused' : 'occupied' : used === 0 ? 'vacant' : used < c.capacity ? 'underused' : 'occupied' })
    }
    recordStock(year, built)
    if (year % 25 === 0 || year === end || year === 1930) snapshots.push({ year, households, capacity, vacant: Math.max(0, capacity - households), unmet: Math.max(0, households - capacity), roads: activeRoads.length, buildings: built.length })
  }
  return { buildings: built.map(c => c.building!), parcels: candidates.filter(c => c.acquiredYear !== undefined).map(c => c.parcel), events, snapshots, history }
}
