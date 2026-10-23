import { describe, expect, it } from 'vitest'
import { evolveChannel } from './river-evolution'

describe('bounded curvature and upstream-lag channel migration', () => {
  const points = Array.from({ length: 61 }, (_, i) => ({ x: i < 20 ? 500 : i < 40 ? 500 + (i - 20) * 4 : 580 - (i - 40) * 2, y: i * 50 }))
  const input = { points, widths: points.map(() => 40), pinned: [20, 40], valleyElevation: () => 20 }
  it('keeps confluences fixed and migrates a bent channel reproducibly', () => {
    const result = evolveChannel(input)
    expect(evolveChannel(input)).toEqual(result)
    for (const index of [0, 20, 40, 60]) expect(result.points.some(p => p.x === points[index]!.x && p.y === points[index]!.y)).toBe(true)
    expect(result.maxMigration).toBeGreaterThan(1)
    expect(result.maxMigration).toBeLessThan(160)
  })
  it('does not invent meanders in an exactly straight uniform valley', () => {
    const straight = points.map(p => ({ x: 500, y: p.y }))
    const result = evolveChannel({ ...input, points: straight })
    expect(result.points.every(p => Math.abs(p.x - 500) < 1e-6)).toBe(true)
  })
  it('does not count resampling of a resistant bank as physical river migration', () => {
    const result = evolveChannel({ ...input, alluvium: () => 0, steps: 80 })
    expect(result.points).toEqual(result.initialPoints)
    expect(result.maxMigration).toBeLessThan(1e-8)
  })
  it('does not amplify sample-scale sawteeth or cut across a steep valley wall', () => {
    const result = evolveChannel({ ...input, valleyElevation: p => 20 + Math.max(0, Math.abs(p.x - 520) - 50) * .5 })
    for (let i = 1; i < result.points.length - 1; i++) {
      const a = result.points[i - 1]!, p = result.points[i]!, b = result.points[i + 1]!
      expect(Math.hypot(p.x - (a.x + b.x) / 2, p.y - (a.y + b.y) / 2)).toBeLessThan(12)
    }
  })
})
