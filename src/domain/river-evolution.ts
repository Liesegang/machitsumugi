import type { Point } from './types'
import { findNeckCutoff, severChannelNeck } from './channel-cutoff.ts'
import type { AbandonedChannel, NeckCutoff } from './channel-cutoff.ts'
import { preventChannelCrossings } from './channel-topology'

export interface ChannelEvolutionInput {
  points: Point[]; widths: number[]; pinned: number[]
  valleyElevation(p: Point): number
  alluvium?(p: Point): number
  allowCutoff?: boolean
  steps?: number
}
export interface ChannelEvolutionResult { points: Point[]; pinned: number[]; maxMigration: number; steps: number; initialPoints: Point[]; initialWidths: number[]; abandoned: AbandonedChannel[] }
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * Bounded kinematic channel migration. Local curvature and an exponentially
 * weighted upstream curvature give outer-bank migration with a downstream lag
 * (Howard–Knutson 1984; Sylvester et al. 2019). Existing valley relief limits bank
 * erosion. This is not a 2D water/sediment solver or a calibrated Japanese river.
 * No sine/random lateral offsets are added to the river centerline.
 */
export function evolveChannel(input: ChannelEvolutionInput): ChannelEvolutionResult {
  const pinnedInput = new Set([0, input.points.length - 1, ...input.pinned]), baseline: Point[] = [], widths: number[] = [], fixed: number[] = []
  for (let i = 0; i < input.points.length - 1; i++) {
    const a = input.points[i]!, b = input.points[i + 1]!, count = Math.max(1, Math.ceil(distance(a, b) / 25))
    if (pinnedInput.has(i)) fixed.push(baseline.length)
    for (let j = 0; j < count; j++) { const t = j / count; baseline.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); widths.push(input.widths[i]! * (1 - t) + input.widths[i + 1]! * t) }
  }
  fixed.push(baseline.length); baseline.push({ ...input.points.at(-1)! }); widths.push(input.widths.at(-1)!)
  const pinned = new Set(fixed), count = baseline.length, reference = baseline.map(input.valleyElevation)
  let points = baseline.map(p => ({ ...p }))
  // Remove one-cell D8 turns without flattening hundreds of metres into chords.
  for (let pass = 0; pass < 12; pass++) {
    const next = points.map(p => ({ ...p }))
    for (let i = 1; i < count - 1; i++) if (!pinned.has(i)) { next[i]!.x = points[i]!.x * .5 + (points[i - 1]!.x + points[i + 1]!.x) * .25; next[i]!.y = points[i]!.y * .5 + (points[i - 1]!.y + points[i + 1]!.y) * .25 }
    points = preventChannelCrossings(points, next, pinned)
  }
  const along = new Float64Array(count), taper = new Float64Array(count).fill(1)
  for (let i = 1; i < count; i++) along[i] = along[i - 1]! + distance(points[i - 1]!, points[i]!)
  for (let i = 0; i < count; i++) for (const j of fixed) taper[i] = Math.min(taper[i]!, clamp(Math.abs(along[i]! - along[j]!) / 140, 0, 1))
  const resolve = (source: Point[]) => source.map((p, i) => {
    if (pinned.has(i)) return p
    const sigma = Math.max(40, widths[i]! * 1.2)
    let x = 0, y = 0, total = 0
    for (let j = Math.max(0, i - 8); j <= Math.min(count - 1, i + 8); j++) { const weight = Math.exp(-((along[j]! - along[i]!) ** 2) / (2 * sigma * sigma)); x += source[j]!.x * weight; y += source[j]!.y * weight; total += weight }
    const t = taper[i]! * taper[i]! * (3 - 2 * taper[i]!)
    return { x: p.x * (1 - t) + x / total * t, y: p.y * (1 - t) + y / total * t }
  })
  const initialPoints = preventChannelCrossings(points, resolve(points), pinned)
  const steps = input.steps ?? (input.alluvium ? 360 : 72)
  let cutoff: NeckCutoff | null = null, completed = 0, lastSafe = points.map(p => ({ ...p }))
  for (let step = 0; step < steps; step++) {
    const previous = points
    const curvature = new Float64Array(count), tangents: Point[] = points.map(() => ({ x: 0, y: 1 }))
    // The flow response is resolved over channel-width scales. Computing it at
    // individual sample vertices creates an unphysical grid-scale instability.
    const filtered = points.map((p, i) => {
      const sigma = Math.max(80, widths[i]! * 3), radius = Math.min(18, Math.ceil(sigma * 2 / 25))
      let x = 0, y = 0, total = 0
      for (let j = Math.max(0, i - radius); j <= Math.min(count - 1, i + radius); j++) { const weight = Math.exp(-((along[j]! - along[i]!) ** 2) / (2 * sigma * sigma)); x += points[j]!.x * weight; y += points[j]!.y * weight; total += weight }
      return total ? { x: x / total, y: y / total } : p
    })
    for (let i = 1; i < count - 1; i++) {
      const a = filtered[i - 1]!, p = filtered[i]!, b = filtered[i + 1]!, length = distance(a, b) || 1
      tangents[i] = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
      curvature[i] = 2 * ((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / (distance(a, p) * distance(p, b) * length || 1)
    }
    const next = points.map(p => ({ ...p })), mobilities = new Float64Array(count)
    let upstream = 0
    for (let i = 1; i < count - 1; i++) {
      const spacing = distance(points[i - 1]!, points[i]!), lag = Math.max(120, widths[i]! * 4), weight = Math.exp(-spacing / lag), nominal = curvature[i]! * widths[i]!
      upstream = upstream * weight + nominal * (1 - weight)
      if (pinned.has(i)) continue
      const tangent = tangents[i]!, nx = -tangent.y, ny = tangent.x
      const grade = Math.abs(input.valleyElevation(points[Math.min(count - 1, i + 2)]!) - input.valleyElevation(points[Math.max(0, i - 2)]!)) / Math.max(1, distance(points[Math.min(count - 1, i + 2)]!, points[Math.max(0, i - 2)]!))
      const mobility = input.alluvium ? clamp((input.alluvium(points[i]!) - .5) / 3, 0, 1) * clamp((.006 - grade) / .004, 0, 1) : 1
      mobilities[i] = mobility
      // Opposite local curvature, plus advected upstream curvature, produces
      // bend translation/growth rather than a decorative periodic wiggle.
      const migration = clamp(18 * (-nominal + 2.5 * upstream), -1, 1) * taper[i]! * mobility
      const p = points[i]!, gradient = (input.valleyElevation({ x: p.x + nx * 12, y: p.y + ny * 12 }) - input.valleyElevation({ x: p.x - nx * 12, y: p.y - ny * 12 })) / 24
      const valleyPull = clamp(-gradient * 6, -.28, .28) * taper[i]! * mobility
      let candidate = { x: p.x + nx * (migration + valleyPull), y: p.y + ny * (migration + valleyPull) }
      const maximum = Math.max(55, widths[i]! * (input.alluvium ? 8 : 4)), displacement = distance(candidate, baseline[i]!)
      if (displacement > maximum) { const t = maximum / displacement; candidate = { x: baseline[i]!.x + (candidate.x - baseline[i]!.x) * t, y: baseline[i]!.y + (candidate.y - baseline[i]!.y) * t } }
      // Bank erosion may cut a low terrace; it cannot cross a high valley wall.
      if (input.valleyElevation(candidate) > reference[i]! + (input.alluvium ? Math.min(12, Math.max(0, input.alluvium(candidate) - 1.2 - widths[i]! * .035)) : 4)) continue
      next[i] = candidate
    }
    // Weak bank/curvature regularisation prevents 25m sample instabilities.
    for (let i = 1; i < count - 1; i++) if (!pinned.has(i)) {
      const weight = .08 * mobilities[i]!
      next[i]!.x = next[i]!.x * (1 - weight) + (points[i - 1]!.x + points[i + 1]!.x) * weight / 2
      next[i]!.y = next[i]!.y * (1 - weight) + (points[i - 1]!.y + points[i + 1]!.y) * weight / 2
    }
    points = next
    if (step % 4 === 3) for (let run = 1; run < fixed.length; run++) {
      const first = fixed[run - 1]!, last = fixed[run]!, lengths = [0]
      // Reparameterisation must not move a resistant reach merely because its
      // D8 samples are uneven. With zero bank mobility its geometry is fixed.
      if (!mobilities.slice(first + 1, last).some(value => value > 0)) continue
      for (let i = first + 1; i <= last; i++) lengths.push(lengths.at(-1)! + distance(points[i - 1]!, points[i]!))
      const redistributed = points.slice(first, last + 1).map(p => ({ ...p }))
      let segment = 1
      for (let i = first + 1; i < last; i++) {
        const target = lengths.at(-1)! * (i - first) / (last - first)
        while (segment + 1 < lengths.length && lengths[segment]! < target) segment++
        const t = (target - lengths[segment - 1]!) / (lengths[segment]! - lengths[segment - 1]! || 1), a = redistributed[segment - 1]!, b = redistributed[segment]!
        points[i] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      }
    }
    points = preventChannelCrossings(previous, points, pinned)
    completed = step + 1
    if (input.alluvium && step % 8 === 7) {
      cutoff = findNeckCutoff({ points, widths, pinned: fixed, elevation: input.valleyElevation, alluvium: input.alluvium })
      if (cutoff) {
        if (input.allowCutoff === false) { points = lastSafe; cutoff = null }
        break
      }
      lastSafe = points.map(p => ({ ...p }))
    }
  }
  const resolved = cutoff ? points : preventChannelCrossings(points, resolve(points), pinned)
  // Arc-length redistribution moves sample indices along an unchanged channel.
  // Measure physical distance to the initial line, not displacement of indices.
  const maxMigration = Math.max(...resolved.map(p => {
    let nearest = Infinity
    for (let i = 1; i < initialPoints.length; i++) {
      const a = initialPoints[i - 1]!, b = initialPoints[i]!, dx = b.x - a.x, dy = b.y - a.y, t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1)
      nearest = Math.min(nearest, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy))
    }
    return nearest
  }))
  if (cutoff) {
    const cut = severChannelNeck(resolved, widths, fixed, cutoff, completed)
    return { points: cut.points, pinned: cut.pinned, maxMigration, steps: completed, initialPoints, initialWidths: widths, abandoned: cut.abandoned ? [cut.abandoned] : [] }
  }
  return { points: resolved, pinned: fixed, maxMigration, steps: completed, initialPoints, initialWidths: widths, abandoned: [] }
}
