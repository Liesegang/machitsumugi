import type { Point } from './types'
import { alignmentDiagnostics } from './road-alignment'
import type { PlannedRoute, RoadPlanner } from './road-planner'
import type { RegionalRoadPlanner } from './regional-road-planner'
import { onSurveyedBridge, surveyedRoadGradeAllowed } from './surveyed-road-profile'
import { projectOnRoadSegment, type PlanarRoadGraph, type RoadProject } from './road-graph'

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

interface ValleyRoadSection { points: Point[]; bridge: boolean; length: number }
export interface ValleyThroughRoad {
  route: PlannedRoute; width: number; fundingLimit: number
  /** The survey walk may visit a shared bridge twice. Construction counts each
   * physical deck once, while retaining both surveyed city approaches. */
  constructionLength: number; constructionCost: number
  attachment: Point
  headwaterPass: boolean
  sections: (ValleyRoadSection & { constructionCost: number })[]
}

/** Two destinations can share the same surveyed bridge near the town. They
 * form a road network, not two decks laid over each other. Only exact surveyed
 * bank-pair identity permits sharing; nearby parallel bridges stay distinct. */
export function shareValleyBridgeDecks(sections: ValleyRoadSection[], spans: NonNullable<PlannedRoute['surveyedBridgeSpans']>) {
  const result = sections.map(section => ({ ...section, points: section.points.map(p => ({ ...p })) }))
  const decks = new Map<string, typeof result[number]>(), omitted = new Set<number>()
  const key = (p: Point) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`
  for (const [index, section] of result.entries()) {
    if (!section.bridge) continue
    const first = section.points[0]!, last = section.points.at(-1)!
    const span = spans.find(({ bankA, bankB }) => {
      const length = distance(bankA, bankB)
      if (length < 1) return false
      const ends = Math.min(Math.max(distance(first, bankA), distance(last, bankB)), Math.max(distance(first, bankB), distance(last, bankA)))
      return ends <= 1.5 && section.points.every(p => Math.abs((bankB.x - bankA.x) * (p.y - bankA.y) - (bankB.y - bankA.y) * (p.x - bankA.x)) / length < .04)
    })
    if (!span) continue
    const identity = [key(span.bankA), key(span.bankB)].sort().join('|'), existing = decks.get(identity)
    if (!existing) { decks.set(identity, section); continue }
    const before = result[index - 1], after = result[index + 1]
    if (!before || before.bridge || !after || after.bridge) continue
    const a = existing.points[0]!, b = existing.points.at(-1)!
    const reverse = distance(first, b) + distance(last, a) < distance(first, a) + distance(last, b)
    const entry = reverse ? b : a, exit = reverse ? a : b
    if (distance(first, entry) > 2 || distance(last, exit) > 2) continue
    // Wet/dry splitting samples at 1m; two traversals can differ by a fraction
    // of a metre. Both approaches use the first surveyed deck's exact nodes.
    before.points[before.points.length - 1] = { ...entry }
    after.points[0] = { ...exit }
    omitted.add(index)
  }
  return result.filter((_, index) => !omitted.has(index)).map(section => ({ ...section, length: section.points.slice(1).reduce((sum, p, i) => sum + distance(section.points[i]!, p), 0) }))
}

/** Rebuilding an inherited bridge is one funded modification, not a second
 * bridge drawn over the old deck. Its junctions and earlier width stay dated. */
export function commitValleyThroughRoad(graph: PlanarRoadGraph, project: ValleyThroughRoad, input: { year: number; reason: string; nextId: () => string }) {
  const totalCost = project.sections.reduce((sum, section) => sum + section.constructionCost, 0)
  if (!graph.nearest(project.attachment, .2) || !Number.isFinite(project.constructionCost) || !Number.isFinite(totalCost) || totalCost < 0 || totalCost > project.fundingLimit || Math.abs(totalCost - project.constructionCost) > 1e-6 || project.sections.some(section => section.constructionCost < 0)) return null
  const projects: RoadProject[] = []
  for (const section of project.sections) {
    const inherited = section.bridge ? graph.roads.filter(road => road.bridge && road.width < project.width && road.points.every(point => section.points.slice(1).some((end, i) => distance(point, projectOnRoadSegment(point, section.points[i]!, end).point) < .04))) : []
    // Two inherited decks need a separate replacement survey; never silently
    // retire one or bypass the ordinary duplicate-corridor check.
    if (inherited.length > 1) return null
    const existing = inherited[0]
    projects.push({ points: section.points, metadata: { id: existing?.id ?? input.nextId(), builtYear: input.year, phase: 'suburban', role: section.bridge ? 'bridge' : 'highway', bridge: section.bridge, reason: input.reason, width: project.width, kind: 'arterial', constructionCost: section.constructionCost, boundaryContinuation: true, preserveEndpoint: true }, requireConnection: false, ...(existing ? { modifies: existing.id } : {}) })
  }
  return graph.addBatch(projects)
}

/** A user-selected regional road has a separately bounded regional appropriation;
 * its two neighbouring valleys do not lose their traffic when the local village
 * declines. The allowance is a fictional scenario, in construction credits. */
interface ValleyThroughRoadInput { width: number; height: number; origin: Point; river: Point[]; planner: RoadPlanner; regionalPlanner: RegionalRoadPlanner; connectionPoints?: Point[] }

export function planValleyThroughRoad(input: ValleyThroughRoadInput): ValleyThroughRoad | null {
  const terrain = input.planner.environment.terrain
  const score = (point: Point) => distance(point, input.origin) + (terrain?.slope(point) ?? 0) * 6000 + Math.max(0, (terrain?.elevation(point) ?? 0) - (terrain?.elevation(input.origin) ?? 0)) * 5
  const sites = [{ point: input.origin, score: score(input.origin) }, ...(input.connectionPoints ?? []).filter(point => distance(point, input.origin) <= 700 && (terrain?.slope(point) ?? 0) <= .08 && input.planner.suitable(point, 14)).map(point => ({ point, score: score(point) }))].sort((a, b) => a.score - b.score)
  const chosen: Point[] = []
  for (const site of sites) {
    if (chosen.some(point => distance(point, site.point) < 120)) continue
    chosen.push(site.point)
    if (chosen.length === 3) break
  }
  for (const origin of chosen) {
    const project = planValleyConnection({ ...input, origin })
    if (project) return project
  }
  return null
}

function planValleyConnection(input: ValleyThroughRoadInput): ValleyThroughRoad | null {
  const { regionalPlanner, origin } = input, width = 8.5
  const fundingLimit = (input.width + input.height) * 4
  const survey = surveyValleyBoundary({ ...input, roadWidth: width }), [upstream, downstream] = survey.directions
  if (input.river.length < 2) return null
  const passes = regionalPlanner.boundaryPortals(origin, { width, maxCandidates: 12 })
  function* goals(portals: Point[] | undefined) {
    // Prefer river-valley exits, but a road may continue along a mountain front
    // into a neighbouring valley. Its two regional destinations need not share
    // the river's local axis. Every pass still requires a complete real survey.
    const visited: Point[] = []
    for (const portal of (portals ?? []).slice(0, 4)) { const point = regionalPlanner.beyondBoundary(portal); visited.push(point); yield { point, pass: false } }
    for (const point of passes) if (visited.every(previous => distance(previous, point) >= 180)) yield { point, pass: true }
  }
  const maxNodes = Math.ceil((input.width + 900) / 45) * Math.ceil((input.height + 900) / 45)
  const terrain = input.planner.environment.terrain
  const elevation = (p: Point) => p.x < 0 || p.y < 0 || p.x > input.width || p.y > input.height ? terrain?.continuationTerrain?.elevation(p) ?? terrain?.elevation(p) ?? 0 : terrain?.elevation(p) ?? 0
  const gradeAllowed = (route: PlannedRoute) => surveyedRoadGradeAllowed(route, .10, elevation)
  let searches = 0
  const maxSearches = 12
  for (const firstGoal of goals(upstream)) {
    if (searches >= maxSearches) break
    searches++
    const first = regionalPlanner.plan(origin, firstGoal.point, { role: 'highway', width, allowBridge: true, maxNodes, maximumGrade: .10 })
    if (!first || first.cost >= fundingLimit || !gradeAllowed(first)) continue
    const before = first.points[1]!, at = first.points[0]!, startHeading = Math.atan2(at.y - before.y, at.x - before.x)
    for (const goal of goals(downstream)) {
    if (distance(goal.point, first.points.at(-1)!) < 240) continue
    const a = first.points.at(-1)!, ax = a.x - origin.x, ay = a.y - origin.y, bx = goal.point.x - origin.x, by = goal.point.y - origin.y
    if ((ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1) > -.15) continue
    if (searches >= maxSearches) break
    searches++
    let pairFirst = first
    let second = regionalPlanner.plan(origin, goal.point, { role: 'highway', width, allowBridge: true, startHeading, maxNodes, maximumGrade: .10 })
    if ((!second || !gradeAllowed(second)) && searches + 2 <= maxSearches) {
      // A cheap unconstrained first leg can leave the attachment pointing into
      // a cliff when reversed. Survey a shared through tangent for both legs,
      // rather than declaring the second destination physically unreachable.
      const heading = Math.atan2(firstGoal.point.y - goal.point.y, firstGoal.point.x - goal.point.x)
      searches++
      const alternative = regionalPlanner.plan(origin, firstGoal.point, { role: 'highway', width, allowBridge: true, startHeading: heading, maxNodes, maximumGrade: .10 })
      if (alternative && alternative.cost < fundingLimit && gradeAllowed(alternative)) {
        pairFirst = alternative; searches++
        second = regionalPlanner.plan(origin, goal.point, { role: 'highway', width, allowBridge: true, startHeading: heading + Math.PI, maxNodes, maximumGrade: .10 })
      }
    }
    if (!second || pairFirst.cost + second.cost > fundingLimit || !gradeAllowed(second)) continue
    const points = pairFirst.points.slice().reverse().concat(second.points.slice(1))
    if (alignmentDiagnostics(points).minimumRadius < 85 || !regionalPlanner.validate(points, width, pairFirst.bridgeLength + second.bridgeLength > 0) || !regionalPlanner.railwayAllows(points, 'highway')) continue
    const spans = [...(pairFirst.surveyedBridgeSpans ?? []), ...(second.surveyedBridgeSpans ?? [])]
    const route: PlannedRoute = { ...pairFirst, points, length: pairFirst.length + second.length, cost: pairFirst.cost + second.cost, bridgeLength: pairFirst.bridgeLength + second.bridgeLength, boundaryContinuation: true, ...(spans.length ? { surveyedBridgeSpans: spans } : {}) }
    // Keep the same canonical alignment and the physical abutment-to-abutment
    // decks. Clipping the deck to the water mask would lose dry bank approaches.
    const sections: ValleyRoadSection[] = []
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
    const network = shareValleyBridgeDecks(sections, spans)
    if (network.some(section => !regionalPlanner.validate(section.points, width, section.bridge) || !gradeAllowed({ ...route, points: section.points }) || !regionalPlanner.railwayAllows(section.points, 'highway'))) continue
    // Re-evaluate each physical section with the same location-dependent
    // construction-credit proxy used by the route survey. A global length
    // ratio would spread a shared bridge's fixed/water cost over mountain land.
    const costed = network.map(section => ({ ...section, constructionCost: regionalPlanner.cost(section.points, 'highway', section.bridge).cost }))
    const constructionCost = costed.reduce((sum, section) => sum + section.constructionCost, 0)
    if (!Number.isFinite(constructionCost) || constructionCost > fundingLimit) continue
    const constructionLength = network.reduce((sum, section) => sum + section.length, 0)
    return { route, width, fundingLimit, attachment: origin, sections: costed, constructionLength, constructionCost, headwaterPass: survey.headwaterPass || firstGoal.pass || goal.pass }
    }
  }
  return null
}
