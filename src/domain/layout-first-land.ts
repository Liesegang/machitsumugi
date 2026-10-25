import type { Building, BuildingState, CityConfig, GrowthEvent, Parcel, Point, Road, TimelineVersion } from './types'
import type { Bounds, PolygonRegion } from './geometry'
import type { LayoutFirstZone } from './layout-first-types'
import { boundsOf, corridorPolygon, distance, distanceToSegment, overlaps, pointInRegion, polygonArea, polygonOverlapsRegion, polygonsOverlap, projectPoint, seededRandom, segmentsCross } from './geometry'
import { buildingServiceYears } from './building-lifecycle'
import { surveyDevelopmentSite } from './development-terrain'
import { controlledRoad } from './road-graph'

export interface LayoutFirstLandInput {
  config: CityConfig
  roads: Road[]
  zones: LayoutFirstZone[]
  reserves?: PolygonRegion[]
  /** Complete physical terrain/water test. Ordinary road ROW is checked here. */
  canPlace(polygon: Point[]): boolean
  slope(point: Point): number
  elevation?: (point: Point) => number
}
export interface LayoutFirstLandMetrics {
  candidates: number; accepted: number; rearTitles: number; replacements: number
  rejected: { outsideZone: number; terrain: number; reserve: number; road: number; title: number; formation: number; access: number; density: number }
  titleArea: number; footprintArea: number; grossFloorArea: number; zoneArea: number; developedFraction: number
}
interface Indexed { bounds: Bounds }
function index<T extends Indexed>(cellSize = 80) {
  const cells = new Map<string, T[]>()
  const keys = function* (b: Bounds) { for (let x = Math.floor(b.minX / cellSize); x <= Math.floor(b.maxX / cellSize); x++) for (let y = Math.floor(b.minY / cellSize); y <= Math.floor(b.maxY / cellSize); y++) yield `${x}:${y}` }
  return {
    add(value: T) { for (const key of keys(value.bounds)) { const list = cells.get(key) ?? []; list.push(value); cells.set(key, list) } },
    query(bounds: Bounds) { const values = new Set<T>(); for (const key of keys(bounds)) for (const value of cells.get(key) ?? []) if (overlaps(bounds, value.bounds)) values.add(value); return [...values] },
  }
}
interface RoadSegment extends Indexed { road: Road; a: Point; b: Point; polygon: Point[] }
interface Holding { polygon: Point[]; entrance: Point; access: Point[]; body: [number, number, number, number]; rear: boolean }
interface Lot extends Holding { road: Road; zone: LayoutFirstZone; origin: Point; tangent: Point; normal: Point; initialYear: number; id: string; form: 'house' | 'shop' | 'apartment' | 'workshop' }
const EPSILON = 1e-6
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value))
const nearBoundary = (point: Point, polygon: Point[]) => polygon.some((p, i) => distanceToSegment(point, p, polygon[(i + 1) % polygon.length]!) < .001)
const contains = (point: Point, region: PolygonRegion) => pointInRegion(point, region) || nearBoundary(point, region.polygon) && !(region.holes ?? []).some(hole => nearBoundary(point, hole))
const polygonSamples = (polygon: Point[]) => polygon.flatMap((p, i) => { const q = polygon[(i + 1) % polygon.length]!, steps = Math.max(1, Math.ceil(distance(p, q) / 8)); return Array.from({ length: steps }, (_, j) => ({ x: p.x + (q.x - p.x) * j / steps, y: p.y + (q.y - p.y) * j / steps })) })
function insideRegion(polygon: Point[], region: PolygonRegion) {
  if (!polygonSamples(polygon).every(p => contains(p, region))) return false
  if (polygon.some((p, i) => region.polygon.some((q, j) => segmentsCross(p, polygon[(i + 1) % polygon.length]!, q, region.polygon[(j + 1) % region.polygon.length]!)))) return false
  return !(region.holes ?? []).some(hole => polygonsOverlap(polygon, hole))
}
const localPoint = (origin: Point, tangent: Point, normal: Point, u: number, v: number): Point => ({ x: origin.x + tangent.x * u + normal.x * v, y: origin.y + tangent.y * u + normal.y * v })
const rectangleAt = (world: (u: number, v: number) => Point, u0: number, u1: number, v0: number, v1: number) => [world(u0, v0), world(u1, v0), world(u1, v1), world(u0, v1)]

/** Walk one physical polyline by accumulated chainage, including short curve samples. */
function roadAt(road: Road, chainage: number): { point: Point; tangent: Point } {
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]!, b = road.points[i]!, length = distance(a, b)
    if (length < EPSILON) continue
    if (chainage <= length) return { point: { x: a.x + (b.x - a.x) * chainage / length, y: a.y + (b.y - a.y) * chainage / length }, tangent: { x: (b.x - a.x) / length, y: (b.y - a.y) / length } }
    chainage -= length
  }
  const a = road.points.at(-2)!, b = road.points.at(-1)!, length = distance(a, b) || 1
  return { point: { ...b }, tangent: { x: (b.x - a.x) / length, y: (b.y - a.y) / length } }
}
function rayDistance(origin: Point, direction: Point, segment: RoadSegment) {
  const dx = segment.b.x - segment.a.x, dy = segment.b.y - segment.a.y, determinant = direction.x * dy - direction.y * dx
  if (Math.abs(determinant) < EPSILON) return Infinity
  const x = segment.a.x - origin.x, y = segment.a.y - origin.y
  const along = (x * dy - y * dx) / determinant, across = (x * direction.y - y * direction.x) / determinant
  return along > 10 && across >= 0 && across <= 1 ? along : Infinity
}
function zoneScore(zone: LayoutFirstZone, point: Point) {
  const proximity = distance(point, zone.center) / Math.max(1, zone.radius)
  return proximity + (zone.kind === 'station' ? -.16 : zone.kind === 'industrial' ? -.08 : 0)
}

/**
 * Spatial composition, not a population/finance simulation. Survey complete road
 * blocks once, then give their holdings a finite sequence of physical frames.
 * The title's date never becomes the age of a present-day replacement building.
 */
export function developLayoutFirstLand(input: LayoutFirstLandInput) {
  const { config } = input, endYear = clamp(Math.round(config.targetYear ?? 2025), 1650, 2025)
  const metrics: LayoutFirstLandMetrics = { candidates: 0, accepted: 0, rearTitles: 0, replacements: 0,
    rejected: { outsideZone: 0, terrain: 0, reserve: 0, road: 0, title: 0, formation: 0, access: 0, density: 0 },
    titleArea: 0, footprintArea: 0, grossFloorArea: 0, zoneArea: input.zones.reduce((sum, zone) => sum + polygonArea(zone.polygon) - (zone.holes ?? []).reduce((n, hole) => n + polygonArea(hole), 0), 0), developedFraction: 0 }
  const roads = input.roads.filter(road => road.points.length >= 2).sort((a, b) => (a.builtYear ?? 1650) - (b.builtYear ?? 1650) || a.id.localeCompare(b.id))
  const roadIndex = index<RoadSegment>(), reserveIndex = index<Indexed & PolygonRegion>(), titles = index<Indexed & { polygon: Point[] }>()
  for (const road of roads) for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]!, b = road.points[i]!
    if (distance(a, b) < EPSILON) continue
    const polygon = corridorPolygon(a, b, road.width / 2 + .35)
    roadIndex.add({ road, a, b, polygon, bounds: boundsOf(polygon) })
  }
  for (const region of input.reserves ?? []) reserveIndex.add({ ...region, bounds: boundsOf(region.polygon) })
  const parcels: Parcel[] = [], buildings: Building[] = [], events: GrowthEvent[] = []
  const history = { parcels: [] as TimelineVersion<Parcel>[], buildings: [] as TimelineVersion<Building>[], buildingStates: [] as BuildingState[] }
  const reject = (kind: keyof LayoutFirstLandMetrics['rejected']) => { metrics.rejected[kind]++; return false }
  const validLand = (polygon: Point[], zone: LayoutFirstZone) => {
    const bounds = boundsOf(polygon)
    if (!insideRegion(polygon, zone)) return reject('outsideZone')
    if (!input.canPlace(polygon)) return reject('terrain')
    if (reserveIndex.query(bounds).some(region => polygonOverlapsRegion(polygon, region))) return reject('reserve')
    if (roadIndex.query(bounds).some(segment => polygonsOverlap(polygon, segment.polygon))) return reject('road')
    if (titles.query(bounds).some(title => polygonsOverlap(polygon, title.polygon))) return reject('title')
    return true
  }
  const footprintFor = (lot: Lot, year: number, serial: number) => {
    const random = seededRandom(`${config.seed}:${lot.id}:frame:${year}:${serial}`), [u0, u1, v0, v1] = lot.body
    const world = (u: number, v: number) => localPoint(lot.origin, lot.tangent, lot.normal, u, v)
    const modern = year >= 1955, apartment = lot.form === 'apartment' && modern
    const side = lot.form === 'shop' ? .7 : apartment ? 2.5 : 1.1 + random() * .9
    const width = u1 - u0, depth = v1 - v0
    const left = u0 + side, right = u1 - side
    const front = v0 + (lot.rear ? 4.4 + random() * 1.2 : lot.form === 'shop' ? 1.8 : 2.8 + random() * 1.8)
    const houseDepth = Math.min(depth - 6, lot.form === 'workshop' ? 17 + random() * 12 : lot.form === 'shop' ? 12 + random() * 10 : 10 + random() * 6)
    const rear = apartment ? v1 - 3 : front + houseDepth
    let polygon: Point[]
    if (apartment && width > 29 && depth > 30 && random() < .7) {
      const arm = Math.min(11, (right - left) * .33), cross = Math.min(12, (rear - front) * .35)
      polygon = random() < .45
        ? [world(left, front), world(right, front), world(right, rear), world(right - arm, rear), world(right - arm, front + cross), world(left + arm, front + cross), world(left + arm, rear), world(left, rear)]
        : [world(left, front), world(left + arm, front), world(left + arm, rear - cross), world(right, rear - cross), world(right, rear), world(left, rear)]
    } else if (!apartment && width > 13 && random() < .28) {
      const inset = Math.min(3.5, (right - left) * .22), offset = Math.min(4, (rear - front) * .3)
      polygon = [world(left + inset, front), world(right, front), world(right, rear), world(left, rear), world(left, front + offset), world(left + inset, front + offset)]
    } else polygon = rectangleAt(world, left, right, front, rear)
    if (polygonArea(polygon) < 25 || !insideRegion(polygon, { polygon: lot.polygon }) || !input.canPlace(polygon)) return null
    const survey = surveyDevelopmentSite({ slope: input.slope, elevation: input.elevation }, world((u0 + u1) / 2, (front + rear) / 2), polygon)
    if (!survey.viable) return null
    const maximum = Math.max(1, Math.min(lot.zone.maximumFloors, survey.maximumFloors))
    const height = apartment ? Math.min(maximum, 3 + Math.floor(random() * Math.max(1, maximum - 2))) : lot.form === 'workshop' ? Math.min(2, maximum) : Math.min(maximum, year < 1900 ? 1 + Number(random() < .4) : 2 + Number(modern && lot.form === 'shop' && random() < .35))
    const kind: Building['kind'] = lot.form === 'workshop' ? 'industrial' : lot.form === 'shop' ? 'commercial' : 'residential'
    return { id: `layout-building-${lot.id}-${year}-${serial}`, polygon, kind, height, parcelId: lot.id, builtYear: year } satisfies Building
  }
  /** Coarse occupancy assumptions, separate from the already surveyed stock.
   * Changing the trend never resamples titles, rebuilds geometry or runs an
   * annual economy. Peripheral/rural stock has a larger declining vacancy share. */
  const occupancyAt = (lot: Lot, building: Building, year: number): Pick<Building, 'occupancy' | 'occupiedHouseholds'> => {
    const capacity = building.kind === 'residential' ? Math.max(1, Math.floor(polygonArea(building.polygon) * building.height / 85)) : 0
    if (year < 1975) return { occupancy: 'occupied', occupiedHouseholds: capacity }
    const random = seededRandom(`${config.seed}:layout-occupancy:${lot.id}`), selection = random(), useFraction = random()
    const settlement = config.settlement ?? 'regional-city'
    const rurality = Math.min(1, (settlement === 'village' ? 1 : settlement === 'rural-town' ? .65 : settlement === 'regional-city' ? .25 : 0) + (lot.zone.kind === 'rural' ? .3 : 0))
    const peripheral = clamp(distance(lot.origin, lot.zone.center) / Math.max(1, lot.zone.radius), 0, 1)
    const trend = config.populationTrend ?? 'stable', late = year >= 1995
    const vacancy = trend === 'declining' ? late ? .12 + rurality * .12 + peripheral * .08 : .035 + rurality * .035
      : trend === 'growing' ? .01 + rurality * .008 : late ? .035 + rurality * .035 : .02 + rurality * .015
    if (selection < vacancy) return { occupancy: 'vacant', occupiedHouseholds: 0 }
    const underuse = trend === 'declining' ? late ? .18 + rurality * .10 : .07 : trend === 'growing' ? .02 : late ? .07 : .035
    if (selection < vacancy + underuse && (capacity > 1 || building.kind !== 'residential')) return { occupancy: 'underused', occupiedHouseholds: capacity > 1 ? Math.max(1, Math.min(capacity - 1, Math.floor(capacity * (.35 + useFraction * .4)))) : 0 }
    return { occupancy: 'occupied', occupiedHouseholds: capacity }
  }
  function accept(lot: Lot) {
    metrics.candidates++
    if (!validLand(lot.polygon, lot.zone)) return false
    // Private access is an actual3m corridor, including both sides of each bend.
    for (let i = 1; i < lot.access.length; i++) {
      const a = lot.access[i - 1]!, b = lot.access[i]!
      if (distance(a, b) < .01) continue
      const corridor = corridorPolygon(a, b, 1.4), bounds = boundsOf(corridor)
      // The first connection also occupies the existing public ROW/verge, but
      // its complete width must still avoid water, reserved sites and owners.
      if ((i > 1 && !insideRegion(corridor, { polygon: lot.polygon })) || !input.canPlace(corridor) || polygonSamples(corridor).some(point => input.slope(point) > .18) || reserveIndex.query(bounds).some(region => polygonOverlapsRegion(corridor, region)) || titles.query(bounds).some(title => polygonsOverlap(corridor, title.polygon))) return reject('access')
    }
    const parcel: Parcel = { id: lot.id, polygon: lot.polygon, entrance: lot.entrance, roadId: lot.road.id, access: lot.access, createdYear: lot.initialYear, developedYear: lot.initialYear, use: lot.form === 'workshop' ? 'industrial' : lot.form === 'shop' ? 'commercial' : 'residential' }
    let year = lot.initialYear, serial = 0
    const allFrames: TimelineVersion<Building>[] = []
    // At most eight physical frames across375years; no annual market loop.
    while (year <= 2025 && serial < 10) {
      const building = footprintFor(lot, year, serial)
      if (!building) return reject('formation')
      const next = year + buildingServiceYears(config.seed, building)
      allFrames.push({ from: year, ...(next <= 2025 ? { to: next } : {}), value: building })
      year = next; serial++
    }
    const frames = allFrames.filter(frame => frame.from <= endYear).map(frame => frame.to !== undefined && frame.to > endYear ? { from: frame.from, value: frame.value } : frame)
    if (!frames.length) return false
    const current = frames.at(-1)!.value
    const privatePaths = lot.access.slice(1).map((point, i) => corridorPolygon(lot.access[i]!, point, 1.4))
    if (privatePaths.some(path => allFrames.some(frame => polygonsOverlap(path, frame.value.polygon)))) return reject('access')
    titles.add({ polygon: lot.polygon, bounds: boundsOf(lot.polygon) })
    metrics.accepted++; metrics.rearTitles += Number(lot.rear); metrics.replacements += frames.length - 1
    metrics.titleArea += polygonArea(lot.polygon); metrics.footprintArea += polygonArea(current.polygon); metrics.grossFloorArea += polygonArea(current.polygon) * current.height
    parcels.push(parcel); buildings.push({ ...current, ...occupancyAt(lot, current, endYear) })
    history.parcels.push({ from: parcel.createdYear, value: parcel }); history.buildings.push(...frames)
    for (const frame of frames) {
      let previousState = occupancyAt(lot, frame.value, frame.from)
      history.buildingStates.push({ id: frame.value.id, from: frame.from, ...previousState })
      for (const from of [1975, 1995]) if (from > frame.from && from <= endYear && (frame.to === undefined || from < frame.to)) {
        const state = occupancyAt(lot, frame.value, from)
        if (state.occupancy !== previousState.occupancy || state.occupiedHouseholds !== previousState.occupiedHouseholds) history.buildingStates.push({ id: frame.value.id, from, ...state })
        previousState = state
      }
      events.push({ id: `layout-frame-${frame.value.id}`, year: frame.from, kind: 'construction', entityId: frame.value.id, reason: frame === frames[0] ? '地区の形成期に接道敷地へ建築' : '敷地を引き継いで老朽建物を建替え' })
      if (frame.to !== undefined) events.push({ id: `layout-retire-${frame.value.id}`, year: frame.to, kind: 'demolition', entityId: frame.value.id, reason: '建替えに伴う旧建物の解体' })
    }
    return true
  }
  for (const road of roads) {
    // A collector may contain one bridge span. Its dry approaches still have
    // frontage; the exact water/pad/access tests reject only the wet portions.
    if (road.role === 'bridge' || controlledRoad(road) || (road.level ?? 0) !== 0 || road.role === 'farm' || (road.builtYear ?? 1650) > endYear) continue
    const length = road.points.slice(1).reduce((sum, point, i) => sum + distance(road.points[i]!, point), 0), random = seededRandom(`${config.seed}:layout-titles:${road.id}`)
    let chainage = 5 + random() * 5, serial = 0
    while (chainage < length - 5) {
      const sample = roadAt(road, chainage), nearbyZones = input.zones.filter(zone => contains(sample.point, zone)).sort((a, b) => zoneScore(a, sample.point) - zoneScore(b, sample.point))
      const primary = nearbyZones[0]
      const broad = primary?.kind === 'industrial' || primary?.kind === 'apartment' || primary?.kind === 'station' && random() < .45
      const width = broad ? 28 + random() * 24 : primary?.kind === 'historic' ? 9 + random() * 10 : 11 + random() * 10
      chainage += width / 2
      if (chainage + width / 2 > length - 4) break
      const { point: origin, tangent } = roadAt(road, chainage)
      for (const side of [-1, 1]) {
        const normal = { x: -tangent.y * side, y: tangent.x * side }, world = (u: number, v: number) => localPoint(origin, tangent, normal, u, v)
        const probe = world(0, road.width / 2 + 9)
        const zone = input.zones.filter(z => contains(probe, z)).sort((a, b) => zoneScore(a, probe) - zoneScore(b, probe))[0]
        if (!zone || zone.density <= 0) { metrics.rejected.outsideZone++; continue }
        const lotRandom = seededRandom(`${config.seed}:layout-title:${road.id}:${serial}:${side}`)
        if (lotRandom() > zone.density) { metrics.rejected.density++; continue }
        const initialYear = Math.max(1650, road.builtYear ?? 1650, zone.builtYear)
        if (initialYear > endYear) continue
        const v0 = road.width / 2 + .85, u0 = -width / 2 + .35, u1 = width / 2 - .35
        const search = boundsOf([world(u0, 0), world(u1, 0), world(u0, 175), world(u1, 175)])
        let depth = zone.kind === 'industrial' ? 55 : zone.kind === 'rural' ? 30 : 43
        let nearest = Infinity
        for (const segment of roadIndex.query(search)) {
          // Adjacent samples on the same curving street do not become opposite frontage.
          if (segment.road === road && distanceToSegment(origin, segment.a, segment.b) < width * 1.5) continue
          for (const offset of [u0, 0, u1]) nearest = Math.min(nearest, rayDistance(world(offset, 0), normal, segment) - segment.road.width / 2)
        }
        if (Number.isFinite(nearest)) depth = clamp((nearest - v0) / 2 - .65, 16, 82)
        const apartment = zone.kind === 'apartment' || zone.kind === 'station' && width >= 27 || zone.kind === 'residential' && width >= 27 && lotRandom() < .45
        const form: Lot['form'] = zone.kind === 'industrial' ? 'workshop' : apartment ? 'apartment' : zone.kind === 'historic' && lotRandom() < .45 || zone.kind === 'station' && lotRandom() < .4 ? 'shop' : 'house'
        const attachment = (u: number) => {
          const target = world(u, 0)
          return road.points.slice(1).map((p, i) => projectPoint(target, road.points[i]!, p)).sort((a, b) => distance(target, a) - distance(target, b))[0]!
        }
        const base = { road, zone, origin, tangent, normal, initialYear, form }
        const id = `${road.id}-${serial}-${side > 0 ? 'left' : 'right'}`
        let placed = false
        if (form === 'house' && depth >= 46 && width >= 15) {
          const stem = 3.4, frontDepth = 23 + lotRandom() * 3, seam = v0 + frontDepth, rearEntry = u1 - stem / 2
          const front: Holding = { polygon: rectangleAt(world, u0, u1 - stem - .3, v0, seam - .35), entrance: world((u0 + u1 - stem - .3) / 2, v0), access: [], body: [u0, u1 - stem - .3, v0, seam - .35], rear: false }
          front.access = [attachment((u0 + u1 - stem - .3) / 2), front.entrance]
          const rear: Holding = { polygon: [world(u1 - stem, v0), world(u1, v0), world(u1, v0 + depth), world(u0, v0 + depth), world(u0, seam), world(u1 - stem, seam)], entrance: world(rearEntry, v0), access: [attachment(rearEntry), world(rearEntry, v0 + 1.5), world(rearEntry, seam + 1.8), world(u1 - 3, seam + 1.8)], body: [u0, u1 - 1, seam, v0 + depth], rear: true }
          if (accept({ ...base, ...rear, id: `layout-parcel-${id}-rear` })) placed = accept({ ...base, ...front, id: `layout-parcel-${id}` }) || true
        }
        if (!placed) for (const factor of [1, .8, .64]) {
          const d = depth * factor
          if (d < 18) continue
          const entrance = world(0, v0), holding: Holding = { polygon: rectangleAt(world, u0, u1, v0, v0 + d), entrance, access: [attachment(0), entrance], body: [u0, u1, v0, v0 + d], rear: false }
          if (accept({ ...base, ...holding, id: `layout-parcel-${id}` })) break
        }
      }
      chainage += width / 2 + .45; serial++
    }
  }
  metrics.developedFraction = metrics.zoneArea > 0 ? metrics.titleArea / metrics.zoneArea : 0
  events.sort((a, b) => a.year - b.year || a.id.localeCompare(b.id))
  return { parcels, buildings, history, events, metrics }
}
