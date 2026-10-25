import type { Point } from './types'
import type { LayoutFirstZone } from './layout-first-types'
import { distance, polygonArea, seededRandom } from './geometry'
import { layoutStreetFaceCenter, splitLayoutStreetFace, splitLayoutStreetFacePath } from './layout-first-street-blocks'

export interface LayoutStreetFrontage { a: Point; b: Point; roadId?: string; width: number; builtYear: number }
export interface LayoutStreetFabricInput {
  polygon: readonly Point[]
  zone: LayoutFirstZone
  seed: string
  depth: number
  /** Accepted public-road segments on this physical face's perimeter. */
  frontages?: readonly LayoutStreetFrontage[]
  terrain?: { slope: (point: Point) => number; elevation: (point: Point) => number }
}
export interface LayoutStreetFabricProposal {
  points: Point[]
  polygons: Point[][]
  width: number
  kind: 'historic' | 'incremental' | 'readjusted'
  bearing: number
}

const difference = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(2 * (a - b)), Math.cos(2 * (a - b)))) / 2

function frontageBearing(input: LayoutStreetFabricInput) {
  const groups = new Map<string, { x: number; y: number; length: number; width: number; year: number }>()
  for (const [index, segment] of (input.frontages ?? []).entries()) {
    const length = distance(segment.a, segment.b)
    if (length < 1) continue
    const angle = Math.atan2(segment.b.y - segment.a.y, segment.b.x - segment.a.x), key = segment.roadId ?? `frontage-${index}`
    const group = groups.get(key) ?? { x: 0, y: 0, length: 0, width: segment.width, year: segment.builtYear }
    group.x += Math.cos(angle * 2) * length; group.y += Math.sin(angle * 2) * length; group.length += length
    group.width = Math.max(group.width, segment.width); group.year = Math.min(group.year, segment.builtYear); groups.set(key, group)
  }
  const ordered = [...groups.values()].sort((a, b) => b.length * Math.min(2, b.width / 5) * (b.year < 1900 ? 1.3 : 1) - a.length * Math.min(2, a.width / 5) * (a.year < 1900 ? 1.3 : 1))
  if (ordered.length) return { bearing: Math.atan2(ordered[0]!.y, ordered[0]!.x) / 2, secondary: ordered[1] ? Math.atan2(ordered[1]!.y, ordered[1]!.x) / 2 : undefined }
  // No inherited city frame is required. Even without tagged frontage the
  // actual longest perimeter edge is a better guide than a global zone angle.
  const longest = input.polygon.map((a, i) => ({ a, b: input.polygon[(i + 1) % input.polygon.length]! })).sort((a, b) => distance(b.a, b.b) - distance(a.a, a.b))[0]!
  return { bearing: Math.atan2(longest.b.y - longest.a.y, longest.b.x - longest.a.x), secondary: undefined }
}

/** A single local project, rooted in existing perimeter roads and terrain.
 * It proposes geometry only. Children become real blocks only after the
 * caller accepts the COMPLETE polyline with all physical/dated ROW guards. */
export function planLayoutStreetFabricSplit(input: LayoutStreetFabricInput): LayoutStreetFabricProposal | null {
  if (input.polygon.length < 3 || polygonArea([...input.polygon]) < 500) return null
  const center = layoutStreetFaceCenter(input.polygon), { zone } = input
  const random = seededRandom(`${input.seed}:fabric:${zone.id}:${center.x.toFixed(2)}:${center.y.toFixed(2)}:${input.depth}`)
  const context = frontageBearing(input), slope = input.terrain?.slope(center) ?? 0
  let bearing = context.bearing
  if (input.terrain && slope > .035) {
    const east = input.terrain.elevation({ x: center.x + 45, y: center.y }) - input.terrain.elevation({ x: center.x - 45, y: center.y })
    const north = input.terrain.elevation({ x: center.x, y: center.y + 45 }) - input.terrain.elevation({ x: center.x, y: center.y - 45 })
    const contour = Math.atan2(north, east) + Math.PI / 2
    if (Math.hypot(east, north) > .5 && difference(bearing, contour) < Math.PI / 3) bearing = contour
  }
  // Land readjustment is a bounded 300–500m patch in some flat, postwar
  // neighbourhoods. It cannot spread a common grid over the entire city.
  const patch = seededRandom(`${input.seed}:readjustment:${zone.id}`)() < .48
  const readjusted = zone.kind !== 'historic' && zone.builtYear >= 1955 && slope < .025 && patch && distance(center, zone.center) < Math.min(250, Math.max(150, zone.radius * .36))
  const kind = zone.kind === 'historic' ? 'historic' : readjusted ? 'readjusted' : 'incremental'
  const spacing = zone.kind === 'industrial' ? 175 : zone.kind === 'rural' ? 150 : kind === 'historic' ? 70 : kind === 'readjusted' ? 112 : 105
  const fractions = kind === 'readjusted' ? [.46, .54] : kind === 'historic' ? [.32, .39, .61, .68] : [.34, .43, .59, .66]
  const fraction = fractions[Math.floor(random() * fractions.length)]!
  const split = splitLayoutStreetFace(input.polygon, { spacing, angle: bearing, jitter: 0, cutFraction: fraction, seed: `${input.seed}:cut:${input.depth}` })
  if (!split) return null
  let points: Point[] = split.points, polygons = split.polygons
  const length = distance(points[0]!, points[1]!)
  // A few longer old/local connectors adapt between the perimeter directions.
  // This is one deliberate dogleg, never independent jitter at every node.
  const changingFrontage = context.secondary !== undefined && difference(context.bearing, context.secondary) > Math.PI / 12 && difference(context.bearing, context.secondary) < Math.PI * .42
  if (kind !== 'readjusted' && length > spacing * 1.45 && (changingFrontage || kind === 'historic' && random() < .34)) {
    const a = points[0]!, b = points[1]!, fractionAlong = .4 + random() * .2, middle = { x: a.x + (b.x - a.x) * fractionAlong, y: a.y + (b.y - a.y) * fractionAlong }
    const toward = (center.x - middle.x) * -(b.y - a.y) + (center.y - middle.y) * (b.x - a.x), offset = Math.min(16, spacing * .16) * (toward < 0 ? -1 : 1)
    const bend = { x: middle.x - (b.y - a.y) / length * offset, y: middle.y + (b.x - a.x) / length * offset }
    const candidate = [a, bend, b], children = splitLayoutStreetFacePath(input.polygon, candidate, spacing ** 2 * .24)
    if (children) { points = candidate; polygons = children }
  }
  const width = zone.kind === 'industrial' ? 7 : zone.kind === 'rural' ? 4.8 : kind === 'historic' ? 4.8 : kind === 'readjusted' ? 6.5 : 5.6
  return { points, polygons, width, kind, bearing: Math.atan2(points.at(-1)!.y - points[0]!.y, points.at(-1)!.x - points[0]!.x) }
}
