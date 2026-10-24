import { describe, expect, it } from 'vitest'
import { naturalWoodlandContours } from './natural-cover'
import { intersectRegions, pointInRegion, rectangle, regionArea, subtractRegions } from './geometry'
import type { Point } from './types'

const input = {
  width: 800, height: 600, seed: 'woodland-stands', forest: 60, settlement: 'regional-city' as const, origin: { x: 0, y: 0 },
  elevation: (p: Point) => p.x * .12, slope: (p: Point) => p.x / 800 * .07, wetness: () => .4,
}
const area = (regions: ReturnType<typeof naturalWoodlandContours>) => regions.reduce((sum, region) => sum + regionArea(region), 0)

describe('residual natural woodland', () => {
  it('follows slopes and vegetation pressure, keeping forest quantity and settlement effects monotonic', () => {
    const baseline = naturalWoodlandContours(input)
    expect(area(baseline)).toBeGreaterThan(1000)
    expect(area(baseline)).toBeLessThan(input.width * input.height)
    expect(area(naturalWoodlandContours({ ...input, forest: 90 }))).toBeGreaterThan(area(baseline))
    const rural = naturalWoodlandContours({ ...input, settlement: 'village' }), urban = naturalWoodlandContours({ ...input, settlement: 'metropolis' })
    expect(area(rural)).toBeGreaterThan(area(urban))
    expect(area(naturalWoodlandContours({ ...input, elevation: () => 0, slope: () => 0 }))).toBeLessThan(area(baseline))
    expect(naturalWoodlandContours({ ...input, forest: 0 })).toEqual([])
    expect(naturalWoodlandContours(input)).toEqual(baseline)
  })
  it('is a candidate cover whose acquired farms, housing, water and civic grounds remain excluded', () => {
    const map = { polygon: rectangle(0, 0, input.width, input.height) }, masks = [
      { polygon: rectangle(350, 100, 80, 180) }, { polygon: rectangle(460, 100, 80, 180) },
      { polygon: rectangle(570, 100, 80, 180) }, { polygon: rectangle(680, 100, 80, 180) },
    ]
    const residual = naturalWoodlandContours({ ...input, forest: 100 }).flatMap(region => intersectRegions(region, map)).flatMap(region => subtractRegions(region, masks))
    expect(area(residual)).toBeGreaterThan(1000)
    for (const x of [390, 500, 610, 720]) expect(residual.some(region => pointInRegion({ x, y: 190 }, region))).toBe(false)
    expect(residual.every(region => region.polygon.every(p => p.x >= 0 && p.y >= 0 && p.x <= input.width && p.y <= input.height))).toBe(true)
  })
})
