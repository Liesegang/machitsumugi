import { describe, expect, it } from 'vitest'
import { developmentClimbMinutes, surveyDevelopmentSite } from './development-terrain'
import type { Point } from './types'

const origin = { x: 0, y: 0 }
const rectangle = (width: number, depth: number): Point[] => [{ x: -width / 2, y: -depth / 2 }, { x: width / 2, y: -depth / 2 }, { x: width / 2, y: depth / 2 }, { x: -width / 2, y: depth / 2 }]
describe('ordinary development land formation', () => {
  it('allows high mountain basins without an absolute elevation penalty', () => {
    const low = surveyDevelopmentSite({ slope: () => 0, elevation: () => 30 }, origin)
    const high = surveyDevelopmentSite({ slope: () => 0, elevation: () => 1230 }, origin)
    expect(high).toEqual(low)
    expect(high.viable).toBe(true)
    expect(high.formationCost).toBe(0)
  })
  it('pays balanced cut and fill on a gentle slope without excluding small houses', () => {
    const site = surveyDevelopmentSite({ slope: () => .033, elevation: p => 100 + p.x * .033 }, origin)
    expect(site.viable).toBe(true)
    expect(site.cutVolume).toBeCloseTo(site.fillVolume)
    expect(site.cutVolume).toBeGreaterThan(0)
    expect(site.formationCost).toBeGreaterThan(0)
    expect(site.suitability).toBeGreaterThan(.85)
  })
  it('distinguishes an ordinary house pad from a large unsupported hillside compound', () => {
    const terrain = { slope: () => .12, elevation: (p: Point) => 100 + p.x * .12 }
    const house = surveyDevelopmentSite(terrain, origin, rectangle(10, 12))
    const compound = surveyDevelopmentSite(terrain, origin, rectangle(48, 35))
    expect(house.viable).toBe(true)
    expect(compound.retainingHeight).toBeGreaterThan(2)
    expect(compound.viable).toBe(false)
    expect(compound.maximumFloors).toBe(0)
  })
  it('detects a scarp across a footprint even when the center reports no slope', () => {
    const site = surveyDevelopmentSite({ slope: () => 0, elevation: p => p.x > 4 ? 18 : 0 }, origin)
    expect(site.padRelief).toBe(18)
    expect(site.viable).toBe(false)
  })
  it('charges climb to the actual destination and is invariant to a uniform height offset', () => {
    const destination = { x: 0, y: 100 }, elevation = (p: Point) => p.y
    expect(developmentClimbMinutes(origin, destination, elevation, 1800)).toBe(10)
    expect(developmentClimbMinutes(origin, destination, p => elevation(p) + 1500, 1800)).toBe(10)
    expect(developmentClimbMinutes(origin, destination, elevation, 2025)).toBeLessThan(10)
  })
})
