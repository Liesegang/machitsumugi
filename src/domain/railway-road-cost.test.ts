import { describe, expect, it } from 'vitest'
import { railwayRoadCost } from './railway-road-cost'
import { planRailway } from './railway-planner'
import type { Area, Road } from './types'

const road: Road = { id: 'old-trade-road', kind: 'arterial', role: 'highway', width: 9, builtYear: 1650, points: Array.from({ length: 81 }, (_, i) => ({ x: i * 50, y: 1500 + Math.sin(i * 50 / 280) * 145 })) }
const interactions = railwayRoadCost([road])
const crossings = (points: { x: number; y: number }[]) => points.slice(1).flatMap((b, i) => interactions.crossings(points[i]!, b))
describe('railway acquisition across inherited roads', () => {
  it('prefers a consistent side of a winding highway while retaining grade and curvature limits', () => {
    const sea = (id: string, y: number): Area => ({ id, kind: 'water', polygon: [{ x: 0, y }, { x: 4000, y }, { x: 4000, y: y + 1000 }, { x: 0, y: y + 1000 }] })
    const input = { width: 4000, height: 3000, seed: 'rail-road-acquisition', origin: { x: 2000, y: 1450 }, settlements: [{ point: { x: 2000, y: 1450 }, demand: 2000 }], terrain: { areas: [sea('sea-north', -10), sea('sea-south', 2010)], elevation: () => 20, slope: () => 0, waterAt: (p: { y: number }) => p.y < 990 || p.y > 2010 } }
    const before = planRailway(input)!, after = planRailway({ ...input, inheritedRoads: [road] })!
    expect(before).not.toBeNull(); expect(after).not.toBeNull()
    expect(crossings(before.points).length).toBeGreaterThan(3)
    expect(crossings(after.points).length).toBeLessThanOrEqual(1)
    expect(after.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
    expect(after.diagnostics.minCurveRadius).toBeGreaterThanOrEqual(150)
  })
  it('prices shallow crossings and ignores future road projects', () => {
    const straight = { ...road, points: [{ x: 0, y: 100 }, { x: 1000, y: 100 }] }, costs = railwayRoadCost([straight])
    expect(costs.edgeCost({ x: 500, y: 0 }, { x: 500, y: 200 })).toBeLessThan(costs.edgeCost({ x: 0, y: 50 }, { x: 1000, y: 150 }))
    const future = railwayRoadCost([{ ...straight, builtYear: 1955 }])
    expect(future.edgeCost({ x: 500, y: 0 }, { x: 500, y: 200 })).toBe(0)
    expect(future.pointCost({ x: 500, y: 100 })).toBe(0)
  })
})
