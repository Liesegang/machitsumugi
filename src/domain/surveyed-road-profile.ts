import type { Point } from './types'
import type { PlannedRoute, SurveyedBridgeSpan } from './road-planner'

function bridgeFraction(point: Point, { bankA, bankB }: SurveyedBridgeSpan): number | null {
  const dx = bankB.x - bankA.x, dy = bankB.y - bankA.y, squared = dx * dx + dy * dy
  if (squared < 1e-10) return null
  const t = ((point.x - bankA.x) * dx + (point.y - bankA.y) * dy) / squared
  if (t < -1e-8 || t > 1 + 1e-8 || Math.hypot(point.x - bankA.x - dx * t, point.y - bankA.y - dy * t) > .01) return null
  return Math.max(0, Math.min(1, t))
}

export function onSurveyedBridge(point: Point, route: Pick<PlannedRoute, 'surveyedBridgeSpans'>): boolean {
  return (route.surveyedBridgeSpans ?? []).some(span => bridgeFraction(point, span) !== null)
}

/** Deck elevation applies only on the exact, physically surveyed bank pair.
 * Water masks and low river-bed DEM samples cannot grant an unsurveyed bridge. */
export function surveyedRoadElevation(point: Point, route: Pick<PlannedRoute, 'surveyedBridgeSpans'>, terrainElevation: (p: Point) => number): number {
  for (const span of route.surveyedBridgeSpans ?? []) {
    const fraction = bridgeFraction(point, span)
    if (fraction === null) continue
    const { bankA, bankB } = span
    return terrainElevation(bankA) * (1 - fraction) + terrainElevation(bankB) * fraction
  }
  return terrainElevation(point)
}

export function surveyedRoadGradeAllowed(route: Pick<PlannedRoute, 'points' | 'surveyedBridgeSpans'>, maximumGrade: number, terrainElevation: (p: Point) => number): boolean {
  let previous: Point | undefined, previousHeight = 0
  for (const point of route.points) {
    const height = surveyedRoadElevation(point, route, terrainElevation)
    if (!Number.isFinite(height)) return false
    if (previous) {
      const length = Math.hypot(point.x - previous.x, point.y - previous.y)
      if (length > 1e-8 && Math.abs(height - previousHeight) / length > maximumGrade + 1e-9) return false
    }
    previous = point; previousHeight = height
  }
  return true
}
