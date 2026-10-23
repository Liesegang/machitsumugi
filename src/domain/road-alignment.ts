import type { Point } from './types'

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const mix = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/** Sampling follows distance along the physical alignment, independent of later junction vertices. */
export function resampleAlignment(points: Point[], spacing: number): Point[] {
  const result: Point[] = [{ ...points[0]! }]
  let remaining = spacing
  for (let i = 1; i < points.length; i++) {
    let a = points[i - 1]!, length = distance(a, points[i]!)
    while (length >= remaining && length > 1e-9) { a = mix(a, points[i]!, remaining / length); result.push(a); length = distance(a, points[i]!); remaining = spacing }
    remaining -= length
  }
  const last = points.at(-1)!
  if (distance(result.at(-1)!, last) < spacing * .15 && result.length > 1) result[result.length - 1] = { ...last }
  else if (distance(result.at(-1)!, last) > 1e-7) result.push({ ...last })
  return result
}

/** Circumcircle radius measured at equal chainage, so a split junction cannot fake a sharp curve. */
export function alignmentDiagnostics(points: Point[], spacing = 10) {
  const samples = resampleAlignment(points, spacing)
  let minimumRadius = Infinity, maximumDeflection = 0, curvedLength = 0, length = 0
  for (let i = 1; i < samples.length - 1; i++) {
    const a = samples[i - 1]!, b = samples[i]!, c = samples[i + 1]!, ab = distance(a, b), bc = distance(b, c), ac = distance(a, c)
    const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
    const angle = Math.abs(Math.atan2(cross, (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)))
    maximumDeflection = Math.max(maximumDeflection, angle)
    if (cross > 1e-7) minimumRadius = Math.min(minimumRadius, ab * bc * ac / (2 * cross))
    if (angle > .003) curvedLength += (ab + bc) / 2
  }
  for (let i = 1; i < samples.length; i++) length += distance(samples[i - 1]!, samples[i]!)
  return { minimumRadius, maximumDeflection, curvedLength, length }
}

/** Uniform cubic B-spline: one canonical C2 curve, not a render-only smoothing layer. */
export function splineAlignment(controls: Point[], spacing = 5): Point[] {
  if (controls.length < 3) return resampleAlignment(controls, spacing)
  const p = [controls[0]!, controls[0]!, ...controls, controls.at(-1)!, controls.at(-1)!], result: Point[] = []
  for (let i = 0; i < p.length - 3; i++) {
    const a = p[i]!, b = p[i + 1]!, c = p[i + 2]!, d = p[i + 3]!, n = Math.max(4, Math.ceil((distance(a, b) + distance(b, c) + distance(c, d)) / spacing))
    for (let j = i ? 1 : 0; j <= n; j++) {
      const t = j / n, aa = (1 - t) ** 3 / 6, bb = (3 * t ** 3 - 6 * t * t + 4) / 6, cc = (-3 * t ** 3 + 3 * t * t + 3 * t + 1) / 6, dd = t ** 3 / 6
      result.push({ x: a.x * aa + b.x * bb + c.x * cc + d.x * dd, y: a.y * aa + b.y * bb + c.y * cc + d.y * dd })
    }
  }
  return resampleAlignment(result, spacing)
}

/** Quintic endpoint connector: each pair of collinear controls preserves the
 * approach tangent and zero endpoint curvature. It is useful for a short slip
 * road where a coarse geographic corridor cannot represent the turning bay. */
export function tangentAlignment(start: Point, goal: Point, startHeading: number, endHeading: number, firstHandle: number, lastHandle: number, spacing = 5): Point[] {
  const move = (p: Point, angle: number, length: number): Point => ({ x: p.x + Math.cos(angle) * length, y: p.y + Math.sin(angle) * length })
  const controls = [start, move(start, startHeading, firstHandle * .5), move(start, startHeading, firstHandle), move(goal, endHeading, -lastHandle), move(goal, endHeading, -lastHandle * .5), goal]
  const count = Math.max(30, Math.ceil(controls.slice(1).reduce((sum, p, i) => sum + distance(p, controls[i]!), 0) / (spacing * .5))), curve: Point[] = []
  for (let i = 0; i <= count; i++) {
    const t = i / count, u = 1 - t, weights = [u ** 5, 5 * u ** 4 * t, 10 * u ** 3 * t ** 2, 10 * u ** 2 * t ** 3, 5 * u * t ** 4, t ** 5]
    curve.push(controls.reduce((p, control, j) => ({ x: p.x + control.x * weights[j]!, y: p.y + control.y * weights[j]! }), { x: 0, y: 0 }))
  }
  return resampleAlignment(curve, spacing)
}

/** Pre-urban acquisition costs: inherited, irregular landholdings are shared by all projects.
 * This field never displaces a road after planning and never generates a citywide street grid. */
export function createLandholdingCost(width: number, height: number, seed: string): (p: Point) => number {
  let h = 2166136261
  for (const c of `${seed}:inherited-land`) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  const random = () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 }
  const sites: (Point & { scale: number })[] = [], count = Math.ceil(width * height / 230000)
  for (let tries = 0; sites.length < count && tries < count * 30; tries++) {
    const p = { x: random() * width, y: random() * height, scale: .85 + random() * .3 }
    if (sites.every(q => distance(p, q) > 240)) sites.push(p)
  }
  return p => {
    let first = Infinity, second = Infinity
    for (const site of sites) { const d = distance(site, p) * site.scale; if (d < first) { second = first; first = d } else if (d < second) second = d }
    // Following an old ownership boundary avoids buying through the middle of a holding.
    return 1.6 * (1 - Math.exp(-Math.max(0, second - first) / 70))
  }
}
