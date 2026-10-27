import type { Area, Point } from './types'
import type { TerrainModel } from './terrain'
import type { PolygonRegion } from './geometry'
import { boundsOf, distance, intersectRegions, overlaps, pointInRegion, rectangle, regionArea } from './geometry'
import { dissolveContinuousCover, subtractContinuousCover } from './continuous-city-cover'

export interface ContinuousRiverMarginInput {
  width: number
  height: number
  terrain: Pick<TerrainModel, 'areas' | 'elevation' | 'waterAt' | 'channelAt'>
}
export interface ContinuousRiverMargins {
  /** Private acquisition only: these are neither water nor transport barriers. */
  reserves: PolygonRegion[]
  areas: Area[]
  metrics: { riverAreas: number; shorelineSamples: number; groundArea: number; minimumWidth: number; maximumWidth: number }
}
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/** Survey dry riverbanks, rather than offsetting a centreline or painting a
 * rectangular flood zone. Wider low banks retain flood benches and working
 * room; a raised terrace stops that expansion close to the actual shoreline.
 * The source water rings and islands are never changed. */
export function buildContinuousRiverMargins({ width, height, terrain }: ContinuousRiverMarginInput): ContinuousRiverMargins {
  const rivers = terrain.areas.filter(area => area.kind === 'water' && (area.id === 'river' || area.id.startsWith('river-')))
  const pieces: PolygonRegion[] = []
  const metrics = { riverAreas: rivers.length, shorelineSamples: 0, groundArea: 0, minimumWidth: Infinity, maximumWidth: 0 }
  const marginAt = (shore: Point, normal: Point) => {
    const channel = terrain.channelAt(shore)
    if (!channel || !Number.isFinite(channel.width) || !Number.isFinite(channel.surfaceElevation)) return 0
    const minimum = clamp(1.5 + Math.sqrt(Math.max(0, channel.width)) * .28, 2, 5.5)
    const room = clamp(2 + channel.width * .22, minimum, 48), level = clamp(.7 + Math.sqrt(Math.max(0, channel.width)) * .14, 1, 3.5)
    const rise = (offset: number) => {
      const point = { x: shore.x + normal.x * offset, y: shore.y + normal.y * offset }
      return terrain.waterAt(point) ? Infinity : terrain.elevation(point) - channel.surfaceElevation
    }
    let limit = minimum, previous = rise(minimum)
    if (previous < level) for (let offset = minimum + 2; ; offset += 2) {
      const next = Math.min(room, offset), value = rise(next)
      if (!Number.isFinite(value) || value >= level) {
        if (Number.isFinite(value)) limit += (next - limit) * clamp((level - previous) / Math.max(.0001, value - previous), 0, 1)
        break
      }
      limit = next; previous = value
      if (next === room) break
    }
    metrics.shorelineSamples++; metrics.minimumWidth = Math.min(metrics.minimumWidth, limit); metrics.maximumWidth = Math.max(metrics.maximumWidth, limit)
    return limit
  }
  for (const river of rivers) for (const ring of [river.polygon, ...river.holes ?? []]) {
    const sections: { a: Point; b: Point; outerA: Point; outerB: Point }[] = []
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index]!, b = ring[(index + 1) % ring.length]!, length = distance(a, b)
      if (length < .001) continue
      const count = Math.max(1, Math.ceil(length / 16)), tangent = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }, midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      let normal = { x: -tangent.y, y: tangent.x }
      if (pointInRegion({ x: midpoint.x + normal.x * .1, y: midpoint.y + normal.y * .1 }, river)) normal = { x: -normal.x, y: -normal.y }
      for (let step = 0; step < count; step++) {
        const from = { x: a.x + (b.x - a.x) * step / count, y: a.y + (b.y - a.y) * step / count }, to = { x: a.x + (b.x - a.x) * (step + 1) / count, y: a.y + (b.y - a.y) * (step + 1) / count }
        const first = marginAt(from, normal), last = marginAt(to, normal)
        if (!first || !last) continue
        const outerA = { x: from.x + normal.x * first, y: from.y + normal.y * first }, outerB = { x: to.x + normal.x * last, y: to.y + normal.y * last }
        pieces.push({ polygon: [from, to, outerB, outerA] }); sections.push({ a: from, b: to, outerA, outerB })
      }
    }
    // Join neighbouring surveyed bank sections. No global raster, tile edge or
    // independent decorative noise participates in the outside boundary.
    for (let index = 0; index < sections.length; index++) {
      const before = sections[index]!, after = sections[(index + 1) % sections.length]!
      if (distance(before.b, after.a) < .001) pieces.push({ polygon: [before.b, before.outerB, after.outerA] })
    }
  }
  const crop = { polygon: rectangle(0, 0, width, height) }, water = terrain.areas.filter(area => area.kind === 'water')
  const reserves = dissolveContinuousCover(pieces, { batchVertices: 3000 }).flatMap(part => intersectRegions(part, crop)).flatMap(part => subtractContinuousCover(part, water)).filter(part => regionArea(part) > .01)
  metrics.groundArea = reserves.reduce((sum, part) => sum + regionArea(part), 0)
  if (!metrics.shorelineSamples) metrics.minimumWidth = 0
  const areas: Area[] = reserves.map((part, index) => ({ ...part, id: `land-river-margin-${index}`, kind: 'park', landUse: 'meadow' }))
  return { reserves, areas, metrics }
}

/** Public roads may cross or follow a bank. Clear their actual ground and
 * civic/station grounds from the visible bank cover, without treating the
 * private-housing setback as a transport reservation. */
export function continuousRiverMarginCover(margins: ContinuousRiverMargins, occupied: readonly PolygonRegion[]): Area[] {
  const indexed = occupied.map(region => ({ region, bounds: boundsOf(region.polygon) }))
  return margins.areas.flatMap(area => {
    const bounds = boundsOf(area.polygon), cuts = indexed.filter(entry => overlaps(bounds, entry.bounds)).map(entry => entry.region)
    return subtractContinuousCover(area, cuts).map((region, index) => ({ ...area, ...region, id: `${area.id}-part-${index}` }))
  })
}
