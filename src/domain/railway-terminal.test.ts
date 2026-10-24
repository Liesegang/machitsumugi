import { describe, expect, it } from 'vitest'
import { planRailway } from './railway-planner'
import type { Area, Point } from './types'

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const rectangle = (id: string, x: number, y: number, width: number, height: number): Area => ({ id, kind: 'water', polygon: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] })

describe('regional main-line terminal fallback', () => {
  it('keeps a viable through line ahead of a cheaper terminal approach', () => {
    const origin = { x: 1500, y: 1500 }
    const input = { width: 3000, height: 3000, seed: 'through-before-terminal', origin, allowTerminus: true,
      terrain: { areas: [] as Area[], elevation: () => 20, slope: () => 0, waterAt: () => false }, settlements: [{ point: origin, demand: 1600 }] }
    const result = planRailway(input)!
    expect(result).not.toBeNull()
    expect(result.terminus).toBeUndefined()
    const edge = (p: Point) => p.x < .01 || p.y < .01 || p.x > input.width - .01 || p.y > input.height - .01
    expect(edge(result.points[0]!)).toBe(true); expect(edge(result.points.at(-1)!)).toBe(true)
    expect(result.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
    expect(result.diagnostics.minCurveRadius).toBeGreaterThanOrEqual(150)
  })

  it('serves an inherited valley settlement from its only dry external exit', () => {
    const origin = { x: 1500, y: 800 }, waterAt = (p: Point) => p.x < 700 || p.x > 2300 || p.y < 350
    const areas = [rectangle('sea-west', 0, 0, 700, 3000), rectangle('sea-east', 2300, 0, 700, 3000), rectangle('sea-north', 0, 0, 3000, 350)]
    const input = { width: 3000, height: 3000, seed: 'single-valley-outlet', origin,
      terrain: { areas, elevation: (p: Point) => waterAt(p) ? -15 : 20, slope: () => 0, waterAt }, settlements: [{ point: origin, demand: 1600 }] }
    expect(planRailway(input)).toBeNull()
    const result = planRailway({ ...input, allowTerminus: true })!
    expect(result).not.toBeNull()
    expect(result.terminus).toEqual(result.points.at(-1))
    expect(result.points[0]!.y).toBe(input.height)
    expect(result.points.every(point => !waterAt(point))).toBe(true)
    expect(distance(result.stationTargets![0]!, origin)).toBeLessThanOrEqual(250)
    const length = result.points.slice(1).reduce((sum, point, i) => sum + distance(result.points[i]!, point), 0)
    expect(length).toBeGreaterThanOrEqual(1500)
    expect(result.diagnostics.maxTrackGrade).toBeLessThanOrEqual(.035 + 1e-6)
    expect(result.diagnostics.minCurveRadius).toBeGreaterThanOrEqual(150)
    expect(result.diagnostics.maxEarthwork).toBeLessThanOrEqual(12)
    expect(result.diagnostics.maxBridgeLength).toBeLessThanOrEqual(180)
  })
  it('stops an unreachable DP alignment without sampling every later row', () => {
    let samples = 0
    const terrain = { areas: [] as Area[], elevation: (p: Point) => { samples++; return p.y < 150 ? 0 : 200 }, waterAt: () => false }
    expect(planRailway({ width: 1000, height: 3000, seed: 'dead-engineering-row', origin: { x: 500, y: 1500 }, terrain })).toBeNull()
    // Node surveying reads every row once. Continuing all thirty transition
    // rows after the early vertical wall adds over ten thousand needless reads.
    expect(samples).toBeLessThan(2500)
  })
})
