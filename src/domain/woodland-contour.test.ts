import { describe, expect, it } from 'vitest'
import { woodlandContours } from './terrain'
import { pointInRegion, regionArea } from './geometry'
import type { Point } from './types'

const survey = {
  width: 600, height: 500, forest: 100, origin: { x: 0, y: 0 }, coreRadius: 0,
  elevation: (p: Point) => (p.x - 200 - 70 * Math.sin(p.y / 90)) * .12,
  slope: () => 0, bankDistance: () => Infinity, variation: () => 0, water: [],
}

describe('continuous mountain-foot woodland contours', () => {
  it('tracks the terrain curve without long straight approximations or a 40m cell outline', () => {
    const regions = woodlandContours(survey)
    expect(regions.length).toBeGreaterThan(0)
    for (const y of [60, 140, 220, 300, 380, 460]) {
      const expected = 20 / .12 + 70 * Math.sin(y / 90)
      expect(regions.some(region => pointInRegion({ x: expected + 4, y }, region))).toBe(true)
      expect(regions.some(region => pointInRegion({ x: expected - 4, y }, region))).toBe(false)
    }
    const internalEdges = regions.flatMap(region => region.polygon.map((a, i, ring) => ({ a, b: ring[(i + 1) % ring.length]! })))
      .filter(({ a, b }) => [a, b].every(p => p.x > 1 && p.x < 599 && p.y > 1 && p.y < 499))
    expect(Math.max(...internalEdges.map(({ a, b }) => Math.hypot(a.x - b.x, a.y - b.y)))).toBeLessThan(6)
    expect(internalEdges.some(({ a }) => Math.abs(a.x / 40 - Math.round(a.x / 40)) > .1)).toBe(true)
  })
  it('keeps water holes, core protection and increasing forest coverage', () => {
    const pond = { polygon: [{ x: 350, y: 120 }, { x: 410, y: 120 }, { x: 410, y: 220 }, { x: 350, y: 220 }] }
    const input = { ...survey, origin: { x: 100, y: 250 }, elevation: (p: Point) => p.x * .2, slope: () => .1, water: [pond] }
    const full = woodlandContours(input), sparse = woodlandContours({ ...input, forest: 20 })
    expect(full.some(region => pointInRegion({ x: 380, y: 160 }, region))).toBe(false)
    expect(full.some(region => pointInRegion({ x: 300, y: 160 }, region))).toBe(true)
    expect(full.some(region => pointInRegion({ x: 170, y: 250 }, region))).toBe(false)
    expect(full.some(region => pointInRegion({ x: 210, y: 250 }, region))).toBe(true)
    expect(full.reduce((sum, region) => sum + regionArea(region), 0)).toBeGreaterThan(sparse.reduce((sum, region) => sum + regionArea(region), 0))
    expect(woodlandContours({ ...input, forest: 0 })).toEqual([])
    expect(full.every(region => region.polygon.every(p => p.x >= 0 && p.x <= input.width && p.y >= 0 && p.y <= input.height))).toBe(true)
  })
  it('retains an actual straight terrain transition instead of inventing boundary noise', () => {
    const input = { ...survey, elevation: (p: Point) => p.x * .1 }
    const first = woodlandContours(input), second = woodlandContours(input)
    expect(second).toEqual(first)
    const boundary = first.flatMap(region => region.polygon).filter(p => p.y > 80 && p.y < 420 && p.x < 590)
    expect(Math.max(...boundary.map(p => Math.abs(p.x - 200)))).toBeLessThan(.01)
  })
})
