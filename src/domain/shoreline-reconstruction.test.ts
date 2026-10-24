import { describe, expect, it } from 'vitest'
import { contourConnectedSea } from './sea-contour'
import { shoreReconstructionPreserves } from './shoreline-reconstruction'
import { distanceToSegment, pointInRegion } from './geometry'
import type { Point } from './types'
const box = (x: number, y: number, width: number, height: number) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }]

describe('bounded continuous finite-volume shore interfaces', () => {
  it('rounds grid-face corners within half a physical cell without moving the physical bed', () => {
    const polygon = [{ x: 0, y: 0 }, { x: 180, y: 0 }, { x: 180, y: 100 }, { x: 220, y: 100 }, { x: 220, y: 200 }, { x: 260, y: 200 }, { x: 260, y: 300 }, { x: 300, y: 300 }, { x: 300, y: 500 }, { x: 0, y: 500 }]
    const elevation = (p: Point) => (pointInRegion(p, { polygon }) ? -1 : 1) * Math.min(...polygon.map((a, i) => distanceToSegment(p, a, polygon[(i + 1) % polygon.length]!))) * .001
    const input = { width: 500, height: 500, step: 10, elevation, regionalOcean: () => true }, before = contourConnectedSea(input), after = contourConnectedSea({ ...input, finiteVolumeCellSize: 50 })
    const corners = (ring: Point[]) => ring.filter((p, i) => {
      if (p.x < 1 || p.y < 1 || p.x > 499 || p.y > 499) return false
      const a = ring[(i + ring.length - 1) % ring.length]!, b = ring[(i + 1) % ring.length]!, dx = p.x - a.x, dy = p.y - a.y, ex = b.x - p.x, ey = b.y - p.y
      return (dx * ex + dy * ey) / (Math.hypot(dx, dy) * Math.hypot(ex, ey)) < Math.cos(.7)
    }).length
    expect(corners(after[0]!.polygon)).toBeLessThan(corners(before[0]!.polygon) / 2)
    expect(shoreReconstructionPreserves(before, after, 50)).toBe(true)
    expect(elevation({ x: 180, y: 50 })).toBe(0)
  })
  it('keeps a narrow bay connected at its original interior and retains each real island location', () => {
    const elevation = (p: Point) => {
      const bay = Math.max(170 - p.x, p.x - 550, 220 - p.y, p.y - 240), sea = Math.min(p.x - 180, bay)
      return Math.max(sea, 20 - Math.hypot(p.x - 90, p.y - 350), 22 - Math.hypot(p.x - 90, p.y - 120)) * .001
    }
    const input = { width: 600, height: 500, step: 6, elevation, regionalOcean: () => true }, before = contourConnectedSea(input), after = contourConnectedSea({ ...input, finiteVolumeCellSize: 50 })
    expect(before[0]!.holes).toHaveLength(2)
    expect(after[0]!.holes).toHaveLength(2)
    for (const p of [{ x: 90, y: 350 }, { x: 90, y: 120 }]) expect(after[0]!.holes.some(hole => pointInRegion(p, { polygon: hole }))).toBe(true)
    for (const p of [{ x: 200, y: 230 }, { x: 400, y: 230 }, { x: 530, y: 230 }]) expect(after.some(sea => pointInRegion(p, sea))).toBe(true)
  })
  it('rejects equal counts that relocate an island or close a long narrow inlet', () => {
    const source = [{ polygon: box(0, 0, 500, 500), holes: [box(100, 100, 40, 40)] }]
    expect(shoreReconstructionPreserves(source, [{ polygon: box(0, 0, 500, 500), holes: [box(300, 300, 40, 40)] }], 50)).toBe(false)
    expect(shoreReconstructionPreserves(source, [{ polygon: box(0, 0, 430, 500), holes: [box(100, 100, 40, 40)] }], 50)).toBe(false)
  })
})
