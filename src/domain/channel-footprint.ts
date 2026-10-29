import ClipperLib from 'clipper-lib'
import type { Path, PolyNode } from 'clipper-lib'
import type { Point } from './types'
import type { WaterRegion } from './terrain-water'

type Polygon = [number, number][][]
export const channelFootprintDiagnostics = { preciseUnions: 0 }

/** Independent integer Vatti sweep for almost coincident floating edges.
 * One micrometre coordinates retain narrow sources; the PolyTree preserves
 * islands and nested water rather than filling a failed ring's holes.
 */
function preciseUnion(polygons: Polygon[]): Polygon[] {
  channelFootprintDiagnostics.preciseUnions++
  const scale = 1_000_000, paths: Path[] = polygons.flatMap(polygon => polygon.map((ring, i) => {
    const path = ring.map(([x, y]) => ({ X: Math.round(x * scale), Y: Math.round(y * scale) }))
    if (path.some(p => !Number.isSafeInteger(p.X) || !Number.isSafeInteger(p.Y))) throw new Error('Channel union exceeds precise coordinate range')
    if (ClipperLib.Clipper.Orientation(path) !== (i === 0)) path.reverse()
    return path
  }))
  const clipper = new ClipperLib.Clipper(), tree = new ClipperLib.PolyTree()
  clipper.StrictlySimple = true
  if (!clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true) || !clipper.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) throw new Error('Precise channel union failed')
  const ring = (node: PolyNode): [number, number][] => {
    const points: [number, number][] = node.Contour().map(p => [p.X / scale, p.Y / scale])
    return [...points, points[0]!]
  }
  const result: Polygon[] = []
  const visit = (node: PolyNode) => {
    if (!node.IsHole() && node.Contour().length >= 3) result.push([ring(node), ...node.Childs().filter(child => child.IsHole()).map(ring)])
    for (const child of node.Childs()) visit(child)
  }
  visit(tree)
  if (!result.length) throw new Error('Precise channel union lost its water area')
  return result
}

function unionSections(polygons: Polygon[]): Polygon[] {
  if (!polygons.length) return []
  return preciseUnion(polygons)
}

/** Canonical exposed contours also remove zero-width retraced cuts from older
 * saved river polygons. The physical source and its islands stay untouched. */
export function unionWaterContours(regions: readonly WaterRegion[]): WaterRegion[] {
  const polygons: Polygon[] = regions.map(region => [region.polygon, ...(region.holes ?? [])].map(ring => ring.map(p => [p.x, p.y] as [number, number])))
  return unionSections(polygons).map(rings => ({ polygon: rings[0]!.slice(0, -1).map(([x, y]) => ({ x, y })), holes: rings.slice(1).map(ring => ring.slice(0, -1).map(([x, y]) => ({ x, y }))) }))
}

/** A single variable-width stroke, not a mosaic of segment rectangles. Both
 * banks follow the centreline; round joins/caps are part of that same contour.
 * Nonzero winding resolves overlaps at hairpins without drawing their seams. */
function strokeContour(points: Point[], widths: number[]): Polygon[] {
  const segments = points.slice(1).flatMap((b, i) => {
    const a = points[i]!, length = Math.hypot(b.x - a.x, b.y - a.y)
    return length ? [{ a, b, first: widths[i]! / 2, last: widths[i + 1]! / 2, angle: Math.atan2(b.y - a.y, b.x - a.x) }] : []
  })
  const arc = (ring: [number, number][], p: Point, radius: number, start: number, sweep: number) => {
    const step = radius ? Math.min(Math.PI / 4, 2 * Math.acos(Math.max(-1, 1 - .15 / radius))) : Math.PI
    const count = Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(1e-6, step)))
    for (let i = 0; i <= count; i++) { const angle = start + sweep * i / count; ring.push([p.x + Math.cos(angle) * radius, p.y + Math.sin(angle) * radius]) }
  }
  if (!segments.length) {
    if(!points.length)return []
    const ring:[number,number][]=[]
    arc(ring,points[0]!,widths.reduce((maximum,width)=>Math.max(maximum,width),0)/2,0,Math.PI*2)
    return [[ring]]
  }
  const bank = (side: number) => {
    const ring: [number, number][] = [], first = segments[0]!
    arc(ring, first.a, first.first, first.angle + side * Math.PI / 2, 0)
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!, next = segments[i + 1]
      arc(ring, segment.b, segment.last, segment.angle + side * Math.PI / 2, next ? Math.atan2(Math.sin(next.angle - segment.angle), Math.cos(next.angle - segment.angle)) : 0)
    }
    return ring
  }
  const first = segments[0]!, last = segments.at(-1)!, ring = bank(1)
  arc(ring, last.b, last.last, last.angle + Math.PI / 2, -Math.PI)
  ring.push(...bank(-1).reverse())
  arc(ring, first.a, first.first, first.angle - Math.PI / 2, -Math.PI)
  return [[ [...ring, ring[0]!] ]]
}

function simplifyRing(ring: [number, number][], toleranceAt: (p: [number, number]) => number): [number, number][] {
  const open = ring.slice(0, -1)
  const line = (points: [number, number][]) => {
    const keep = new Uint8Array(points.length), tolerances = points.map(p => toleranceAt(p) ** 2), stack = [[0, points.length - 1]]
    keep[0] = keep[points.length - 1] = 1
    while (stack.length) {
      const [first, last] = stack.pop()!, a = points[first!]!, b = points[last!]!, dx = b[0] - a[0], dy = b[1] - a[1]
      let selected = -1, maximum = 1
      for (let i = first! + 1; i < last!; i++) {
        const p = points[i]!, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))), distance = (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2
        const relativeError = distance / Math.max(1e-20, tolerances[i]!)
        if (relativeError > maximum) { maximum = relativeError; selected = i }
      }
      if (selected >= 0) { keep[selected] = 1; stack.push([first!, selected], [selected, last!]) }
    }
    return points.filter((_, i) => keep[i])
  }
  const split = Math.floor(open.length / 2), reduced = [...line(open.slice(0, split + 1)).slice(0, -1), ...line([...open.slice(split), open[0]!]).slice(0, -1)]
  return reduced.length >= 3 ? [...reduced, reduced[0]!] : ring
}

/** Expand one surveyed centreline into a continuous variable-width stroke.
 * Resolve its nonzero winding once to preserve islands and tight hairpins. */
export function channelFootprint(points: Point[], widths: number[]): WaterRegion[] {
  if (points.length !== widths.length) throw new Error('Channel widths must match its centreline')
  type Section = { a: Point; b: Point; first: number; last: number }
  const sections = new Map<string, Section[]>(), bucketSize = 80
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!, radius = widths[i]! / 2
    if (!Number.isFinite(radius) || radius < 0 || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('Channel sections must be finite')
    if (i) {
      const a = points[i - 1]!, first = widths[i - 1]! / 2, dx = p.x - a.x, dy = p.y - a.y, length = Math.hypot(dx, dy)
      if (length && first + radius > 0) {
        const margin = Math.max(first, radius) + .3, section = { a, b: p, first: first * 2, last: radius * 2 }
        for (let x = Math.floor((Math.min(a.x, p.x) - margin) / bucketSize); x <= Math.floor((Math.max(a.x, p.x) + margin) / bucketSize); x++) for (let y = Math.floor((Math.min(a.y, p.y) - margin) / bucketSize); y <= Math.floor((Math.max(a.y, p.y) + margin) / bucketSize); y++) { const key = `${x},${y}`, bucket = sections.get(key) ?? []; bucket.push(section); sections.set(key, bucket) }
      }
    }
  }
  if (!widths.some(width => width > 0)) return []
  const joined = unionSections(strokeContour(points, widths))
  // Remove the sweep's nearly collinear quad intersections before these banks
  // become obstacles to every road/parcel survey. The error budget is smaller
  // than the narrowest nonzero section, so fine runoff heads are retained.
  const toleranceAt = ([x, y]: [number, number]) => {
    let nearest = Infinity, width = 0
    for (const section of sections.get(`${Math.floor(x / bucketSize)},${Math.floor(y / bucketSize)}`) ?? []) {
      const { a, b } = section, dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1))), distance = (x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2
      if (distance < nearest) { nearest = distance; width = section.first * (1 - t) + section.last * t }
    }
    return Math.min(.15, width / 8)
  }
  const regions = unionSections(joined.map(polygon => polygon.map(ring => simplifyRing(ring, toleranceAt))))
  return regions.map(polygon => ({ polygon: polygon[0]!.slice(0, -1).map(([x, y]) => ({ x, y })), holes: polygon.slice(1).map(hole => hole.slice(0, -1).map(([x, y]) => ({ x, y }))) }))
}
