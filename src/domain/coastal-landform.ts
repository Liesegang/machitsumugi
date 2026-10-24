import type { CityConfig, Point } from './types'

type CoastType = NonNullable<CityConfig['coastType']>
type Noise = (seed: number, x: number, y: number) => number
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const smooth = (value: number) => value * value * (3 - 2 * value)
const blendMax = (a: number, b: number, radius: number) => {
  const h = Math.max(radius - Math.abs(a - b), 0) / radius
  return Math.max(a, b) + h * h * radius / 4
}
const blendMin = (a: number, b: number, radius: number) => -blendMax(-a, -b, radius)

/** Prescribed relative base-level history for drowned margins. A late rise
 * creates accommodation in the evolved valleys and bays through the actual
 * erosion/deposition sequence; it never restores a water mask afterwards. */
export function coastalSeaLevel(kind: CityConfig['coastType'], iteration: number, iterations: number) {
  const lowstand = kind === 'ria' ? -40 : kind === 'peninsula' ? -80 : 0
  return lowstand * (1 - clamp((iteration - iterations + 16) / 16))
}

/** Positive inside a geological lobe, in metres. Solve the nearest point in
 * one quadrant instead of dividing by a gradient that vanishes at the centre.
 * The axis case includes the ellipse's medial segment and its two equal
 * nearest points; treating it as the major-axis endpoint creates a deep pit. */
export function ellipseDistance(p: Point, centre: Point, rx: number, ry: number, angle = 0) {
  const dx = p.x - centre.x, dy = p.y - centre.y, cosine = Math.cos(angle), sine = Math.sin(angle)
  let x = Math.abs(dx * cosine + dy * sine), y = Math.abs(-dx * sine + dy * cosine), a = rx, b = ry
  if (a < b) { [a, b] = [b, a]; [x, y] = [y, x] }
  if (a === b) return a - Math.hypot(x, y)
  let theta: number
  if (y === 0) theta = x < (a * a - b * b) / a ? Math.acos(a * x / (a * a - b * b)) : 0
  else if (x === 0) theta = Math.PI / 2
  else {
    let lo = 0, hi = Math.PI / 2
    for (let i = 0; i < 26; i++) {
      const middle = (lo + hi) / 2, c = Math.cos(middle), s = Math.sin(middle)
      if ((b * b - a * a) * s * c + a * x * s - b * y * c < 0) lo = middle
      else hi = middle
    }
    theta = (lo + hi) / 2
  }
  const distance = Math.hypot(x - a * Math.cos(theta), y - b * Math.sin(theta))
  return Math.hypot(x / a, y / b) <= 1 ? distance : -distance
}
function ridgeDistance(p: Point, a: Point, b: Point, radiusA: number, radiusB: number) {
  const dx = b.x - a.x, dy = b.y - a.y, t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))
  return radiusA + (radiusB - radiusA) * t - Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t)
}

/** A 2D inherited crust outline, independent of the rectangular compute grid.
 * These are broad land blocks and embayments, not river paths or a mask applied
 * after erosion. Every coastal process uses this same land-positive distance. */
export function coastalLandform(input: { extent: number; seed: number; noise: Noise; coastType?: CityConfig['coastType'] }) {
  const { extent: e, seed, noise } = input, kind = input.coastType ?? 'bay'
  const random = (offset: number) => {
    let value = seed ^ Math.imul(offset, 0x9e3779b9)
    value = Math.imul(value ^ value >>> 16, 0x85ebca6b); value = Math.imul(value ^ value >>> 13, 0xc2b2ae35)
    return ((value ^ value >>> 16) >>> 0) / 4294967295
  }
  const angle = (random(201) - .5) * 1.15, cosine = Math.cos(angle), sine = Math.sin(angle), mirror = random(202) > .5 ? -1 : 1
  const origin = { x: e * (.5 + (random(203) - .5) * .04), y: e * ((kind === 'peninsula' ? .43 : .56) + (random(204) - .5) * .04) }
  const unwarpedWorld = (p: Point): Point => ({ x: origin.x + cosine * mirror * p.x + sine * p.y, y: origin.y - sine * mirror * p.x + cosine * p.y })
  const toLocal = (p: Point): Point => ({ x: mirror * (cosine * (p.x - origin.x) - sine * (p.y - origin.y)), y: sine * (p.x - origin.x) + cosine * (p.y - origin.y) })
  const warp = (p: Point) => ({ x: (noise(seed + 210, p.x / 8000, p.y / 8000) - .5) * 1800, y: (noise(seed + 211, p.x / 8000, p.y / 8000) - .5) * 1800 })
  const toWorld = (p: Point): Point => {
    const target = unwarpedWorld(p); let actual = { ...target }
    // Diagnostic/survey anchors refer to the actual warped land, rather than
    // the pre-warp scaffold. This contract also lets a crop survey find a cape.
    for (let i = 0; i < 12; i++) { const w = warp(actual); actual = { x: target.x - w.x, y: target.y - w.y } }
    return actual
  }
  const width = .78 + random(205) * .5, length = .75 + random(206) * .55
  const rootU = e * (-.16 + random(212) * .07), neckU = rootU + e * (-.03 + random(213) * .06)
  const bendU = neckU + e * (.04 + random(214) * .12), tipU = bendU + e * (.07 + random(215) * .10)
  const spine = kind === 'peninsula' ? [
    { point: { x: rootU, y: -.25 * e }, radius: .083 * e * width },
    { point: { x: neckU, y: .08 * e * length }, radius: .060 * e * width },
    { point: { x: bendU, y: .19 * e * length }, radius: .043 * e * width },
    { point: { x: tipU, y: .23 * e * length }, radius: .031 * e * width },
  ] : []
  const leftAngle = (random(216) - .5) * .6, rightAngle = (random(217) - .5) * .6
  const leftRx = e * (.09 + random(218) * .045), leftRy = e * (.13 + random(219) * .08), rightRx = e * (.08 + random(220) * .055)
  const rightY = e * (-.01 + random(221) * .05), rightRy = Math.max(1100, .23 * e * length - .09 * e - rightY)
  const spanX = (rx: number, ry: number, a: number) => Math.hypot(rx * Math.cos(a), ry * Math.sin(a))
  const bays = kind === 'peninsula' ? [
    { point: { x: Math.min(rootU, neckU) - spanX(leftRx, leftRy, leftAngle) - .06 * e * width, y: e * (.01 + random(222) * .04) }, rx: leftRx, ry: leftRy, angle: leftAngle },
    { point: { x: Math.max(rootU, neckU) + spanX(rightRx, rightRy, rightAngle) + .054 * e * width, y: rightY }, rx: rightRx, ry: rightRy, angle: rightAngle },
  ] : [
    { point: { x: e * (-.25 + random(207) * .14), y: e * (-.01 + random(223) * .06) }, rx: e * (.075 + random(224) * .065), ry: e * (kind === 'ria' ? .13 + random(225) * .12 : kind === 'delta' ? .045 + random(225) * .065 : .07 + random(225) * .12), angle: (random(226) - .5) * .9 },
    { point: { x: e * (.16 + random(208) * .18), y: e * (.01 + random(227) * .05) }, rx: e * (.075 + random(228) * .065), ry: e * (kind === 'ria' ? .12 + random(229) * .12 : kind === 'delta' ? .045 + random(229) * .065 : .07 + random(229) * .11), angle: (random(230) - .5) * .9 },
  ]
  const headlands = kind === 'peninsula' ? [] : [
    { a: { x: e * (-.08 + random(231) * .08), y: -.25 * e }, b: { x: e * (-.04 + random(232) * .12), y: e * (kind === 'delta' ? .02 + random(233) * .045 : .06 + random(233) * .10) }, ra: e * (.055 + random(234) * .025), rb: e * (kind === 'ria' ? .02 + random(235) * .02 : .03 + random(235) * .035) },
    { a: { x: e * (.33 + random(236) * .13), y: -.25 * e }, b: { x: e * (.25 + random(237) * .16), y: e * (.02 + random(238) * .07) }, ra: e * (.045 + random(239) * .03), rb: e * (.025 + random(240) * .03) },
  ]
  const distance = (p: Point) => {
    // Gentle 2D warp preserves kilometre-scale width meaning. It is shared by
    // the land, shore, shelf and uplift field, never a separate coast wiggle.
    const w = warp(p), q = toLocal({ x: p.x + w.x, y: p.y + w.y })
    let d = ellipseDistance(q, { x: 0, y: -.58 * e }, 1.1 * e, .58 * e)
    for (const bay of bays) d = blendMin(d, -ellipseDistance(q, bay.point, bay.rx, bay.ry, bay.angle), 250)
    for (const headland of headlands) d = blendMax(d, ridgeDistance(q, headland.a, headland.b, headland.ra, headland.rb), 300)
    for (let i = 1; i < spine.length; i++) d = blendMax(d, ridgeDistance(q, spine[i - 1]!.point, spine[i]!.point, spine[i - 1]!.radius, spine[i]!.radius), 300)
    return d
  }
  return { distance, toWorld, origin, angle, peninsula: spine.map(part => ({ point: toWorld(part.point), radius: part.radius })) }
}

/** Continuous inherited shoreface, shelf and outer receiving slope measured
 * away from the same 2D coast. The offshore profile is not a finished coastline:
 * uplift, fluvial supply and marine work subsequently evolve the actual DEM. */
export function coastalBedProfile(distance: number, kind: CoastType = 'bay', relief?: CityConfig['relief']) {
  const landGrade = kind === 'delta' ? .0025 : kind === 'ria' ? .008 : .006
  // Rocky peninsulas have a steeper shoreface, a resolved narrow inner shelf
  // and deep adjoining embayments. A 2km-wide bay on the broad bay shelf was
  // only 35–45m deep and filled with ~70m of conserved fluvial sediment over
  // the simulated million years. This initial margin has ~150m at 2km and
  // ~220m at 2.6km, without changing subsequent transport or masking deposits.
  const shorefaceGrade = kind === 'peninsula' ? .065 : .025
  const shelfGrade = kind === 'ria' || kind === 'peninsula' ? .025 : kind === 'delta' ? .012 : .016
  const shelfWidth = kind === 'ria' ? 1900 : kind === 'delta' ? 6000 : kind === 'peninsula' ? 1200 : 4000
  const outerGrade = (kind === 'ria' ? .15 : kind === 'delta' ? .055 : kind === 'peninsula' ? .12 : .08) * (relief === 'mountains' ? 1.7 : 1)
  const hinge = (x: number) => x <= -300 ? 0 : x >= 300 ? x : (x + 300) ** 2 / 1200
  const offshore = -distance
  const elevation = -landGrade * offshore - (shorefaceGrade - landGrade) * (hinge(offshore) - hinge(0)) - (shelfGrade - shorefaceGrade) * hinge(offshore - 600) - (outerGrade - shelfGrade) * hinge(offshore - shelfWidth)
  // A real active margin may uplift its shallow submerged bed as well. Taper
  // the prescribed crust field across the coast, rather than suppressing it
  // whenever a cell happens to be ocean in a later erosion iteration.
  const upliftWidth = kind === 'delta' ? 9000 : kind === 'ria' ? 4500 : 6000
  return { elevation, upliftWeight: smooth(clamp((distance + 1200) / upliftWidth)), landWeight: smooth(clamp(distance / 4000)), detailWeight: smooth(clamp(distance / 1600)), shelfWidth }
}
