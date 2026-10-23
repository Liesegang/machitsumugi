import { describe, expect, it } from 'vitest'
import { planRailBranch } from './railway-branch'
import type { Area, Point } from './types'

const start = { point: { x: 500, y: 500 }, heading: Math.PI / 2, elevation: 20, grade: 0 }
const base = { width: 3000, height: 3000, start, goal: { x: 1500, y: 1500 }, terrain: { areas: [] as Area[], elevation: () => 20, waterAt: () => false } }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

describe('railway branches from a real parent track junction', () => {
  it('keeps the junction, heading, elevation and vertical tangent while turning toward a separate hub', () => {
    const result = planRailBranch(base)!
    expect(result).not.toBeNull()
    expect(result.points[0]).toEqual(start.point)
    expect(result.elevations[0]).toBe(start.elevation)
    expect(Math.atan2(result.points[1]!.y - start.point.y, result.points[1]!.x - start.point.x)).toBeCloseTo(start.heading, 2)
    expect(result.elevations.slice(0, 13).every(z => z === 20)).toBe(true)
    expect(distance(result.terminus!, base.goal)).toBeLessThan(90)
    expect(result.diagnostics.minCurveRadius).toBeGreaterThanOrEqual(150)
    expect(result.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
    expect(result.diagnostics.maxEarthwork).toBeLessThanOrEqual(12)
    expect(planRailBranch(base)).toEqual(result)
  })
  it('makes a bridge with dry banks and a feasible profile instead of treating water as ground', () => {
    const waterAt = (p: Point) => p.x > 950 && p.x < 1020
    const river: Area = { id: 'river', kind: 'water', polygon: [{ x: 950, y: 0 }, { x: 1020, y: 0 }, { x: 1020, y: 3000 }, { x: 950, y: 3000 }] }
    const result = planRailBranch({ ...base, terrain: { areas: [river], waterAt, elevation: p => waterAt(p) ? 18 : 20 } })!
    expect(result).not.toBeNull()
    expect(result.structures.some(s => s.kind === 'bridge')).toBe(true)
    for (const bridge of result.structures.filter(s => s.kind === 'bridge')) { expect(waterAt(bridge.from)).toBe(false); expect(waterAt(bridge.to)).toBe(false); expect(bridge.length).toBeLessThanOrEqual(180) }
    expect(result.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
  })
  it('rejects sea and an impossible vertical profile without deleting the barrier', () => {
    const sea: Area = { id: 'sea', kind: 'water', polygon: [{ x: 900, y: 0 }, { x: 1100, y: 0 }, { x: 1100, y: 3000 }, { x: 900, y: 3000 }] }
    expect(planRailBranch({ ...base, maxNodes: 2000, terrain: { ...base.terrain, areas: [sea], waterAt: p => p.x > 900 && p.x < 1100 } })).toBeNull()
    expect(planRailBranch({ ...base, maxNodes: 2000, terrain: { ...base.terrain, elevation: p => 20 + Math.max(0, p.y - 500) * .1 } })).toBeNull()
  })
  it('keeps the historic moat reserved even when an ordinary river bridge would be feasible', () => {
    const moat: Area = { id: 'moat-front', kind: 'water', polygon: [{ x: 950, y: 0 }, { x: 1020, y: 0 }, { x: 1020, y: 3000 }, { x: 950, y: 3000 }] }
    expect(planRailBranch({ ...base, maxNodes: 2000, terrain: { ...base.terrain, areas: [moat], waterAt: p => p.x > 950 && p.x < 1020 } })).toBeNull()
  })
})
