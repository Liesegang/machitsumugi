import type { Point } from './types'
import type { PolygonRegion } from './geometry'
import type { PlanningTerrain, SurveyedBridgeSpan } from './road-planner'
import { boundsOf, corridorPolygon, distance, intersectRegions, overlaps, regionArea } from './geometry'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'

export interface LayoutMainCivilBridge {
  id: string
  point: Point
  bankA: Point
  bankB: Point
  riverId: string
  /** Same meaning as native candidates: perpendicular channel width. */
  width: number
  carriagewayWidth: number
  wetLength: number
  bearing: number
  cost: number
  design: 'main-civil'
}
export interface LayoutMainCivilSurveyInput {
  guides: readonly Point[][]
  width: number
  waterRegions: readonly PolygonRegion[]
  terrain: Pick<PlanningTerrain, 'waterAt' | 'seaAt' | 'elevation' | 'channelAt'>
  rowAllows: (points: Point[], width: number) => boolean
  railwayAllows: (points: Point[], width: number) => boolean
  /** Regional.validate geometry/water/sea/width only; deck grade is measured
   * below with the explicit surveyed span, never with river-bed elevations. */
  bridgeAllows: (points: Point[], width: number) => boolean
  maximumCandidates?: number
  maximumWetLength?: number
}

/** These are only geographic surveys, never mandatory highway waypoints. */
export function layoutMainCivilGuides(start: Point, goal: Point): Point[][] {
  const length = distance(start, goal), nx = -(goal.y - start.y) / length, ny = (goal.x - start.x) / length
  return [0, -350, 350, -700, 700].map(offset => !offset ? [start, goal] : [start, ...[.33, .67].map(t => ({ x: start.x + (goal.x - start.x) * t + nx * offset, y: start.y + (goal.y - start.y) * t + ny * offset })), goal])
}

/** The desired ROAD bearing defines a civil crossing. Exact clipped water
 * strips find even a narrow skew creek; the old channel-normal pairs remain
 * separate alternatives. No accepted pavement is moved or cosmetically bent. */
export function surveyLayoutMainCivilCrossings(input: LayoutMainCivilSurveyInput): LayoutMainCivilBridge[] {
  const candidates: LayoutMainCivilBridge[] = [], half = input.width / 2 + .75
  const water = input.waterRegions.map(region => ({ region, bounds: boundsOf(region.polygon) }))
  const limit = Math.max(0, Math.min(32, Math.floor(input.maximumCandidates ?? 24)))
  for (const [guideIndex, guide] of input.guides.slice(0, 5).entries()) for (let i = 1; i < guide.length; i++) {
    const first = guide[i - 1]!, last = guide[i]!, length = distance(first, last)
    if (length < 20) continue
    const ux = (last.x - first.x) / length, uy = (last.y - first.y) / length, bearing = Math.atan2(uy, ux)
    const at = (s: number, side = 0): Point => ({ x: first.x + ux * s - uy * side, y: first.y + uy * s + ux * side })
    const strip = { polygon: corridorPolygon(first, last, half) }, bounds = boundsOf(strip.polygon)
    const intervals = water.filter(item => overlaps(bounds, item.bounds)).flatMap(item => intersectRegions(strip, item.region).filter(region => regionArea(region) > .01).map(region => {
      const positions = region.polygon.map(point => (point.x - first.x) * ux + (point.y - first.y) * uy)
      return [Math.min(...positions), Math.max(...positions)] as [number, number]
    })).sort((a, b) => a[0] - b[0])
    const joined: [number, number][] = []
    for (const interval of intervals) {
      const previous = joined.at(-1)
      if (previous && interval[0] <= previous[1] + 2) previous[1] = Math.max(previous[1], interval[1])
      else joined.push([...interval])
    }
    for (const [wetStart, wetEnd] of joined) {
      const wetLength = wetEnd - wetStart, point = at((wetStart + wetEnd) / 2), channel = input.terrain.channelAt?.(point)
      if (wetLength <= .01 || wetLength > (input.maximumWetLength ?? 320) || !input.terrain.waterAt(point) || input.terrain.seaAt?.(point) || !channel?.riverId || channel.bankDistance > 1) continue
      // Full-width wet samples must belong to the same surveyed water body.
      // A confluence needs its own combined structure, not a false single ID.
      let identified = true
      const waterSamples = Math.max(2, Math.ceil(wetLength / 2))
      for (let n = 0; n <= waterSamples && identified; n++) for (const side of [-half, 0, half]) {
        const q = at(wetStart + wetLength * n / waterSamples, side)
        if (input.terrain.seaAt?.(q) || input.terrain.waterAt(q) && input.terrain.channelAt?.(q)?.riverId !== channel.riverId) { identified = false; break }
      }
      if (!identified) continue
      for (const margin of [25, 40, 60, 90]) {
        const a = wetStart - margin, b = wetEnd + margin
        if (a < 20 || b > length - 20) break
        if (joined.some(([lo, hi]) => (lo !== wetStart || hi !== wetEnd) && hi > a && lo < b)) continue
        const bankA = at(a), bankB = at(b), pads = [[at(a - 20), bankA], [bankB, at(b + 20)]]
        const dryPads = pads.every(points => {
          const pad = { polygon: corridorPolygon(points[0]!, points[1]!, half) }, padBounds = boundsOf(pad.polygon)
          const samples = Array.from({ length: 11 }, (_, n) => ({ x: points[0]!.x + (points[1]!.x - points[0]!.x) * n / 10, y: points[0]!.y + (points[1]!.y - points[0]!.y) * n / 10 }))
          return !water.some(item => overlaps(padBounds, item.bounds) && intersectRegions(pad, item.region).some(region => regionArea(region) > .01)) && points.every(p => !input.terrain.waterAt(p) && !input.terrain.seaAt?.(p)) && surveyedRoadGradeAllowed({ points: samples }, .09, input.terrain.elevation)
        })
        const span: SurveyedBridgeSpan = { bankA, bankB, riverId: channel.riverId }, pavement = [at(a - 20), bankA, bankB, at(b + 20)]
        if (!dryPads || !surveyedRoadGradeAllowed({ points: pavement, surveyedBridgeSpans: [span] }, .09, input.terrain.elevation) || !input.bridgeAllows(pavement, input.width) || !input.rowAllows(pavement, input.width) || !input.railwayAllows(pavement, input.width)) continue
        if (candidates.some(other => other.riverId === channel.riverId && distance(other.point, point) < 20 && Math.abs(Math.sin(other.bearing - bearing)) < .05)) break
        const identity = [bankA, bankB].map(bank => `${bank.x.toFixed(4)},${bank.y.toFixed(4)}`).join('>')
        candidates.push({ id: `main-civil-${guideIndex}-${i}:${identity}`, point, bankA, bankB, riverId: channel.riverId, width: channel.width, carriagewayWidth: input.width, wetLength, bearing, design: 'main-civil', cost: distance(bankA, bankB) * 13 + 420 })
        break
      }
    }
  }
  // The direct-axis surveys precede broad alternatives. Existing crossings
  // are merged by the caller afterwards, and remain available as fallback.
  return candidates.slice(0, limit)
}
