import { describe, expect, it } from 'vitest'
import { railwayCorridors } from './railway-corridor'
import { planRailway } from './railway-planner'
import type { Area, Point } from './types'

const axis = (y: number) => 900 + 500 * Math.exp(-(((y - 1500) / 900) ** 2))
const elevation = (p: Point) => 20 + ((p.x - axis(p.y)) / 120) ** 2 * 3
const slope = (p: Point) => Math.hypot(elevation({ x: p.x + 5, y: p.y }) - elevation({ x: p.x - 5, y: p.y }), elevation({ x: p.x, y: p.y + 5 }) - elevation({ x: p.x, y: p.y - 5 })) / 10
const input = { width: 3000, height: 3000, seed: 'geographic-rail', origin: { x: 1400, y: 1500 }, terrain: { areas: [] as Area[], elevation, slope, waterAt: () => false, channelAt: (p: Point) => ({ bankDistance: Math.abs(p.x - axis(p.y)), width: 35 }) }, settlements: [{ point: { x: 1400, y: 1500 }, demand: 1600 }] }
describe('regional railway corridor and inherited settlement access', () => {
  it('uses valley exits and dry settlement land rather than the origin-minus-650 column', () => {
    const corridors = railwayCorridors(input)
    expect(corridors.length).toBeGreaterThan(0)
    expect(corridors[0]!.station.x).toBeGreaterThan(1150)
    expect(corridors[0]!.from.y !== corridors[0]!.to.y).toBe(true)
    const result = planRailway(input)!
    expect(result).not.toBeNull()
    expect(result.stationTargets!.some(p => Math.hypot(p.x - 1400, p.y - 1500) < 300)).toBe(true)
    const middle = result.points.filter(p => p.y > 1200 && p.y < 1800)
    expect(Math.min(...middle.map(p => p.x))).toBeGreaterThan(1100)
    expect(Math.max(...result.points.map(p => p.x)) - Math.min(...result.points.map(p => p.x))).toBeGreaterThan(200)
    expect(result.diagnostics.minCurveRadius).toBeGreaterThanOrEqual(150)
    expect(result.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
    expect(result.diagnostics.maxEarthwork).toBeLessThanOrEqual(12)
  })
})
