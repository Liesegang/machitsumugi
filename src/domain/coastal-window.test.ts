import { describe, expect, it } from 'vitest'
import { coastalWindow } from './coastal-window'
import type { Point } from './types'

describe('supported coast survey framing', () => {
  it('can face the same physical coast north or south without moving the shore', () => {
    const seaAt = (p: Point) => p.y > 12000
    for (const mirrored of [false, true]) {
      const input = { width: 4000, height: 3000, extent: 24000, margin: 500, mirrored, seaAt, usableAt: (p: Point) => !seaAt(p), candidates: [{ index: 1, point: { x: 12000, y: 11950 }, score: -10 }] }
      const frames = [0, Math.PI].map(preferredBearing => coastalWindow({ ...input, preferredBearing })!)
      const wetRow = (frame: typeof frames[number], y: number) => {
        const c = Math.cos(frame.angle), s = Math.sin(frame.angle), mirror = mirrored ? -1 : 1
        return Array.from({ length: 16 }, (_, i) => {
          const dx = (i + .5) * 250 - frame.localAnchor.x, dy = y - frame.localAnchor.y
          return seaAt({ x: frame.worldAnchor.x + c * mirror * dx - s * dy, y: frame.worldAnchor.y + s * mirror * dx + c * dy })
        }).filter(Boolean).length
      }
      expect(wetRow(frames[0]!, 2875)).toBeGreaterThan(12)
      expect(wetRow(frames[0]!, 125)).toBeLessThan(4)
      expect(wetRow(frames[1]!, 125)).toBeGreaterThan(12)
      expect(wetRow(frames[1]!, 2875)).toBeLessThan(4)
      for (const frame of frames) expect(frame.seaFraction).toBeGreaterThan(.15)
    }
  })

  it('frames both sides of a real peninsula while retaining buildable mainland', () => {
    const seaAt = (p: Point) => !(p.y < 9000 || (p.x >= 11200 && p.x <= 12800 && p.y <= 15000) || Math.hypot(p.x - 12000, p.y - 15000) < 800)
    const candidates = [{ x: 11250, y: 11000 }, { x: 12750, y: 11000 }, { x: 12000, y: 15750 }, { x: 11000, y: 8950 }].map((point, index) => ({ index, point, score: -10 }))
    const frame = coastalWindow({ width: 8000, height: 6000, extent: 24000, margin: 500, mirrored: false, seaAt, usableAt: p => !seaAt(p), candidates, landform: 'peninsula', preferredBearing: 0 })!
    expect(frame.seaFraction).toBeGreaterThan(.25)
    expect(frame.seaFraction).toBeLessThan(.65)
    expect(frame.usableFraction).toBeGreaterThan(.35)
    const c = Math.cos(frame.angle), s = Math.sin(frame.angle)
    let wrappingRows = 0, wrappingColumns = 0
    for (let y = 250; y < 6000; y += 500) {
      let previous: boolean | undefined, transitions = 0
      for (let x = 250; x < 8000; x += 500) {
        const dx = x - frame.localAnchor.x, dy = y - frame.localAnchor.y
        const wet = seaAt({ x: frame.worldAnchor.x + c * dx - s * dy, y: frame.worldAnchor.y + s * dx + c * dy })
        if (previous !== undefined && previous !== wet) transitions++
        previous = wet
      }
      if (transitions >= 2) wrappingRows++
    }
    for (let x = 250; x < 8000; x += 500) {
      let previous: boolean | undefined, transitions = 0
      for (let y = 250; y < 6000; y += 500) {
        const dx = x - frame.localAnchor.x, dy = y - frame.localAnchor.y
        const wet = seaAt({ x: frame.worldAnchor.x + c * dx - s * dy, y: frame.worldAnchor.y + s * dx + c * dy })
        if (previous !== undefined && previous !== wet) transitions++
        previous = wet
      }
      if (transitions >= 2) wrappingColumns++
    }
    expect(wrappingRows + wrappingColumns).toBeGreaterThan(0)
  })
  it('prefers an existing reentrant bay to an equally feasible featureless open shore', () => {
    const seaAt = (p: Point) => p.y > 12000 || ((p.x - 12000) / 900) ** 2 + ((p.y - 11800) / 1500) ** 2 < 1
    const frame = coastalWindow({ width: 4000, height: 3000, extent: 24000, margin: 500, mirrored: false, landform: 'ria',
      candidates: [{ index: 0, point: { x: 5000, y: 11950 }, score: -10 }, { index: 1, point: { x: 11200, y: 11050 }, score: -10 }], seaAt, usableAt: p => !seaAt(p) })!
    expect(frame.index).toBe(1)
    expect(frame.seaFraction).toBeGreaterThan(.2)
    expect(frame.usableFraction).toBeGreaterThan(.4)
  })

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
