// Frozen pre-optimization contour reference. Do not update with production code.
import { describe, expect, it } from 'vitest'
import { contourLand, contourNaturalLand } from './land-use'
import type { Point } from './types'
import type { PolygonRegion } from './geometry'
import { pointInPolygon, polygonArea } from './geometry'

/**
 * A C2, non-overshooting reconstruction of a natural cover's signed suitability.
 * The sample spacing is the uncertainty/smoothing scale, not a polygon edge
 * length. Positive B-spline weights cannot invent a new positive patch where
 * every surrounding sample is negative. Surveyed fields and acquired parcels
 * are deliberately clipped afterwards, so their hard boundaries stay hard.
 */
function referenceNaturalLand(width: number, height: number, sample: (point: Point) => number, sampleStep = 16): PolygonRegion[] {
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
  const reconstructed = (p: Point) => {
    const gx = Math.max(0, Math.min(columns, p.x / sx)), gy = Math.max(0, Math.min(rows, p.y / sy))
    const ix = Math.floor(gx), iy = Math.floor(gy), wx = weights(gx - ix), wy = weights(gy - iy)
    let value = 0
    for (let y = 0; y < 4; y++) {
      const offset = (iy + y + 1) * stride + ix + 1
      value += wy[y]! * (values[offset]! * wx[0]! + values[offset + 1]! * wx[1]! + values[offset + 2]! * wx[2]! + values[offset + 3]! * wx[3]!)
    }
    return value
  }
  // World-space chords stay short at house-level zoom. This is shared polygon
  // geometry, not a renderer-only curve which would disagree with saved maps.
  return referenceContourLand(width, height, reconstructed, Math.min(4, sampleStep / 4))
}

/** Linear interpolation for physical suitability cuts; never a binary-cell outline. */
function referenceContourLand(width: number, height: number, sample: (point: Point) => number, step = 40): PolygonRegion[] {
  const columns = Math.ceil(width / step) + 2, rows = Math.ceil(height / step) + 2
  const sx = width / (columns - 2), sy = height / (rows - 2)
  const values: number[][] = []
  for (let y = 0; y <= rows; y++) values.push(Array.from({ length: columns + 1 }, (_, x) => x === 0 || y === 0 || x === columns || y === rows ? -1 : sample({ x: (x - 1) * sx, y: (y - 1) * sy })))
  type Segment = { a: Point; b: Point; used: boolean }
  const segments: Segment[] = [], at = new Map<string, Segment[]>()
  const key = (p: Point) => `${Math.round(p.x * 1000)}:${Math.round(p.y * 1000)}`
  const add = (a: Point, b: Point) => {
    const segment = { a, b, used: false }; segments.push(segment)
    for (const p of [a, b]) { const group = at.get(key(p)) ?? []; group.push(segment); at.set(key(p), group) }
  }
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const v = [values[y]![x]!, values[y]![x + 1]!, values[y + 1]![x + 1]!, values[y + 1]![x]!]
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


describe('exact natural-cover optimization', () => {
  it('preserves every vertex, hole and ring order for smooth islands, crop borders and infinities', () => {
    const fields: ((p: Point) => number)[] = [
      p => Math.min(73 ** 2 - (p.x - 117) ** 2 - (p.y - 89) ** 2, (p.x - 117) ** 2 + (p.y - 89) ** 2 - 19 ** 2),
      p => 127 - p.x - p.y * .31,
      p => Math.sin(p.x / 18) * Math.cos(p.y / 23) - .1,
      () => -Infinity,
    ]
    for (const sample of fields) for (const step of [16, 24]) {
      const expected = referenceNaturalLand(257, 193, sample, step)
      expect(contourNaturalLand(257, 193, sample, step)).toEqual(expected)
    }
    expect(referenceNaturalLand(257, 193, fields[0]!)[0]!.holes!.length).toBeGreaterThan(0)
  })

  it('preserves boundary touches, exact zeros and both alternating-sign saddle cases', () => {
    const fields: ((p: Point) => number)[] = [
      p => Math.sin(p.x * Math.PI / 20) * Math.cos(p.y * Math.PI / 20),
      p => (Math.floor(p.x / 20) + Math.floor(p.y / 20)) % 2 ? -1 : 2,
      p => p.x - p.y,
      () => 0,
      () => 1,
    ]
    for (const sample of fields) expect(contourLand(140, 100, sample, 20)).toEqual(referenceContourLand(140, 100, sample, 20))
  })
})
