import { describe, expect, it } from 'vitest'
import { coastalWindow } from './coastal-window'
import type { Point } from './types'

describe('supported coast survey framing', () => {
  it('retains real sea and land while supporting the full road continuation margin', () => {
    const shoreline = (x: number) => 20000 + 900 * Math.exp(-(((x - 12000) / 1800) ** 2))
    const seaAt = (p: Point) => p.x >= 0 && p.x <= 24000 && p.y >= shoreline(p.x) && p.y <= 24000
    const input = { width: 4000, height: 3000, extent: 24000, margin: 500, mirrored: false, seaAt, usableAt: (p: Point) => !seaAt(p), candidates: [8000, 10000, 12000, 14000].map((x, index) => ({ index, point: { x, y: shoreline(x) - 50 }, score: -10 })) }
    const frame = coastalWindow(input)!
    expect(frame.seaFraction).toBeGreaterThan(.15)
    expect(frame.usableFraction).toBeGreaterThan(.4)
    expect(coastalWindow(input)).toEqual(frame)
    const c = Math.cos(frame.angle), s = Math.sin(frame.angle)
    for (const x of [-500, 4500]) for (const y of [-500, 3500]) {
      const dx = x - frame.localAnchor.x, dy = y - frame.localAnchor.y, p = { x: frame.worldAnchor.x + c * dx - s * dy, y: frame.worldAnchor.y + s * dx + c * dy }
      expect(p.x).toBeGreaterThanOrEqual(100 - 1e-6); expect(p.x).toBeLessThanOrEqual(23900 + 1e-6)
      expect(p.y).toBeGreaterThanOrEqual(100 - 1e-6); expect(p.y).toBeLessThanOrEqual(23900 + 1e-6)
    }
  })
  it('surveys a supported bearing when clamping the locally facing frame would hide a corner coast', () => {
    // An oblique coast close to the edge of a surveyed region. Facing its
    // local normal required a diagonal support box that moved the crop inland.
    const seaAt = (p: Point) => p.x >= 0 && p.y >= 0 && p.x <= 24000 && p.y <= 24000 && p.y > 23200 - .5 * (p.x - 22000)
    const frame = coastalWindow({ width: 4000, height: 3000, extent: 24000, margin: 500, mirrored: false,
      candidates: [{ index: 1, point: { x: 22000, y: 23150 }, score: -10 }], seaAt, usableAt: p => !seaAt(p) })!
    expect(frame.seaFraction).toBeGreaterThan(.05)
    expect(frame.usableFraction).toBeGreaterThan(.8)
    let actualSea = 0
    const c = Math.cos(frame.angle), s = Math.sin(frame.angle)
    const regional = (p: Point) => ({ x: frame.worldAnchor.x + c * (p.x - frame.localAnchor.x) - s * (p.y - frame.localAnchor.y), y: frame.worldAnchor.y + s * (p.x - frame.localAnchor.x) + c * (p.y - frame.localAnchor.y) })
    for (const x of [-500, 4500]) for (const y of [-500, 3500]) {
      const p = regional({ x, y })
      expect(p.x).toBeGreaterThanOrEqual(100 - 1e-6); expect(p.x).toBeLessThanOrEqual(23900 + 1e-6)
      expect(p.y).toBeGreaterThanOrEqual(100 - 1e-6); expect(p.y).toBeLessThanOrEqual(23900 + 1e-6)
    }
    for (let x = 125; x < 4000; x += 250) for (let y = 125; y < 3000; y += 250) actualSea += Number(seaAt(regional({ x, y })))
    expect(actualSea / 192).toBe(frame.seaFraction)
  })
})
