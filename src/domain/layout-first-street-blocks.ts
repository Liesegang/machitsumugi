import type { Point } from './types'
import type { PolygonRegion } from './geometry'
import type { LayoutFirstZone } from './layout-first-types'
import { boundsOf, distance, distanceToSegment, pointInPolygon, pointInRegion, polygonArea, polygonOverlapsRegion, seededRandom } from './geometry'

/** Survey vertices are denser on curved arterial edges than straight streets.
 * Their arithmetic mean is not the location of the enclosed land. */
export function layoutStreetFaceCenter(polygon: readonly Point[]): Point {
  let twiceArea = 0, x = 0, y = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, cross = a.x * b.y - b.x * a.y
    twiceArea += cross; x += (a.x + b.x) * cross; y += (a.y + b.y) * cross
  }
  return Math.abs(twiceArea) > 1e-8 ? { x: x / (3 * twiceArea), y: y / (3 * twiceArea) }
    : polygon.reduce((sum, point) => ({ x: sum.x + point.x / polygon.length, y: sum.y + point.y / polygon.length }), { x: 0, y: 0 })
}

/** Adopt only enclosed, fully surveyed lowland between at least two existing
 * urban neighbourhoods. The original brief remains immutable; the new face
 * regions can be used consistently by streets, buildings and ground cover. */
export function adoptLayoutInfillZones(faces: readonly Point[][], originalZones: readonly LayoutFirstZone[], options: {
  settlement?: 'village' | 'rural-town' | 'regional-city' | 'metropolis'
  density: number
  corridorSpacing: number
  canBuild: (point: Point) => boolean
  excludedRegions: readonly PolygonRegion[]
}): LayoutFirstZone[] {
  const result = [...originalZones]
  if (options.density < .6 || options.settlement !== 'regional-city' && options.settlement !== 'metropolis') return result
  const urban = originalZones.filter(zone => zone.kind !== 'rural'), reach = options.corridorSpacing * 1.55
  for (const [index, polygon] of faces.entries()) {
    const area = polygonArea(polygon), bounds = boundsOf(polygon)
    if (area < 4500 || area > options.corridorSpacing ** 2 * 6 || Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) > options.corridorSpacing * 3.4) continue
    const center = layoutStreetFaceCenter(polygon)
    if (!pointInPolygon(center, polygon) || originalZones.some(zone => pointInRegion(center, zone))) continue
    const neighbours = urban.filter(zone => zone.polygon.some((a, i) => distanceToSegment(center, a, zone.polygon[(i + 1) % zone.polygon.length]!) <= reach))
      .sort((a, b) => distance(center, a.center) - distance(center, b.center))
    // A nearby urban edge alone is fringe. Two neighbourhood centres must
    // bracket the face, preventing successive claims into open countryside.
    const bracketed = neighbours.some((a, i) => neighbours.slice(i + 1).some(b => {
      const da = distance(center, a.center), db = distance(center, b.center)
      return da > 1 && db > 1 && ((a.center.x - center.x) * (b.center.x - center.x) + (a.center.y - center.y) * (b.center.y - center.y)) / (da * db) < -.2
    }))
    if (!bracketed || options.excludedRegions.some(region => polygonOverlapsRegion(polygon, region))) continue
    let certified = true
    for (let y = bounds.minY; y <= bounds.maxY && certified; y += 25) for (let x = bounds.minX; x <= bounds.maxX; x += 25) {
      const point = { x, y }
      if (pointInPolygon(point, polygon) && !options.canBuild(point)) { certified = false; break }
    }
    if (!certified || !polygon.every(point => options.canBuild(point)) || !options.canBuild(center)) continue
    const parent = neighbours[0]!, industrial = neighbours.slice(0, 2).every(zone => zone.kind === 'industrial')
    result.push({ id: `layout-infill-face-${index}`, polygon: polygon.map(point => ({ ...point })), center,
      radius: Math.max(...polygon.map(point => distance(point, center))), kind: industrial ? 'industrial' : 'residential',
      builtYear: Math.max(1955, ...neighbours.slice(0, 2).map(zone => zone.builtYear)), angle: parent.angle,
      density: Math.min(options.density, neighbours.slice(0, 2).reduce((sum, zone) => sum + zone.density / 2, 0)),
      maximumFloors: Math.max(...neighbours.slice(0, 2).map(zone => zone.maximumFloors)) })
  }
  return result
}

export interface LayoutStreetFaceSplitOptions {
  spacing: number
  angle?: number
  jitter?: number
  seed: string
  minimumArea?: number
}
export interface LayoutStreetFaceSplit { points: [Point, Point]; polygons: Point[][] }

/** A street proposal joins two real edges of one existing road face. The
 * returned children are geometric proposals only: callers must survey the
 * entire chord before treating either child as a new street block. */
export function splitLayoutStreetFace(polygon: readonly Point[], options: LayoutStreetFaceSplitOptions): LayoutStreetFaceSplit | null {
  if (polygon.length < 3 || options.spacing <= 0) return null
  const ring = [...polygon], random = seededRandom(options.seed), angle = options.angle ?? 0
  const extent = (bearing: number) => {
    const values = ring.map(p => p.x * Math.cos(bearing) + p.y * Math.sin(bearing))
    return { low: Math.min(...values), high: Math.max(...values) }
  }
  const along = extent(angle), across = extent(angle + Math.PI / 2)
  const longest = Math.max(along.high - along.low, across.high - across.low)
  if (longest <= options.spacing * 1.42 || polygonArea(ring) <= options.spacing ** 2 * .72) return null
  const normal = angle + (across.high - across.low > along.high - along.low ? Math.PI / 2 : 0)
  const minimumArea = options.minimumArea ?? options.spacing ** 2 * .24
  const walk = (start: number, end: number, first: Point, last: Point) => {
    const result = [first]
    for (let n = 1; n <= ring.length; n++) {
      const index = (start + n) % ring.length
      if (distance(result.at(-1)!, ring[index]!) > 1e-7) result.push(ring[index]!)
      if (index === end) break
    }
    if (distance(result.at(-1)!, last) > 1e-7) result.push(last)
    return result
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const bearing = normal + (random() - .5) * (options.jitter ?? .06)
    const nx = Math.cos(bearing), ny = Math.sin(bearing), range = extent(bearing)
    const offset = range.low + (range.high - range.low) * (.43 + random() * .14)
    const hits: { point: Point; edge: number; order: number }[] = []
    for (let edge = 0; edge < ring.length; edge++) {
      const a = ring[edge]!, b = ring[(edge + 1) % ring.length]!, da = a.x * nx + a.y * ny - offset, db = b.x * nx + b.y * ny - offset
      if (Math.abs(da - db) < 1e-9 || da * db > 1e-8) continue
      const t = da / (da - db)
      if (t < -1e-8 || t > 1 + 1e-8) continue
      const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      if (!hits.some(hit => distance(hit.point, point) < 1e-6)) hits.push({ point, edge, order: -point.x * ny + point.y * nx })
    }
    hits.sort((a, b) => a.order - b.order)
    // A concave face can meet the cut several times. Each interior interval
    // is considered independently; no street may bridge an exterior notch.
    const chords = hits.slice(1).map((end, i) => ({ start: hits[i]!, end })).sort((a, b) => distance(b.start.point, b.end.point) - distance(a.start.point, a.end.point))
    for (const { start, end } of chords) {
      const middle = { x: (start.point.x + end.point.x) / 2, y: (start.point.y + end.point.y) / 2 }
      if (start.edge === end.edge || distance(start.point, end.point) < options.spacing * .55 || !pointInPolygon(middle, ring)) continue
      const first = walk(start.edge, end.edge, start.point, end.point), second = walk(end.edge, start.edge, end.point, start.point)
      if (first.length < 3 || second.length < 3 || polygonArea(first) < minimumArea || polygonArea(second) < minimumArea) continue
      if (Math.abs(polygonArea(first) + polygonArea(second) - polygonArea(ring)) > Math.max(.01, polygonArea(ring) * 1e-8)) continue
      return { points: [start.point, end.point], polygons: [first, second] }
    }
  }
  return null
}
