import type { Point } from './types'
import { alignmentDiagnostics } from './road-alignment'
import type { PlannedRoute, RoadPlanner } from './road-planner'
import type { RegionalRoadPlanner } from './regional-road-planner'
import { onSurveyedBridge, surveyedRoadGradeAllowed } from './surveyed-road-profile'

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y)
const mix = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/** Portals come from upstream/downstream intersections of the actual valley
 * with the crop, not two compass rays extended from a mountain settlement. */
interface ValleyBoundaryInput { river: Point[]; origin: Point; width: number; height: number; roadWidth: number; planner: Pick<RoadPlanner, 'suitable'> }
function surveyValleyBoundary(input: ValleyBoundaryInput): { directions: Point[][]; headwaterPass: boolean } {
  const { river, origin, width, height, roadWidth, planner } = input
  if (river.length < 2) return { directions: [[], []], headwaterPass: false }
  let along = 0, home = { along: 0, side: 0, distance: Infinity }
  const crossings: { point: Point; along: number; dx: number; dy: number; axis: 'x' | 'y' }[] = []
  for (let i = 1; i < river.length; i++) {
    const a = river[i - 1]!, b = river[i]!, length = distance(a, b), dx = b.x - a.x, dy = b.y - a.y
    if (length < .001) continue
    const t = Math.max(0, Math.min(1, ((origin.x - a.x) * dx + (origin.y - a.y) * dy) / (length * length))), nearest = mix(a, b, t), d = distance(nearest, origin)
    if (d < home.distance) home = { along: along + t * length, side: dx * (origin.y - nearest.y) - dy * (origin.x - nearest.x), distance: d }
    for (const [axis, coordinate] of [['x', 28], ['x', width - 28], ['y', 28], ['y', height - 28]] as const) {
      const divisor = axis === 'x' ? dx : dy
      if (Math.abs(divisor) < 1e-8) continue
      const fraction = (coordinate - a[axis]) / divisor
      if (fraction < 0 || fraction > 1) continue
      const point = mix(a, b, fraction)
      if (point.x < 27.9 || point.x > width - 27.9 || point.y < 27.9 || point.y > height - 27.9) continue
      if (!crossings.some(other => distance(other.point, point) < 1)) crossings.push({ point, along: along + fraction * length, dx, dy, axis })
    }
    along += length
  }
  let headwaterPass = false
  const directions = [-1, 1].map(direction => {
    const results: Point[] = []
    for (const crossing of crossings.filter(site => (site.along - home.along) * direction > 250).sort((a, b) => Math.abs(a.along - home.along) - Math.abs(b.along - home.along))) {
      for (const offset of [60, 100, 160, 240, 360, 500]) for (const sign of [-1, 1]) {
        const point = crossing.axis === 'x' ? { x: crossing.point.x, y: crossing.point.y + offset * sign } : { x: crossing.point.x + offset * sign, y: crossing.point.y }
        if (point.x < 24 || point.y < 24 || point.x > width - 24 || point.y > height - 24) continue
        const side = crossing.dx * (point.y - crossing.point.y) - crossing.dy * (point.x - crossing.point.x)
        if (side * home.side <= 0 || !planner.suitable(point, roadWidth) || results.some(other => distance(point, other) < 65)) continue
        results.push(point)
      }
      // First actual valley exit in each chainage direction defines this route.
      // A later re-entry must not become a second invented regional corridor.
      if (results.length) break
    }
    if (!results.length && direction === -1) {
      const head = river[0]!
      if (head.x >= 0 && head.y >= 0 && head.x <= width && head.y <= height) {
        const edges = [{ point: { x: 28, y: head.y }, distance: head.x, axis: 'y' as const }, { point: { x: width - 28, y: head.y }, distance: width - head.x, axis: 'y' as const }, { point: { x: head.x, y: 28 }, distance: head.y, axis: 'x' as const }, { point: { x: head.x, y: height - 28 }, distance: height - head.y, axis: 'x' as const }].sort((a, b) => a.distance - b.distance)
        const edge = edges[0]!
        // A real headwater may lie just inside the crop. Survey a land pass
        // from that valley toward the nearby divide; never extend the channel
        // or invent upstream water to manufacture a map-boundary crossing.
        if (edge.distance <= 600) for (const offset of [0, -80, 80, -160, 160, -240, 240, -360, 360, -500, 500]) {
          const point = { ...edge.point, [edge.axis]: edge.point[edge.axis] + offset }
          if (point.x < 24 || point.y < 24 || point.x > width - 24 || point.y > height - 24 || !planner.suitable(point, roadWidth)) continue
          results.push(point)
        }
        headwaterPass = results.length > 0
      }
    }
    return results
  })
  return { directions, headwaterPass }
}

export function valleyBoundaryPortals(input: ValleyBoundaryInput): Point[][] { return surveyValleyBoundary(input).directions }

export interface ValleyThroughRoad {
  route: PlannedRoute; width: number; fundingLimit: number
  headwaterPass: boolean
  sections: { points: Point[]; bridge: boolean; length: number }[]
}

/** A user-selected regional road has a separately bounded regional appropriation;
 * its two neighbouring valleys do not lose their traffic when the local village
 * declines. The allowance is a fictional scenario, in construction credits. */
export function planValleyThroughRoad(input: { width: number; height: number; origin: Point; river: Point[]; planner: RoadPlanner; regionalPlanner: RegionalRoadPlanner }): ValleyThroughRoad | null {
  const { regionalPlanner, origin } = input, width = 8.5
  const fundingLimit = (input.width + input.height) * 4
  const survey = surveyValleyBoundary({ ...input, roadWidth: width }), [upstream, downstream] = survey.directions
  if (!upstream?.length || !downstream?.length) return null
  const maxNodes = Math.ceil((input.width + 900) / 45) * Math.ceil((input.height + 900) / 45)
  const terrain = input.planner.environment.terrain
  const elevation = (p: Point) => p.x < 0 || p.y < 0 || p.x > input.width || p.y > input.height ? terrain?.continuationTerrain?.elevation(p) ?? terrain?.elevation(p) ?? 0 : terrain?.elevation(p) ?? 0
  const gradeAllowed = (route: PlannedRoute) => surveyedRoadGradeAllowed(route, .10, elevation)
  let first: PlannedRoute | null = null
  for (const portal of upstream) {
    const candidate = regionalPlanner.plan(origin, regionalPlanner.beyondBoundary(portal), { role: 'highway', width, allowBridge: true, maxNodes })
    if (candidate && candidate.cost < fundingLimit && gradeAllowed(candidate)) { first = candidate; break }
  }
  if (!first) return null
  const before = first.points[1]!, at = first.points[0]!, startHeading = Math.atan2(at.y - before.y, at.x - before.x)
  for (const portal of downstream) {
    const second = regionalPlanner.plan(origin, regionalPlanner.beyondBoundary(portal), { role: 'highway', width, allowBridge: true, startHeading, maxNodes })
    if (!second || first.cost + second.cost > fundingLimit || !gradeAllowed(second)) continue
    const points = first.points.slice().reverse().concat(second.points.slice(1))
    if (alignmentDiagnostics(points).minimumRadius < 85 || !regionalPlanner.validate(points, width, first.bridgeLength + second.bridgeLength > 0)) continue
    const spans = [...(first.surveyedBridgeSpans ?? []), ...(second.surveyedBridgeSpans ?? [])]
    const route: PlannedRoute = { ...first, points, length: first.length + second.length, cost: first.cost + second.cost, bridgeLength: first.bridgeLength + second.bridgeLength, boundaryContinuation: true, ...(spans.length ? { surveyedBridgeSpans: spans } : {}) }
    // Keep the same canonical alignment and the physical abutment-to-abutment
    // decks. Clipping the deck to the water mask would lose dry bank approaches.
    const sections: ValleyThroughRoad['sections'] = []
    let run: Point[] = [points[0]!], bridge: boolean | undefined, runLength = 0
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!, n = Math.max(1, Math.ceil(distance(a, b)))
      for (let j = 1; j <= n; j++) {
        const p = mix(a, b, j / n), previous = mix(a, b, (j - 1) / n)
        const wet = [previous, mix(previous, p, .5), p].some(sample => onSurveyedBridge(sample, route))
        if (bridge !== undefined && wet !== bridge) {
          if (distance(run.at(-1)!, previous) > 1e-7) run.push(previous)
          if (run.length > 1) sections.push({ points: run, bridge, length: runLength })
          run = [previous]; runLength = 0
        }
        bridge = wet; if (j === n) run.push(p); runLength += distance(previous, p)
      }
    }
    if (run.length > 1) sections.push({ points: run, bridge: bridge ?? false, length: runLength })
    if (sections.some(section => !regionalPlanner.validate(section.points, width, section.bridge))) continue
    return { route, width, fundingLimit, sections, headwaterPass: survey.headwaterPass }
  }
  return null
}
