import type { Parcel, Point, Road } from './types'
import type { PolygonRegion } from './geometry'
import { boundsOf, distance, pathPointAt, pointInPolygon, polygonArea, polygonOverlapsRegion, projectPoint, regionArea, seededRandom } from './geometry'

/**
 * A C2, non-overshooting reconstruction of a natural cover's signed suitability.
 * The sample spacing is the uncertainty/smoothing scale, not a polygon edge
 * length. Positive B-spline weights cannot invent a new positive patch where
 * every surrounding sample is negative. Surveyed fields and acquired parcels
 * are deliberately clipped afterwards, so their hard boundaries stay hard.
 */
export function contourNaturalLand(width: number, height: number, sample: (point: Point) => number, sampleStep = 16): PolygonRegion[] {
  const columns = Math.ceil(width / sampleStep), rows = Math.ceil(height / sampleStep)
  const sx = width / columns, sy = height / rows, stride = columns + 5
  // Sample outside the crop as well: the map border is an exact final clip,
  // rather than an artificial dry strip influencing the reconstructed field.
  const values = new Float64Array(stride * (rows + 5))
  for (let y = -2; y <= rows + 2; y++) for (let x = -2; x <= columns + 2; x++) {
    const value = sample({ x: x * sx, y: y * sy })
    // A missing river can legitimately give a -Infinity distance margin.
    values[(y + 2) * stride + x + 2] = Number.isFinite(value) ? value : value > 0 ? 1e6 : -1e6
  }
  const weights = (t: number) => {
    const t2 = t * t, t3 = t2 * t
    return [(1 - 3 * t + 3 * t2 - t3) / 6, (4 - 6 * t2 + 3 * t3) / 6, (1 + 3 * t + 3 * t2 - 3 * t3) / 6, t3 / 6]
  }
  // World-space chords stay short at house-level zoom. This is shared polygon
  // geometry, not a renderer-only curve which would disagree with saved maps.
  const step = Math.min(4, sampleStep / 4), fineColumns = Math.ceil(width / step) + 2, fineRows = Math.ceil(height / step) + 2
  const fineX = width / (fineColumns - 2), fineY = height / (fineRows - 2)
  // The same fine-grid coordinates recur along every row/column. Cache only
  // their indices and weights, preserving the original f64 arithmetic order.
  // No signed values are replaced: mixed-cell intersections stay identical.
  const axis = (count: number, fineCell: number, coarseCell: number, limit: number) => Array.from({ length: count + 1 }, (_, i) => {
    const position = Math.max(0, Math.min(limit, (i - 1) * fineCell / coarseCell)), index = Math.floor(position)
    return { index, weights: weights(position - index) }
  })
  const horizontal = axis(fineColumns, fineX, sx, columns), vertical = axis(fineRows, fineY, sy, rows)
  const fine: number[][] = []
  for (let y = 0; y <= fineRows; y++) {
    const row: number[] = [], { index: iy, weights: wy } = vertical[y]!
    for (let x = 0; x <= fineColumns; x++) {
      if (!x || !y || x === fineColumns || y === fineRows) { row.push(-1); continue }
      const { index: ix, weights: wx } = horizontal[x]!
      let value = 0
      for (let dy = 0; dy < 4; dy++) {
        const offset = (iy + dy + 1) * stride + ix + 1
        value += wy[dy]! * (values[offset]! * wx[0]! + values[offset + 1]! * wx[1]! + values[offset + 2]! * wx[2]! + values[offset + 3]! * wx[3]!)
      }
      row.push(value)
    }
    fine.push(row)
  }
  return contourSamples(fineColumns, fineRows, fineX, fineY, fine)
}

/** Linear interpolation for physical suitability cuts; never a binary-cell outline. */
export function contourLand(width: number, height: number, sample: (point: Point) => number, step = 40): PolygonRegion[] {
  const columns = Math.ceil(width / step) + 2, rows = Math.ceil(height / step) + 2
  const sx = width / (columns - 2), sy = height / (rows - 2)
  const values: number[][] = []
  for (let y = 0; y <= rows; y++) values.push(Array.from({ length: columns + 1 }, (_, x) => x === 0 || y === 0 || x === columns || y === rows ? -1 : sample({ x: (x - 1) * sx, y: (y - 1) * sy })))
  return contourSamples(columns, rows, sx, sy, values)
}

function contourSamples(columns: number, rows: number, sx: number, sy: number, values: number[][]): PolygonRegion[] {
  type Segment = { a: Point; b: Point; used: boolean }
  const segments: Segment[] = [], at = new Map<string, Segment[]>()
  const key = (p: Point) => `${Math.round(p.x * 1000)}:${Math.round(p.y * 1000)}`
  const add = (a: Point, b: Point) => {
    const segment = { a, b, used: false }; segments.push(segment)
    for (const p of [a, b]) { const group = at.get(key(p)) ?? []; group.push(segment); at.set(key(p), group) }
  }
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const a = values[y]![x]!, b = values[y]![x + 1]!, c = values[y + 1]![x + 1]!, d = values[y + 1]![x]!
    if ((a > 0) === (b > 0) && (a > 0) === (c > 0) && (a > 0) === (d > 0)) continue
    const v = [a, b, c, d]
    const corners = [{ x: (x - 1) * sx, y: (y - 1) * sy }, { x: x * sx, y: (y - 1) * sy }, { x: x * sx, y: y * sy }, { x: (x - 1) * sx, y: y * sy }]
    const crossings: { edge: number; point: Point }[] = []
    for (let edge = 0; edge < 4; edge++) {
      const next = (edge + 1) % 4
      if ((v[edge]! > 0) === (v[next]! > 0)) continue
      const t = v[edge]! / (v[edge]! - v[next]!), a = corners[edge]!, b = corners[next]!
      crossings.push({ edge, point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } })
    }
    if (crossings.length === 2) add(crossings[0]!.point, crossings[1]!.point)
    else if (crossings.length === 4) {
      const centerInside = v.reduce((a, b) => a + b) > 0
      const firstInside = v[0]! > 0
      if (centerInside === firstInside) { add(crossings[0]!.point, crossings[1]!.point); add(crossings[2]!.point, crossings[3]!.point) }
      else { add(crossings[0]!.point, crossings[3]!.point); add(crossings[1]!.point, crossings[2]!.point) }
    }
  }
  const rings: Point[][] = []
  for (const first of segments) {
    if (first.used) continue
    const ring = [first.a], start = key(first.a)
    let segment = first, end = first.b
    for (let guard = 0; guard <= segments.length; guard++) {
      segment.used = true; ring.push(end)
      if (key(end) === start) break
      const next = (at.get(key(end)) ?? []).find(s => !s.used)
      if (!next) break
      segment = next; end = key(next.a) === key(end) ? next.b : next.a
    }
    if (key(ring.at(-1)!) !== start) continue
    ring.pop()
    if (ring.length >= 3 && polygonArea(ring) >= 40) rings.push(ring)
  }
  rings.sort((a, b) => polygonArea(b) - polygonArea(a))
  const entries: { polygon: Point[]; depth: number; parent: number }[] = []
  for (const polygon of rings) {
    let parent = -1
    for (let i = entries.length - 1; i >= 0; i--) if (pointInPolygon(polygon[0]!, entries[i]!.polygon)) { parent = i; break }
    entries.push({ polygon, parent, depth: parent < 0 ? 0 : entries[parent]!.depth + 1 })
  }
  return entries.flatMap((entry, i) => entry.depth % 2 ? [] : [{ polygon: entry.polygon, holes: entries.filter(e => e.parent === i && e.depth % 2).map(e => e.polygon) }])
}

/** Settlement is a continuous local occupation density, rather than a city-radius circle. */
export function settlementDensity(parcels: Parcel[], radius = 140) {
  const bins = new Map<string, { point: Point; area: number }[]>()
  for (const parcel of parcels) {
    if (!parcel.developedYear || parcel.retiredYear) continue
    const b = boundsOf(parcel.polygon), point = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, key = `${Math.floor(point.x / radius)}:${Math.floor(point.y / radius)}`
    const group = bins.get(key) ?? []; group.push({ point, area: polygonArea(parcel.polygon) }); bins.set(key, group)
  }
  const normalization = Math.PI * radius * radius / 3
  return (point: Point) => {
    let occupied = 0
    const x = Math.floor(point.x / radius), y = Math.floor(point.y / radius)
    for (let row = y - 1; row <= y + 1; row++) for (let col = x - 1; col <= x + 1; col++) for (const parcel of bins.get(`${col}:${row}`) ?? []) occupied += parcel.area * Math.max(0, 1 - distance(point, parcel.point) / radius)
    return occupied / normalization
  }
}

export interface AgriculturalTerrain {
  elevation(point: Point): number
  slope(point: Point): number
  wetness(point: Point): number
  channelAt(point: Point): { bankDistance: number; surfaceElevation: number; point?: Point; tangent?: Point; riverId?: string } | null
  rivers?: { id: string; points: Point[]; surfaceElevation: number[] }[]
  cultivable?(point: Point): boolean
}

/** Acquisitions do not turn every leftover triangle into a productive field.
 * Retain working room, and in built-up streets keep substantially intact old
 * titles rather than scattering tiny farm remnants among individual houses.
 * Large surviving urban/periurban holdings remain eligible.
 */
export function agriculturalRemnantSuitable(region: PolygonRegion, originalArea: number, builtDensity: number): boolean {
  const area = regionArea(region)
  const perimeter = [region.polygon, ...region.holes ?? []].reduce((sum, ring) => sum + ring.reduce((n, p, i) => n + distance(p, ring[(i + 1) % ring.length]!), 0), 0)
  if (area < 200 || area * 2 / perimeter < 7) return false
  return builtDensity < .25 || area >= originalArea * .65
}

type Intake = { point: Point; level: number; riverId: string }
const irrigationCache = new WeakMap<AgriculturalTerrain, Map<string, Intake[]>>()
function irrigationIntakes(terrain: AgriculturalTerrain, center: Point): Intake[] {
  let bins = irrigationCache.get(terrain)
  if (!bins) {
    bins = new Map()
    for (const river of terrain.rivers ?? []) for (let i = 1; i < river.points.length; i++) {
      const a = river.points[i - 1]!, b = river.points[i]!, count = Math.max(1, Math.ceil(distance(a, b) / 70))
      for (let j = 0; j < count; j++) {
        const t = j / count, point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, level = river.surfaceElevation[i - 1]! * (1 - t) + river.surfaceElevation[i]! * t
        const key = `${Math.floor(point.x / 300)}:${Math.floor(point.y / 300)}`, group = bins.get(key) ?? []
        group.push({ point, level, riverId: river.id }); bins.set(key, group)
      }
    }
    irrigationCache.set(terrain, bins)
  }
  const result: Intake[] = [], x = Math.floor(center.x / 300), y = Math.floor(center.y / 300)
  for (let row = y - 4; row <= y + 4; row++) for (let col = x - 4; col <= x + 4; col++) result.push(...bins.get(`${col}:${row}`) ?? [])
  return result
}

/** A nearby low river is not a water supply by itself. Find an upstream head
 * from the actual routed river, then survey a gravity canal without a ridge
 * requiring more than a shallow (1m) cut. No unmodelled pump is assumed.
 */
function gravityIrrigation(center: Point, fieldHigh: number, terrain: AgriculturalTerrain): boolean {
  const candidates = irrigationIntakes(terrain, center).map(intake => ({ ...intake, length: distance(center, intake.point) }))
    .filter(intake => intake.length <= 1200 && intake.level > .2 && intake.level >= fieldHigh + .15 + intake.length * .0005)
    .sort((a, b) => a.length - b.length)
  for (const intake of candidates) {
    const steps = Math.max(1, Math.ceil(intake.length / 12))
    let passable = true
    for (let j = 1; j < steps; j++) {
      const t = j / steps, point = { x: intake.point.x + (center.x - intake.point.x) * t, y: intake.point.y + (center.y - intake.point.y) * t }
      if (terrain.elevation(point) > intake.level - intake.length * t * .0005 + 1) { passable = false; break }
    }
    if (passable) return true
  }
  return false
}

/** A surveyed ownership unit is accepted whole; natural contours never cut its title. */
export function agriculturalPlotSuitable(polygon: Point[], suitable: (point: Point) => boolean, naturalExclusions: PolygonRegion[] = []): boolean {
  if (polygon.length < 3 || naturalExclusions.some(region => polygonOverlapsRegion(polygon, region))) return false
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, count = Math.max(1, Math.ceil(distance(a, b) / 10))
    for (let j = 0; j < count; j++) if (!suitable({ x: a.x + (b.x - a.x) * j / count, y: a.y + (b.y - a.y) * j / count })) return false
  }
  const bounds = boundsOf(polygon)
  for (let y = bounds.minY + 6; y < bounds.maxY; y += 12) for (let x = bounds.minX + 6; x < bounds.maxX; x += 12) {
    const p = { x, y }
    if (pointInPolygon(p, polygon) && !suitable(p)) return false
  }
  return true
}

/** A level working unit with a surveyed gravity supply; not a full canal design. */
export function agriculturalUse(polygon: Point[], terrain: AgriculturalTerrain): 'paddy' | 'dry-field' {
  const b = boundsOf(polygon), center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
  const channel = terrain.channelAt(center)
  if (!channel || channel.bankDistance < 0 || channel.bankDistance > 600) return 'dry-field'
  // Up to 0.5m local relief permits small field levelling, not an arbitrary
  // hillside terrace. A supply has to deliver water above the finished field.
  const sites = [center, ...polygon.filter((_, i) => i % Math.max(1, Math.floor(polygon.length / 8)) === 0)]
  const levels = sites.map(p => terrain.elevation(p)), low = Math.min(...levels), high = Math.max(...levels)
  const wetness = sites.reduce((sum, p) => sum + terrain.wetness(p), 0) / sites.length
  const slope = Math.max(...sites.map(p => terrain.slope(p)))
  return slope <= .02 && high - low <= .5 && low >= channel.surfaceElevation - .3 && wetness >= .25 && gravityIrrigation(center, high, terrain) ? 'paddy' : 'dry-field'
}

/** Convex cadastral boundary intersection; no natural suitability contour is used. */
function surveyHalfPlane(polygon: Point[], nx: number, ny: number, limit: number): Point[] {
  const result: Point[] = []
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, da = a.x * nx + a.y * ny - limit, db = b.x * nx + b.y * ny - limit
    if (da <= 1e-8) result.push(a)
    if (da < -1e-8 && db > 1e-8 || da > 1e-8 && db < -1e-8) { const t = da / (da - db); result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }) }
  }
  return result.filter((p, i) => !i || distance(p, result[i - 1]!) > 1e-7)
}

function surveyIntersection(subject: Point[], district: Point[], inset = 0) {
  let result = subject
  for (let i = 0; i < district.length && result.length >= 3; i++) {
    const a = district[i]!, b = district[(i + 1) % district.length]!, dx = b.x - a.x, dy = b.y - a.y
    result = surveyHalfPlane(result, dy, -dx, dy * a.x - dx * a.y - inset * Math.hypot(dx, dy))
  }
  return result
}

/** Earlier access projects establish coherent survey districts, rather than one
 * city-wide rotated lattice. Adjacent districts share cadastral boundaries;
 * within each, a common axis follows its farm road, tributary and local grade.
 * This is a fictional ownership/irrigation allocation, not real cadastral data.
 */
export function agriculturalPlots(width: number, height: number, seed: string, river: Point[] = [], terrain?: AgriculturalTerrain, inheritedRoads: Road[] = []) {
  const random = seededRandom(`${seed}:agricultural-ownership-v4`)
  type SurveySite = { point: Point; bearing?: number; roadId?: string }
  const sites: SurveySite[] = []
  const addSite = (site: SurveySite, spacing = 210) => {
    const p = site.point
    if (p.x < -200 || p.y < -200 || p.x > width + 200 || p.y > height + 200 || sites.some(s => distance(s.point, p) < spacing)) return
    sites.push(site)
  }
  // Farm-road projects have priority over through roads. Their individual
  // reach bearings survive later urban development; modern streets do not
  // rotate agriculture that existed before the town.
  const roads = inheritedRoads.filter(r => (r.builtYear ?? 1650) <= 1650 && !r.controlledAccess).sort((a, b) => Number(b.role === 'farm') - Number(a.role === 'farm') || a.id.localeCompare(b.id))
  for (const road of roads) {
    const length = road.points.slice(1).reduce((sum, p, i) => sum + distance(p, road.points[i]!), 0)
    // A cadastral survey belongs to one long access/irrigation reach. Sampling
    // every road bend used to rotate a fresh lattice every few hundred metres,
    // creating a fan of fields along every curved road. Local terraces can
    // still establish a separate contour-aligned holding below.
    const count = Math.max(1, Math.ceil(length / 1200))
    for (let i = 0; i < count; i++) {
      const t = (i + .5) / count, point = pathPointAt(road.points, t), a = pathPointAt(road.points, i / count), b = pathPointAt(road.points, (i + 1) / count)
      if (distance(a, b) <= 1) continue
      const bearing = Math.atan2(b.y - a.y, b.x - a.x)
      addSite({ point, bearing, roadId: road.id })
      // A survey taken on a level road cannot describe both adjoining terrace
      // slopes. Allocate separate, accessible holdings on each side before
      // measuring their local grade. Both still inherit the same old access;
      // no imaginary farm road or independently rotated field is introduced.
      for (const side of [-1, 1]) {
        const holding = { x: point.x - Math.sin(bearing) * side * 120, y: point.y + Math.cos(bearing) * side * 120 }
        if (!terrain) continue
        if (terrain?.cultivable && !terrain.cultivable(holding)) continue
        if (terrain.slope(holding) > .18 || (terrain.channelAt(holding)?.bankDistance ?? 1) < 0) continue
        const gx = (terrain.elevation({ x: holding.x + 30, y: holding.y }) - terrain.elevation({ x: holding.x - 30, y: holding.y })) / 60
        const gy = (terrain.elevation({ x: holding.x, y: holding.y + 30 }) - terrain.elevation({ x: holding.x, y: holding.y - 30 })) / 60
        const contour = Math.atan2(gy, gx) + Math.PI / 2
        if (Math.hypot(gx, gy) > .006 && Math.abs(Math.sin(2 * (bearing - contour))) > Math.sin(Math.PI / 8)) addSite({ point: holding, bearing, roadId: road.id }, 100)
      }
    }
  }
  // Callers without historical roads still receive shared districts. Their
  // axes come from local terrain/hydrology; the seeded positions vary ownership
  // extents, never individual plot rotations.
  if (!sites.length) for (let y = -150; y <= height + 250; y += 380) for (let x = -150; x <= width + 250; x += 420) addSite({ point: { x: x + 100 + random() * 140, y: y + 80 + random() * 130 } })
  const localBearing = (site: SurveySite) => {
    const p = site.point, channel = terrain?.channelAt(p)
    let channelBearing = channel?.tangent ? Math.atan2(channel.tangent.y, channel.tangent.x) : undefined
    if (channelBearing === undefined && river.length > 1) {
      let closest = 450
      for (let i = 1; i < river.length; i++) { const a = river[i - 1]!, b = river[i]!, d = distance(p, projectPoint(p, a, b)); if (d < closest) { closest = d; channelBearing = Math.atan2(b.y - a.y, b.x - a.x) } }
    }
    const gx = terrain ? (terrain.elevation({ x: p.x + 30, y: p.y }) - terrain.elevation({ x: p.x - 30, y: p.y })) / 60 : 0
    const gy = terrain ? (terrain.elevation({ x: p.x, y: p.y + 30 }) - terrain.elevation({ x: p.x, y: p.y - 30 })) / 60 : 0
    const grade = Math.hypot(gx, gy), contour = Math.atan2(gy, gx) + Math.PI / 2
    if (grade > .006 || site.bearing === undefined && grade > 1e-5) {
      if (site.bearing !== undefined && Math.abs(Math.sin(2 * (site.bearing - contour))) < Math.sin(Math.PI / 8)) return site.bearing
      return contour
    }
    if (site.bearing !== undefined) {
      // A river's small bends do not rotate an established level land survey.
      // The canal/road reach is the durable boundary; tributaries still choose
      // distinct axes when no inherited survey exists.
      return site.bearing
    }
    return channelBearing ?? 0
  }
  const divisions = (start: number, end: number, count: number, rng: () => number) => {
    const weights = Array.from({ length: count }, () => .7 + rng() * .6), total = weights.reduce((a, b) => a + b), result = [start]
    for (const weight of weights) result.push(result.at(-1)! + (end - start) * weight / total)
    return result
  }
  const plots: { id: string; polygon: Point[]; center: Point; landUse: 'paddy' | 'dry-field'; districtId: string; sourceRoadId?: string }[] = []
  for (const [index, site] of sites.entries()) {
    let district: Point[] = [{ x: -250, y: -250 }, { x: width + 250, y: -250 }, { x: width + 250, y: height + 250 }, { x: -250, y: height + 250 }]
    for (const other of sites) if (other !== site) {
      const nx = other.point.x - site.point.x, ny = other.point.y - site.point.y, limit = (other.point.x ** 2 + other.point.y ** 2 - site.point.x ** 2 - site.point.y ** 2) / 2
      district = surveyHalfPlane(district, nx, ny, limit)
      if (district.length < 3) break
    }
    if (district.length < 3 || polygonArea(district) < 2000) continue
    const bearing = localBearing(site), co = Math.cos(bearing), si = Math.sin(bearing)
    const local = (p: Point): Point => ({ x: (p.x - site.point.x) * co + (p.y - site.point.y) * si, y: -(p.x - site.point.x) * si + (p.y - site.point.y) * co })
    const world = (x: number, y: number): Point => ({ x: site.point.x + x * co - y * si, y: site.point.y + x * si + y * co })
    const boundary = district.map(local), bounds = boundsOf(boundary), rng = seededRandom(`${seed}:survey-${index}`)
    const lowland = terrain && agriculturalUse([site.point], terrain) === 'paddy'
    const crossSlope = terrain ? Math.abs(terrain.elevation(world(30, 0)) - terrain.elevation(world(-30, 0))) : 0
    const alongSlope = terrain ? Math.abs(terrain.elevation(world(0, 30)) - terrain.elevation(world(0, -30))) : 0
    const shortAcross = crossSlope > alongSlope
    const longSide = lowland ? 85 + rng() * 40 : 48 + rng() * 24, shortSide = lowland ? 24 + rng() * 10 : 38 + rng() * 20
    const columnCount = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / (shortAcross ? shortSide : longSide)))
    const columns = divisions(bounds.minX, bounds.maxX, columnCount, rng)
    const rows = divisions(bounds.minY, bounds.maxY, Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / (shortAcross ? longSide : shortSide))), rng)
    for (let row = 1; row < rows.length; row++) {
      // Flat irrigated units retain a common canal allocation. Dry-field
      // holdings are inherited in contour-aligned bands: each band has its own
      // frontage divisions, so ownership edges end at real T junctions rather
      // than repeating one set of cuts across the entire district.
      const rowColumns = lowland || Math.max(crossSlope, alongSlope) <= .36 ? columns : divisions(bounds.minX, bounds.maxX, columnCount, seededRandom(`${seed}:survey-${index}:holding-band-${row}`))
      for (let col = 1; col < rowColumns.length; col++) {
        const bank = lowland ? .9 : .6, x0 = rowColumns[col - 1]! + bank, x1 = rowColumns[col]! - bank, y0 = rows[row - 1]! + bank, y1 = rows[row]! - bank
        if (x1 <= x0 || y1 <= y0) continue
        // The group boundary exists before individual ownership is measured.
        // Its straight shared edge can end a surveyed lot; a later natural
        // suitability isoline may only reject that lot, never cut it into arcs.
        const polygon = surveyIntersection([world(x0, y0), world(x1, y0), world(x1, y1), world(x0, y1)], district, 1.2)
        if (polygon.length < 3 || polygonArea(polygon) < 200) continue
        const perimeter = polygon.reduce((sum, p, i) => sum + distance(p, polygon[(i + 1) % polygon.length]!), 0)
        if (polygonArea(polygon) * 2 / perimeter < 7) continue
        const center = { x: polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length, y: polygon.reduce((sum, p) => sum + p.y, 0) / polygon.length }
        plots.push({ id: `survey-${index}-${row}-${col}`, polygon, center, districtId: `survey-${index}`, ...(site.roadId ? { sourceRoadId: site.roadId } : {}), landUse: terrain ? agriculturalUse(polygon, terrain) : 'dry-field' })
      }
    }
  }
  return plots
}
