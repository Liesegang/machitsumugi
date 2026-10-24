import { describe, expect, it } from 'vitest'
import { contourConnectedSea } from './sea-contour'
import type { Point } from './types'
const inside = (p: Point, polygon: Point[]) => {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i]!, b = polygon[j]!; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit }
  return hit
}
describe('continuous ocean isobath', () => {
  it('keeps marine sediment filled exactly to water level connected to the sea', () => {
    const sea = contourConnectedSea({ width: 240, height: 180, step: 12, elevation: p => p.x < 120 ? -2 : p.x <= 192 ? 0 : p.x - 192, regionalOcean: () => true })
    const covered = (p: Point) => sea.some(a => inside(p, a.polygon) && !a.holes.some(h => inside(p, h)))
    expect(covered({ x: 150, y: 90 })).toBe(true)
    expect(covered({ x: 210, y: 90 })).toBe(false)
    expect(sea).toHaveLength(1)
    expect(sea[0]!.holes).toHaveLength(0)
  })
  it('interpolates a sloping shoreline at its zero elevation, without cell stair steps', () => {
    const elevation = (p: Point) => p.x + p.y * .37 - 480
    const sea = contourConnectedSea({ width: 1000, height: 800, step: 12, elevation, regionalOcean: () => true })
    expect(sea).toHaveLength(1)
    const coast = sea[0]!.polygon.filter(p => Math.abs(elevation(p)) < .01)
    expect(coast.length).toBeGreaterThanOrEqual(2)
    for (const p of coast) expect(Math.abs(elevation(p))).toBeLessThan(.01)
    expect(sea[0]!.polygon.some(p => p.y === 800)).toBe(true)
  })
  it('does not classify a closed inland negative-elevation depression as ocean', () => {
    const sea = contourConnectedSea({ width: 600, height: 600, elevation: p => Math.min(p.x - 100, Math.hypot(p.x - 400, p.y - 300) - 45), regionalOcean: p => p.x < 100 })
    const covered = (p: Point) => sea.some(a => inside(p, a.polygon) && !a.holes.some(h => inside(p, h)))
    expect(covered({ x: 50, y: 300 })).toBe(true)
    expect(covered({ x: 400, y: 300 })).toBe(false)
  })
  it('retains island holes and the viewport boundary without rounded-off sea corners', () => {
    const sea = contourConnectedSea({ width: 1000, height: 800, elevation: p => 180 - Math.hypot(p.x - 500, p.y - 400), regionalOcean: () => true })
    expect(sea).toHaveLength(1)
    expect(sea[0]!.holes).toHaveLength(1)
    expect(inside({ x: 500, y: 400 }, sea[0]!.holes[0]!)).toBe(true)
    for (const p of [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 800 }, { x: 1000, y: 800 }]) expect(sea[0]!.polygon.some(q => Math.hypot(q.x - p.x, q.y - p.y) < .001)).toBe(true)
  })
})
