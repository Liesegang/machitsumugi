import { describe, expect, it } from 'vitest'
import { RoadPlanner } from './road-planner'
import { alignmentDiagnostics } from './road-alignment'
import type { Point } from './types'

const difference = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))
const heading = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x)
const planner = () => new RoadPlanner({ width: 1200, height: 1000, areas: [], core: null })

describe('independent short-road endpoint tangent pins', () => {
  it('cannot erase a 70-degree departure constraint when the short corridor has only one intermediate control', () => {
    // The actual measured NW bank approach, isolated from city generation.
    const start = { x: 561.5944624011278, y: 616.183180948612 }, goal = { x: 520.6070174404, y: 667.2162167738588 }
    const startHeading = 1.0156468957667022, endHeading = 2.247458175192766
    const result = planner().plan(start, goal, { role: 'collector', width: 9.5, startHeading, endHeading, maximumGrade: .08 })
    // A constrained survey may decline an impossible bend. Returning the old
    // straight chord at the wrong departure is never a valid fallback.
    if (result) {
      expect(difference(heading(result.points[0]!, result.points[1]!), startHeading)).toBeLessThanOrEqual(.1)
      expect(difference(heading(result.points.at(-2)!, result.points.at(-1)!), endHeading)).toBeLessThanOrEqual(.1)
      expect(alignmentDiagnostics(result.points).minimumRadius).toBeGreaterThanOrEqual(50)
    }
  })
  it('retains both actual endpoint tangents on a feasible short collector curve in either direction', () => {
    for (const reverse of [false, true]) {
      const start = reverse ? { x: 500, y: 500 } : { x: 400, y: 400 }, goal = reverse ? { x: 400, y: 400 } : { x: 500, y: 500 }
      const startHeading = reverse ? -Math.PI / 2 : 0, endHeading = reverse ? Math.PI : Math.PI / 2
      const result = planner().plan(start, goal, { role: 'collector', width: 9.5, startHeading, endHeading })
      expect(result).not.toBeNull()
      expect(difference(heading(result!.points[0]!, result!.points[1]!), startHeading)).toBeLessThanOrEqual(.1)
      expect(difference(heading(result!.points.at(-2)!, result!.points.at(-1)!), endHeading)).toBeLessThanOrEqual(.1)
      expect(alignmentDiagnostics(result!.points).minimumRadius).toBeGreaterThanOrEqual(50)
    }
  })
})
