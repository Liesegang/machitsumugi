import type { Point } from './types'
import type { WaterRegion } from './terrain-water'
import { regionQuery } from './region-query'
import { distanceToSegment, pointInRegion } from './geometry'

interface ShoreSegment { a: Point; b: Point; ring: number; arc: number; length: number; perimeter: number }
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

function interiorWitness(region: WaterRegion): Point | null {
  const rings = [region.polygon, ...(region.holes ?? [])], ys = region.polygon.map(p => p.y), low = Math.min(...ys), high = Math.max(...ys)
  let point: Point | null = null, widest = 0
  for (let row = 0; row < 17; row++) {
    const y = low + (high - low) * (row + .5) / 17, crossings: number[] = []
    for (const ring of rings) for (let i = 0; i < ring.length; i++) { const a = ring[i]!, b = ring[(i + 1) % ring.length]!; if ((a.y > y) !== (b.y > y)) crossings.push(a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y)) }
    crossings.sort((a, b) => a - b)
    for (let i = 1; i < crossings.length; i += 2) if (crossings[i]! - crossings[i - 1]! > widest) { widest = crossings[i]! - crossings[i - 1]!; point = { x: (crossings[i]! + crossings[i - 1]!) / 2, y } }
  }
  return point
}

/** Counts alone cannot detect a lost island replaced by another island.
 * Preserve actual component/hole interior locations and bound both directions
 * of boundary displacement, including narrow bays' deep shoreline vertices. */
export function shoreReconstructionPreserves(source: WaterRegion[], candidate: WaterRegion[], cellSize: number): boolean {
  if (candidate.length !== source.length || candidate.reduce((sum, sea) => sum + (sea.holes?.length ?? 0), 0) !== source.reduce((sum, sea) => sum + (sea.holes?.length ?? 0), 0)) return false
  const positionsSurvive = (from: WaterRegion[], to: WaterRegion[]) => from.every(region => {
    const point = interiorWitness(region)
    if (point && !to.some(other => pointInRegion(point, other))) return false
    return (region.holes ?? []).every(hole => { const point = interiorWitness({ polygon: hole }); return !point || to.some(other => (other.holes ?? []).some(ring => pointInRegion(point, { polygon: ring }))) })
  })
  if (!positionsSurvive(source, candidate) || !positionsSurvive(candidate, source)) return false
  const close = (from: WaterRegion[], to: WaterRegion[]) => {
    const bins = new Map<string, { a: Point; b: Point }[]>(), limit = cellSize / 2 + .01
    for (const region of to) for (const ring of [region.polygon, ...(region.holes ?? [])]) for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!
      for (let y = Math.floor(Math.min(a.y, b.y) / cellSize); y <= Math.floor(Math.max(a.y, b.y) / cellSize); y++) for (let x = Math.floor(Math.min(a.x, b.x) / cellSize); x <= Math.floor(Math.max(a.x, b.x) / cellSize); x++) { const key = `${x}:${y}`, bucket = bins.get(key) ?? []; bucket.push({ a, b }); bins.set(key, bucket) }
    }
    for (const region of from) for (const ring of [region.polygon, ...(region.holes ?? [])]) for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!
      for (const p of [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }]) {
        const x = Math.floor(p.x / cellSize), y = Math.floor(p.y / cellSize)
        let found = false
        for (let dy = -1; dy <= 1 && !found; dy++) for (let dx = -1; dx <= 1 && !found; dx++) found = (bins.get(`${x + dx}:${y + dy}`) ?? []).some(segment => distanceToSegment(p, segment.a, segment.b) <= limit)
        if (!found) return false
      }
    }
    return true
  }
  return close(source, candidate) && close(candidate, source)
}

/** A bounded sub-cell interface reconstruction, never an elevation update.
 * A thin settled water film can make a PCHIP zero contour follow whole finite
 * volume cell faces. Convolving its signed distance removes that grid bias.
 * The interface may move by at most half a physical cell, less near opposing
 * shores, and only within the low shore's +/-0.45m vertical uncertainty band.
 * Offshore bed, solid volume, rock elevations and subsequent harbour works
 * remain unchanged. Every water consumer uses the reconstructed polygons. */
export function finiteVolumeShoreField(input: {
  regions: WaterRegion[]; width: number; height: number; columns: number; rows: number; origin: Point
  cellSize: number; elevation(p: Point): number
}): (p: Point) => number {
  const { columns, rows, origin, cellSize } = input, stride = columns + 1, sx = input.width / columns, sy = input.height / rows, cap = cellSize * 2
  const wet = regionQuery(input.regions), bins = new Map<string, ShoreSegment[]>(), segments: ShoreSegment[] = []
  let ringId = 0
  for (const region of input.regions) for (const ring of [region.polygon, ...(region.holes ?? [])]) {
    const lengths = ring.map((a, i) => Math.hypot(ring[(i + 1) % ring.length]!.x - a.x, ring[(i + 1) % ring.length]!.y - a.y)), perimeter = lengths.reduce((a, b) => a + b, 0)
    let arc = 0
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!, segment = { a, b, ring: ringId, arc, length: lengths[i]!, perimeter }; arc += segment.length; segments.push(segment)
      for (let y = Math.floor(Math.min(a.y, b.y) / cellSize); y <= Math.floor(Math.max(a.y, b.y) / cellSize); y++) for (let x = Math.floor(Math.min(a.x, b.x) / cellSize); x <= Math.floor(Math.max(a.x, b.x) / cellSize); x++) { const key = `${x}:${y}`, bucket = bins.get(key) ?? []; bucket.push(segment); bins.set(key, bucket) }
    }
    ringId++
  }
  if (!segments.length) return input.elevation
  const nearest = (p: Point, segment: ShoreSegment) => {
    const dx = segment.b.x - segment.a.x, dy = segment.b.y - segment.a.y, t = clamp(((p.x - segment.a.x) * dx + (p.y - segment.a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1)
    return { distance: Math.hypot(p.x - segment.a.x - t * dx, p.y - segment.a.y - t * dy), arc: segment.arc + t * segment.length }
  }
  const original = new Float32Array(stride * (rows + 1)), displacement = new Float32Array(original.length)
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) {
    const p = { x: origin.x + x * sx, y: origin.y + y * sy }, i = y * stride + x, bx = Math.floor(p.x / cellSize), by = Math.floor(p.y / cellSize), candidates = new Set<ShoreSegment>()
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) for (const segment of bins.get(`${bx + dx}:${by + dy}`) ?? []) candidates.add(segment)
    let best: ShoreSegment | undefined, distance = cap, at = 0
    for (const segment of candidates) { const hit = nearest(p, segment); if (hit.distance < distance) { distance = hit.distance; best = segment; at = hit.arc } }
    original[i] = (wet(p) ? -1 : 1) * distance
    let limit = cellSize / 2
    if (best && distance < cellSize) for (const segment of candidates) {
      const arcGap = Math.abs(segment.arc + segment.length / 2 - at), around = Math.min(arcGap, Math.max(0, best.perimeter - arcGap))
      if (segment.ring === best.ring && around < Math.min(cellSize * 2, best.perimeter * .22)) continue
      // Keep narrow bays, channels, islands and land necks open. Independent
      // banks may each consume at most a quarter of the opposing-shore gap.
      limit = Math.min(limit, Math.max(0, nearest(p, segment).distance - distance) / 4)
    }
    displacement[i] = limit
  }
  const horizontal = new Float32Array(original.length), filtered = original.slice(), kernel = [1, 4, 6, 4, 1]
  // Three small separable passes approximate an isotropic signed-distance
  // convolution at ~0.42physical cells. The displacement bound below remains
  // independent of the number of samples and convolution support.
  for (let pass = 0; pass < 3; pass++) {
    horizontal.fill(0)
    for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) for (let k = -2; k <= 2; k++) horizontal[y * stride + x] += filtered[y * stride + clamp(x + k, 0, columns)]! * kernel[k + 2]! / 16
    for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) {
      let value = 0
      for (let k = -2; k <= 2; k++) value += horizontal[clamp(y + k, 0, rows) * stride + x]! * kernel[k + 2]! / 16
      filtered[y * stride + x] = value
    }
  }
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) {
    const i = y * stride + x
    filtered[i] = original[i]! + clamp(filtered[i]! - original[i]!, -displacement[i]!, displacement[i]!)
  }
  const cubic = (a: number, b: number, c: number, d: number, t: number) => {
    const left = b - a, middle = c - b, right = d - c, first = left * middle > 0 ? 2 * left * middle / (left + middle) : 0, last = middle * right > 0 ? 2 * middle * right / (middle + right) : 0, square = t * t, cube = square * t
    return (2 * cube - 3 * square + 1) * b + (cube - 2 * square + t) * first + (-2 * cube + 3 * square) * c + (cube - square) * last
  }
  const sample = (field: Float32Array, p: Point) => {
    const gx = clamp((p.x - origin.x) / sx, 0, columns), gy = clamp((p.y - origin.y) / sy, 0, rows), x = Math.floor(gx), y = Math.floor(gy), values: number[] = []
    for (let j = -1; j <= 2; j++) { const row = clamp(y + j, 0, rows) * stride; values.push(cubic(...[-1, 0, 1, 2].map(k => field[row + clamp(x + k, 0, columns)]!) as [number, number, number, number], gx - x)) }
    return cubic(values[0]!, values[1]!, values[2]!, values[3]!, gy - y)
  }
  return p => {
    const physical = input.elevation(p), smooth = sample(filtered, p), delta = cellSize / 4
    const gradient = Math.hypot(input.elevation({ x: p.x + delta, y: p.y }) - input.elevation({ x: p.x - delta, y: p.y }), input.elevation({ x: p.x, y: p.y + delta }) - input.elevation({ x: p.x, y: p.y - delta })) / (2 * delta)
    // The terrain renderer offsets the shared sea plane by0.5m; retain the
    // actual shoreline on steeper/higher ground and keep reconstructed shore
    // elevations inside that offset instead of painting over exposed cliffs.
    const lowShore = clamp(1 - Math.abs(physical) / .45, 0, 1) * clamp(1 - gradient / .04, 0, 1)
    const base = clamp(physical / Math.max(gradient, .0001), -cap, cap)
    return base + (smooth - base) * lowShore
  }
}
