import { describe, expect, it, vi } from 'vitest'
import polygonClipping from 'polygon-clipping'
import { channelFootprint, channelFootprintDiagnostics } from './channel-footprint'
import { clipWaterRegion } from './terrain-water'
import { pointInRegion, regionArea } from './geometry'

describe('physical variable-width channel footprint', () => {
  it('keeps every point of a tight hairpin wet instead of pairing cleaned opposite banks', () => {
    const points = [{ x: 0, y: 30 }, { x: 70, y: 30 }, { x: 80, y: 40 }, { x: 70, y: 45 }, { x: 0, y: 45 }], widths = [12, 30, 30, 30, 12]
    const regions = channelFootprint(points, widths)
    expect(regions).toHaveLength(1)
    for (let i = 1; i < points.length; i++) for (let j = 1; j < 20; j++) {
      const a = points[i - 1]!, b = points[i]!, t = j / 20
      const length = Math.hypot(b.x - a.x, b.y - a.y), half = (widths[i - 1]! * (1 - t) + widths[i]! * t) / 2
      for (const side of [-.8, 0, .8]) {
        const p = { x: a.x + (b.x - a.x) * t - (b.y - a.y) / length * half * side, y: a.y + (b.y - a.y) * t + (b.x - a.x) / length * half * side }
        expect(regions.some(region => pointInRegion(p, region))).toBe(true)
      }
    }
  })
  it('retains a dry island inside an open loop instead of filling its entire bounding polygon', () => {
    const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }, { x: -100, y: 0 }]
    const regions = channelFootprint(points, points.map(() => 10))
    expect(regions).toHaveLength(1)
    expect(regions[0]!.holes).toHaveLength(1)
    expect(regions.some(region => pointInRegion({ x: 50, y: 50 }, region))).toBe(false)
    expect(regions.some(region => pointInRegion({ x: 50, y: 2 }, region))).toBe(true)
  })
  it('preserves measured widths, the zero-width source and exact viewport clipping', () => {
    const regions = channelFootprint([{ x: -10, y: 50 }, { x: 50, y: 50 }, { x: 110, y: 50 }], [0, 20, 30]).flatMap(region => clipWaterRegion(region, 100, 100))
    expect(regions).toHaveLength(1)
    expect(regions.some(region => pointInRegion({ x: 50, y: 59 }, region))).toBe(true)
    expect(regions.some(region => pointInRegion({ x: 50, y: 61 }, region))).toBe(false)
    expect(regions.every(region => region.polygon.every(p => p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100))).toBe(true)
    expect(regions.reduce((sum, region) => sum + regionArea(region), 0)).toBeGreaterThan(1500)
  })
  it('does not make water from a zero-width runoff path or accept invalid widths', () => {
    expect(channelFootprint([{ x: 0, y: 0 }, { x: 100, y: 0 }], [0, 0])).toEqual([])
    expect(() => channelFootprint([{ x: 0, y: 0 }], [])).toThrow('match')
    expect(() => channelFootprint([{ x: 0, y: 0 }], [NaN])).toThrow('finite')
  })
  it('retains real water slivers smaller than four square metres at the viewport edge', () => {
    const regions = channelFootprint([{ x: -10, y: 11 }, { x: 20, y: 11 }], [2.4, 2.4]).flatMap(region => clipWaterRegion(region, 10, 10))
    expect(regions).toHaveLength(1)
    expect(regionArea(regions[0]!)).toBeGreaterThan(0)
    expect(regionArea(regions[0]!)).toBeLessThan(4)
    expect(pointInRegion({ x: 5, y: 9.9 }, regions[0]!)).toBe(true)
  })
  it('preserves the actual nearly collinear section that made the floating union lose its output ring', () => {
    // Contiguous indices 382–384 of the actual fdhrdjd5 50 m physical world.
    const points = [{ x: 7928.636080743712, y: 6900.797363429255 }, { x: 7924.686229328633, y: 6896.858958912243 }, { x: 7918.329437207488, y: 6890.520589142677 }], widths = [20.765654318416946, 20.76573461650647, 20.909639257464065]
    const before = channelFootprintDiagnostics.preciseUnions, regions = channelFootprint(points, widths)
    expect(channelFootprintDiagnostics.preciseUnions).toBeGreaterThan(before)
    expect(regions).toHaveLength(1)
    for (let i = 1; i < points.length; i++) for (const fraction of [.25, .5, .75]) {
      const a = points[i - 1]!, b = points[i]!, length = Math.hypot(b.x - a.x, b.y - a.y), radius = (widths[i - 1]! * (1 - fraction) + widths[i]! * fraction) / 2
      for (const side of [-.8, 0, .8]) {
        const p = { x: a.x + (b.x - a.x) * fraction - (b.y - a.y) / length * radius * side, y: a.y + (b.y - a.y) * fraction + (b.x - a.x) / length * radius * side }
        expect(regions.some(region => pointInRegion(p, region))).toBe(true)
      }
    }
    expect(regions[0]!.holes).toHaveLength(0)
    expect(regionArea(regions[0]!)).toBeGreaterThan(500)
  })
  it('keeps island holes and a submillimetre stream when the floating sweep requires its precise fallback', () => {
    const floating = vi.spyOn(polygonClipping, 'union').mockImplementation(() => { throw new Error('Floating sweep failure') })
    try {
      const loop = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }, { x: -100, y: 0 }], regions = channelFootprint(loop, loop.map(() => 10))
      expect(regions).toHaveLength(1)
      expect(regions[0]!.holes).toHaveLength(1)
      expect(pointInRegion({ x: 50, y: 50 }, regions[0]!)).toBe(false)
      expect(pointInRegion({ x: 50, y: 2 }, regions[0]!)).toBe(true)
      const source = channelFootprint([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], [0, .0002, .0002])
      expect(source.some(region => pointInRegion({ x: 1.5, y: .00005 }, region))).toBe(true)
      expect(source.some(region => pointInRegion({ x: 1.5, y: .0002 }, region))).toBe(false)
    } finally { floating.mockRestore() }
  })
})
