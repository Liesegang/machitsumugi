import { describe, expect, it } from 'vitest'
import { findNeckCutoff, severChannelNeck } from './channel-cutoff'
import { evolveChannel } from './river-evolution'

const points = [{ x: -120, y: 0 }, { x: -60, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 30 }, { x: 50, y: 80 }, { x: 120, y: 120 }, { x: 200, y: 100 }, { x: 240, y: 30 }, { x: 220, y: -40 }, { x: 140, y: -90 }, { x: 60, y: -60 }, { x: 20, y: -15 }, { x: 0, y: -20 }, { x: -60, y: -20 }, { x: -120, y: -20 }]
const widths = points.map(() => 30)
const input = { points, widths, pinned: [0, points.length - 1], elevation: () => 10, alluvium: () => 8 }

describe('neck contact and old channel preservation', () => {
  it('cuts a genuine long loop at contacting banks and archives its actual former channel', () => {
    const neck = findNeckCutoff(input)!
    expect(neck).not.toBeNull()
    expect(neck.oldLength).toBeGreaterThan(8 * 30)
    expect(neck.separation).toBeLessThan(30)
    const result = severChannelNeck(points, widths, input.pinned, neck, 24)
    expect(result.points).toHaveLength(points.length - (neck.last - neck.first - 1))
    expect(result.points[0]).toEqual(points[0])
    expect(result.points.at(-1)).toEqual(points.at(-1))
    expect(result.abandoned).not.toBeNull()
    expect(result.abandoned!.points.every(p => points.includes(p) || points.some(q => q.x === p.x && q.y === p.y))).toBe(true)
    expect(result.abandoned!.formedAtStep).toBe(24)
  })
  it('does not sever a tributary junction, a rock-confined neck, or two nearby but short parallel reaches', () => {
    expect(findNeckCutoff({ ...input, pinned: [0, 7, points.length - 1] })).toBeNull()
    expect(findNeckCutoff({ ...input, alluvium: () => 0 })).toBeNull()
    expect(findNeckCutoff({ ...input, points: points.slice(0, 2).concat(points.slice(-2)), widths: [30, 30, 30, 30], pinned: [0, 3] })).toBeNull()
  })
  it('detects neck contact during the evolution loop and keeps confluence coordinates exact', () => {
    const result = evolveChannel({ points, widths, pinned: input.pinned, valleyElevation: () => 10, alluvium: () => 8, steps: 80 })
    expect(result.abandoned).toHaveLength(1)
    expect(result.steps).toBeLessThan(80)
    expect(result.points[0]).toEqual(points[0])
    expect(result.points.at(-1)).toEqual(points.at(-1))
  })
  it('forms a new cutoff through mobile-bank evolution while a resistant bank keeps the initially open neck', () => {
    const open = [{ x: -500, y: 0 }, { x: -100, y: 0 }, ...points.slice(2, 11), { x: 20, y: -70 }, { x: 0, y: -70 }, { x: -100, y: -70 }, { x: -500, y: -70 }]
    const scenario = { points: open, widths: open.map(() => 30), pinned: [0, open.length - 1], valleyElevation: () => 10, steps: 300 }
    const mobile = evolveChannel({ ...scenario, alluvium: () => 8 })
    expect(findNeckCutoff({ points: mobile.initialPoints, widths: mobile.initialWidths, pinned: [0, mobile.initialPoints.length - 1], elevation: () => 10, alluvium: () => 8 })).toBeNull()
    expect(mobile.abandoned).toHaveLength(1)
    expect(mobile.steps).toBeGreaterThan(8)
    expect(evolveChannel({ ...scenario, alluvium: () => 0 }).abandoned).toHaveLength(0)
  })
})
