import type { Point, Railway } from './types'
import type { RoadRole } from './road-graph'
import { roadLength } from './road-graph'
import { boundsOf, distance, distanceToSegment, overlaps, pointInPolygon, polygonArea } from './geometry'
import { alignmentDiagnostics } from './road-alignment'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'

export interface RailServiceFrontage { a: Point; b: Point; roadId: string; width: number; builtYear: number; role?: RoadRole; controlledAccess?: boolean; level?: number }
export interface RailServiceCutInput {
  polygon: readonly Point[]
  frontages: readonly RailServiceFrontage[]
  railways: readonly Pick<Railway, 'id' | 'points' | 'mode' | 'builtYear'>[]
  builtYear: number
  width: number
  /** A coarse parent may receive at most one service street on each side;
   * children return to normal mixed local fabric before trying this fallback. */
  usedSides?: readonly { railwayId: string; side: -1 | 1 }[]
  planner: { validate: (points: Point[], width: number) => boolean; railwayWidthAllows: (points: Point[], oldWidth: number, newWidth: number, role: 'lane') => boolean }
  rowAllows: (points: Point[], width: number) => boolean
  elevation: (point: Point) => number
  /** Insert actual graph junctions and certify their old profiles before the
   * final partition and all complete-alignment guards are evaluated. */
  canonicalize?: (points: Point[]) => Point[] | null
}
export interface RailServiceCut {
  points: Point[]; polygons: Point[][]; width: number; builtYear: number
  railwayId: string; side: -1 | 1; offset: number
  fromRoadId: string; toRoadId: string
}

const EPSILON = 1e-7
const segmentHit = (a: Point, b: Point, c: Point, d: Point) => {
  const x = b.x - a.x, y = b.y - a.y, u = d.x - c.x, v = d.y - c.y, determinant = x * v - y * u
  if (Math.abs(determinant) < 1e-10) return null
  const t = ((c.x - a.x) * v - (c.y - a.y) * u) / determinant, s = ((c.x - a.x) * y - (c.y - a.y) * x) / determinant
  return t >= -EPSILON && t <= 1 + EPSILON && s >= -EPSILON && s <= 1 + EPSILON ? { t: Math.max(0, Math.min(1, t)), point: { x: a.x + Math.max(0, Math.min(1, t)) * x, y: a.y + Math.max(0, Math.min(1, t)) * y } } : null
}
const segmentDistance = (a: Point, b: Point, c: Point, d: Point) => segmentHit(a, b, c, d) ? 0 : Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d), distanceToSegment(c, a, b), distanceToSegment(d, a, b))

/** Exact perimeter-to-perimeter split. Endpoint intersections use the same
 * tolerance as contact certification; strict cross-product signs alone can
 * mistake a 1e-12m endpoint residue for an extra boundary crossing. All other
 * boundary contacts, self intersections and exterior samples are rejected. */
export function splitLayoutRailServiceFace(polygon: readonly Point[], path: readonly Point[], minimumArea = 1500): Point[][] | null {
  if (polygon.length < 3 || path.length < 2) return null
  const first = path[0]!, last = path.at(-1)!
  const edgeAt = (point: Point) => polygon.findIndex((a, i) => distanceToSegment(point, a, polygon[(i + 1) % polygon.length]!) < EPSILON)
  const start = edgeAt(first), end = edgeAt(last)
  if (start < 0 || end < 0 || start === end || distance(first, last) < 1) return null
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!
    if (distance(a, b) < .01) return null
    for (let edge = 0; edge < polygon.length; edge++) {
      const hit = segmentHit(a, b, polygon[edge]!, polygon[(edge + 1) % polygon.length]!)
      if (hit && !(i === 1 && distance(hit.point, first) < EPSILON) && !(i === path.length - 1 && distance(hit.point, last) < EPSILON)) return null
    }
    for (let j = 1; j < i - 1; j++) if (segmentHit(a, b, path[j - 1]!, path[j]!)) return null
    const samples = Math.max(2, Math.ceil(distance(a, b) / 10))
    for (let n = 1; n < samples; n++) {
      const point = { x: a.x + (b.x - a.x) * n / samples, y: a.y + (b.y - a.y) * n / samples }
      if (!pointInPolygon(point, [...polygon]) || edgeAt(point) >= 0) return null
    }
  }
  if (path.slice(1, -1).some(point => !pointInPolygon(point, [...polygon]) || edgeAt(point) >= 0)) return null
  const walk = (from: number, to: number, a: Point, b: Point) => {
    const ring = [a]
    for (let n = 1; n <= polygon.length; n++) {
      const index = (from + n) % polygon.length
      if (distance(ring.at(-1)!, polygon[index]!) > EPSILON) ring.push(polygon[index]!)
      if (index === to) break
    }
    if (distance(ring.at(-1)!, b) > EPSILON) ring.push(b)
    return ring
  }
  const children = [[...walk(start, end, first, last), ...path.slice(1, -1).reverse()], [...walk(end, start, last, first), ...path.slice(1, -1)]]
  if (children.some(child => polygonArea(child) < minimumArea) || Math.abs(children.reduce((area, child) => area + polygonArea(child), 0) - polygonArea([...polygon])) > Math.max(.01, polygonArea([...polygon]) * 1e-8)) return null
  return children
}

/** A mitered offset follows the saved engineering alignment. It is not a
 * straight chord through its ends and never uses the railway itself as road. */
function offsetTrack(points: readonly Point[], offset: number): Point[] | null {
  const result: Point[] = []
  for (let i = 0; i < points.length; i++) {
    const before = points[Math.max(0, i - 1)]!, at = points[i]!, after = points[Math.min(points.length - 1, i + 1)]!
    const a = i === 0 ? { x: after.x - at.x, y: after.y - at.y } : { x: at.x - before.x, y: at.y - before.y }
    const b = i === points.length - 1 ? a : { x: after.x - at.x, y: after.y - at.y }
    const al = Math.hypot(a.x, a.y), bl = Math.hypot(b.x, b.y)
    if (al < EPSILON || bl < EPSILON) return null
    const nx = -a.y / al - b.y / bl, ny = a.x / al + b.x / bl, nl = Math.hypot(nx, ny)
    if (nl < EPSILON) return null
    const cosine = (nx / nl) * (-a.y / al) + (ny / nl) * (a.x / al)
    if (cosine < .5) return null
    result.push({ x: at.x + nx / nl * offset / cosine, y: at.y + ny / nl * offset / cosine })
  }
  return result
}

function containedIntervals(polygon: readonly Point[], path: Point[]) {
  const hits: { point: Point; segment: number; along: number }[] = [], lengths = [0]
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!, length = distance(a, b)
    for (let edge = 0; edge < polygon.length; edge++) {
      const hit = segmentHit(a, b, polygon[edge]!, polygon[(edge + 1) % polygon.length]!)
      if (hit && !hits.some(other => distance(other.point, hit.point) < 1e-6)) hits.push({ point: hit.point, segment: i - 1, along: lengths[i - 1]! + hit.t * length })
    }
    lengths.push(lengths.at(-1)! + length)
  }
  hits.sort((a, b) => a.along - b.along)
  const intervals: Point[][] = []
  for (let i = 1; i < hits.length; i++) {
    const a = hits[i - 1]!, b = hits[i]!, candidate = [a.point, ...path.slice(a.segment + 1, b.segment + 1), b.point].filter((point, index, all) => index === 0 || distance(point, all[index - 1]!) > EPSILON)
    if (roadLength(candidate) < 80) continue
    intervals.push(candidate)
  }
  return intervals
}

/** Call only after ordinary mixed-grain cuts fail on a large rail face.
 * Four finite offsets, actual perimeter contacts, exact polygon children, and
 * the ordinary physical guards are required before any proposal can return. */
export function planLayoutRailServiceCut(input: RailServiceCutInput) {
  const attempts: { railwayId: string; side: -1 | 1; offset: number; reason: string; intervals?: unknown[] }[] = []
  if (input.polygon.length < 3 || polygonArea([...input.polygon]) < 50000 || input.width < 4.6 || !Number.isFinite(input.width)) return { cut: null, attempts }
  const bounds = boundsOf([...input.polygon]), padding = 100
  const nearBounds = { minX: bounds.minX - padding, maxX: bounds.maxX + padding, minY: bounds.minY - padding, maxY: bounds.maxY + padding }
  const rails = input.railways.filter(railway => railway.mode !== 'subway' && (railway.builtYear ?? 1900) <= input.builtYear)
  const sources = rails.map(railway => {
    let lengthInside = 0, first = Infinity, last = -1
    for (let i = 1; i < railway.points.length; i++) {
      const a = railway.points[i - 1]!, b = railway.points[i]!
      if (overlaps(boundsOf([a, b]), nearBounds)) { first = Math.min(first, i - 1); last = i }
      if (pointInPolygon({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, [...input.polygon])) lengthInside += distance(a, b)
    }
    return { railway, lengthInside, first, last }
  }).filter(source => source.lengthInside > 30).sort((a, b) => b.lengthInside - a.lengthInside)
  const source = sources[0]
  if (!source) return { cut: null, attempts }
  const track = source.railway.points.slice(Math.max(0, source.first - 2), Math.min(source.railway.points.length, source.last + 3))
  const physicalTracks = rails.flatMap(railway => railway.points.slice(1).map((b, i) => ({ a: railway.points[i]!, b, bounds: boundsOf([railway.points[i]!, b]) }))).filter(segment => overlaps(segment.bounds, nearBounds))
  const eligible = input.frontages.filter(frontage => frontage.builtYear <= input.builtYear && frontage.width >= 4.6 && !frontage.controlledAccess && !['expressway', 'ramp'].includes(frontage.role ?? '') && (frontage.level ?? 0) === 0)
  const contact = (point: Point) => eligible.find(frontage => distanceToSegment(point, frontage.a, frontage.b) < EPSILON)
  for (const offset of [48, -48, 84, -84]) {
    const side = (offset > 0 ? 1 : -1) as -1 | 1, record = { railwayId: source.railway.id, side, offset: Math.abs(offset) }
    if (input.usedSides?.some(used => used.railwayId === record.railwayId && used.side === side)) continue
    const offsetPath = offsetTrack(track, offset)
    if (!offsetPath) { attempts.push({ ...record, reason: 'offset-geometry' }); continue }
    const intervalDetails: unknown[] = []
    const candidates = containedIntervals(input.polygon, offsetPath).flatMap(points => {
      const from = contact(points[0]!), to = contact(points.at(-1)!)
      if (!from || !to || from.roadId === to.roadId) { intervalDetails.push({from:from?.roadId,to:to?.roadId,length:roadLength(points)}); return [] }
      const polygons = splitLayoutRailServiceFace(input.polygon, points, 1500)
      intervalDetails.push({from:from.roadId,to:to.roadId,length:roadLength(points),polygons:!!polygons})
      return polygons ? [{ points, polygons, fromRoadId: from.roadId, toRoadId: to.roadId }] : []
    }).sort((a, b) => Math.min(...b.polygons.map(polygonArea)) - Math.min(...a.polygons.map(polygonArea)))
    const candidate = candidates[0]
    if (!candidate) { attempts.push({ ...record, reason: 'perimeter-or-polygon', intervals:intervalDetails }); continue }
    const points = input.canonicalize ? input.canonicalize(candidate.points) : candidate.points
    if (!points || points.length < 2 || distance(points[0]!, candidate.points[0]!) > EPSILON || distance(points.at(-1)!, candidate.points.at(-1)!) > EPSILON) { attempts.push({ ...record, reason: 'canonical-contact' }); continue }
    const polygons = splitLayoutRailServiceFace(input.polygon, points, 1500)
    if (!polygons) { attempts.push({ ...record, reason: 'canonical-partition' }); continue }
    const clearance = input.width / 2 + 10.5
    const separated = points.slice(1).every((b, i) => physicalTracks.every(segment => segmentDistance(points[i]!, b, segment.a, segment.b) >= clearance - EPSILON))
    if (!separated) { attempts.push({ ...record, reason: 'track-clearance' }); continue }
    if (alignmentDiagnostics(points).minimumRadius < 50 - 1e-6) { attempts.push({ ...record, reason: 'radius' }); continue }
    if (!input.planner.validate(points, input.width)) { attempts.push({ ...record, reason: 'width' }); continue }
    if (!input.rowAllows(points, input.width)) { attempts.push({ ...record, reason: 'ROW' }); continue }
    if (!input.planner.railwayWidthAllows(points, .01, input.width, 'lane')) { attempts.push({ ...record, reason: 'rail' }); continue }
    if (!surveyedRoadGradeAllowed({ points }, .13, input.elevation)) { attempts.push({ ...record, reason: 'grade' }); continue }
    attempts.push({ ...record, reason: 'accepted' })
    const cut: RailServiceCut = { ...candidate, points, polygons, width: input.width, builtYear: input.builtYear, ...record }
    return { cut, attempts }
  }
  return { cut: null, attempts }
}
