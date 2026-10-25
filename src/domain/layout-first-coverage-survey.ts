import type { Point } from './types'
import type { PlannedRoute, PlanningOptions } from './road-planner'
import type { LayoutCoverageAnchor } from './layout-first-coverage-blocks'
import { distance } from './geometry'
import { alignmentDiagnostics } from './road-alignment'
import { surveyedRoadGradeAllowed } from './surveyed-road-profile'
import { roadLength } from './road-graph'

export interface LayoutCoverageSurveyPlanner {
  plan(from: Point, to: Point, options: PlanningOptions): PlannedRoute | null
  validate(points: Point[], width: number, bridge?: boolean): boolean
  railwayWidthAllows(points: Point[], oldWidth: number, newWidth: number, role: 'collector'): boolean
}
export interface LayoutCoverageSurveyAttempt {
  tangent: number
  reason: 'first-leg' | 'second-leg' | 'endpoints' | 'heading' | 'length' | 'radius' | 'width' | 'ROW' | 'rail' | 'grade' | 'accepted'
  firstLength?: number
  secondLength?: number
  minimumRadius?: number
}
export interface LayoutCoverageSurveyInput {
  planner: LayoutCoverageSurveyPlanner
  from: LayoutCoverageAnchor
  to: LayoutCoverageAnchor
  through: Point
  builtYear: number
  width: number
  startHeading?: number
  endHeading?: number
  isPublicContact: (anchor: LayoutCoverageAnchor, builtYear: number) => boolean
  elevation: (point: Point) => number
  rowAllows: (points: Point[], width: number) => boolean
}

const turn = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle))
const heading = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x)
const tangents = (from: Point, through: Point, to: Point) => {
  const incoming = heading(from, through), outgoing = heading(through, to)
  const middle = incoming + turn(outgoing - incoming) / 2
  return [0, -Math.PI / 6, Math.PI / 6].map(offset => turn(middle + offset))
}
const endpointHeading = (points: Point[], atEnd: boolean) => atEnd ? heading(points[points.length - 2]!, points.at(-1)!) : heading(points[0]!, points[1]!)

/** Coverage returns through deliberately unserved land, so its efficiency
 * reference is the two required geographic legs, not a shortcut between the
 * old road endpoints. Both legs receive a shared interior tangent in advance.
 * No generic planner behavior or physical/dated gate is changed. */
export function surveyLayoutCoverageAlignment(input: LayoutCoverageSurveyInput): { route: PlannedRoute | null; attempts: LayoutCoverageSurveyAttempt[]; rejectedInput?: 'era' | 'geometry' | 'contact' } {
  const attempts: LayoutCoverageSurveyAttempt[] = []
  if (input.from.builtYear > input.builtYear || input.to.builtYear > input.builtYear) return { route: null, attempts, rejectedInput: 'era' }
  const from = input.from.point, to = input.to.point, through = input.through
  const lowerBound = distance(from, through) + distance(through, to)
  if (![from, to, through].every(point => Number.isFinite(point.x) && Number.isFinite(point.y)) || !Number.isFinite(input.width) || input.width <= 0 || !Number.isFinite(input.builtYear) || [input.startHeading, input.endHeading].some(angle => angle !== undefined && !Number.isFinite(angle)) || distance(from, through) < 20 || distance(through, to) < 20 || lowerBound > 4000) return { route: null, attempts, rejectedInput: 'geometry' }
  if (!input.isPublicContact(input.from, input.builtYear) || !input.isPublicContact(input.to, input.builtYear)) return { route: null, attempts, rejectedInput: 'contact' }
  for (const tangent of tangents(from, through, to)) {
    const options = { role: 'collector' as const, width: input.width, allowBridge: false, maximumGrade: .13, maxNodes: 1800 }
    const first = input.planner.plan(from, through, { ...options, ...(input.startHeading !== undefined ? { startHeading: input.startHeading } : {}), endHeading: tangent })
    if (!first) { attempts.push({ tangent, reason: 'first-leg' }); continue }
    const second = input.planner.plan(through, to, { ...options, startHeading: tangent, ...(input.endHeading !== undefined ? { endHeading: input.endHeading } : {}) })
    const record = { tangent, firstLength: first.length, ...(second ? { secondLength: second.length } : {}) }
    if (!second) { attempts.push({ ...record, reason: 'second-leg' }); continue }
    if (first.points.length < 2 || second.points.length < 2 || distance(first.points[0]!, from) > 1e-7 || distance(first.points.at(-1)!, through) > 1e-7 || distance(second.points[0]!, through) > 1e-7 || distance(second.points.at(-1)!, to) > 1e-7) { attempts.push({ ...record, reason: 'endpoints' }); continue }
    if (Math.abs(turn(endpointHeading(first.points, true) - tangent)) > .1 || Math.abs(turn(endpointHeading(second.points, false) - tangent)) > .1 || input.startHeading !== undefined && Math.abs(turn(endpointHeading(first.points, false) - input.startHeading)) > .1 || input.endHeading !== undefined && Math.abs(turn(endpointHeading(second.points, true) - input.endHeading)) > .1) { attempts.push({ ...record, reason: 'heading' }); continue }
    // Numerical endpoint residue can otherwise turn a real on-pavement
    // contact into two different saved coordinates. Snap only the already
    // certified <=1e-7 endpoints, then repeat all complete-alignment guards.
    const points = [from, ...first.points.slice(1, -1), through, ...second.points.slice(1, -1), to], length = roadLength(points)
    if (!Number.isFinite(first.cost + second.cost) || !Number.isFinite(length) || first.bridgeLength > 0 || second.bridgeLength > 0 || (first.surveyedBridgeSpans?.length ?? 0) > 0 || (second.surveyedBridgeSpans?.length ?? 0) > 0 || length > lowerBound * 1.6) { attempts.push({ ...record, reason: 'length' }); continue }
    const minimumRadius = alignmentDiagnostics(points).minimumRadius, geometryRecord = { ...record, minimumRadius }
    if (minimumRadius < 50 - 1e-6) { attempts.push({ ...geometryRecord, reason: 'radius' }); continue }
    if (!input.planner.validate(points, input.width)) { attempts.push({ ...geometryRecord, reason: 'width' }); continue }
    if (!input.rowAllows(points, input.width)) { attempts.push({ ...geometryRecord, reason: 'ROW' }); continue }
    if (!input.planner.railwayWidthAllows(points, .01, input.width, 'collector')) { attempts.push({ ...geometryRecord, reason: 'rail' }); continue }
    if (!surveyedRoadGradeAllowed({ points }, .13, input.elevation)) { attempts.push({ ...geometryRecord, reason: 'grade' }); continue }
    attempts.push({ ...geometryRecord, reason: 'accepted' })
    return { route: { points, length, cost: first.cost + second.cost, bridgeLength: 0, method: 'heading-search' }, attempts }
  }
  return { route: null, attempts }
}
