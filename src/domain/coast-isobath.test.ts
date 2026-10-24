import { describe, expect, it } from 'vitest'
import { isobathCrossing, refineIsobath } from './coast-isobath'
import { contourConnectedSea } from './sea-contour'

describe('physical zero-isobath reconstruction', () => {
  it('finds the nonlinear physical sea-level root instead of linearly mixing endpoint elevations', () => {
    const elevation = (p: { x: number }) => p.x ** 3 - 64
    const point = isobathCrossing({ x: 0, y: 0 }, { x: 10, y: 0 }, elevation)
    expect(point.x).toBeCloseTo(4, 2)
    expect(() => isobathCrossing({ x: 5, y: 0 }, { x: 10, y: 0 }, elevation)).toThrow('bracket')
  })
  it('keeps new vertices on the actual curved isobath and its chords within the geometric tolerance', () => {
    const radius = 80, elevation = (p: { x: number; y: number }) => Math.hypot(p.x, p.y) - radius
    const line = refineIsobath({ x: radius, y: 0 }, { x: 0, y: radius }, { elevation, bounds: { minX: 0, minY: 0, maxX: radius, maxY: radius } })
    expect(line.length).toBeGreaterThan(8)
    for (const p of line) expect(Math.abs(elevation(p))).toBeLessThan(.005)
    for (let i = 1; i < line.length; i++) expect(Math.abs(elevation({ x: (line[i]!.x + line[i - 1]!.x) / 2, y: (line[i]!.y + line[i - 1]!.y) / 2 }))).toBeLessThan(.16)
  })
  it('does not subdivide an exactly straight coast or alter its surveyed cell endpoints', () => {
    const a = { x: 0, y: 20 }, b = { x: 100, y: 20 }
    expect(refineIsobath(a, b, { elevation: p => p.y - 20, bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 } })).toEqual([a, b])
  })
  it('retains island topology while resolving a round shoreline on a coarse grid', () => {
    let samples = 0
    const elevation = (p: { x: number; y: number }) => { samples++; return 160 - Math.hypot(p.x - 300, p.y - 300) }
    const sea = contourConnectedSea({ width: 600, height: 600, step: 40, elevation, regionalOcean: () => true })
    expect(sea).toHaveLength(1)
    expect(sea[0]!.holes).toHaveLength(1)
    for (const p of sea[0]!.holes[0]!) expect(Math.abs(elevation(p))).toBeLessThan(.005)
    for (const ring of sea[0]!.holes) for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!
      expect(Math.abs(elevation({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }))).toBeLessThan(.32)
    }
    expect(samples).toBeLessThan(40_000)
  })
})
