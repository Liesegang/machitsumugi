import { describe, expect, it } from 'vitest'
import { sampleRegionalCubic } from './regional-terrain'
import type { RegionalTerrain } from './regional-terrain'
const grid = { columns: 7, rows: 7, resolution: 100 } as RegionalTerrain

describe('shape preserving regional elevation reconstruction', () => {
  it('does not invent a coastal hill between a flat emerged shelf and a deep sea', () => {
    const z = Float32Array.from({ length: 49 }, (_, i) => Math.floor(i / 7) === 2 || Math.floor(i / 7) === 3 ? .15 : -500)
    for (let y = 200; y <= 300; y += 5) for (let x = 150; x <= 450; x += 25) expect(sampleRegionalCubic(grid, z, x, y)).toBeCloseTo(.15, 6)
  })
  it('preserves a real summit and a linear plane instead of globally clipping high coastal land', () => {
    const summit = new Float32Array(49); summit[24] = 120
    expect(sampleRegionalCubic(grid, summit, 300, 300)).toBe(120)
    const plane = Float32Array.from({ length: 49 }, (_, i) => 10 + (i % 7) * 3 + Math.floor(i / 7) * 5)
    expect(sampleRegionalCubic(grid, plane, 243, 367)).toBeCloseTo(10 + 2.43 * 3 + 3.67 * 5, 10)
  })
  it('stays within the four actual cell-corner heights on irregular terrain', () => {
    const z = Float32Array.from({ length: 49 }, (_, i) => Math.sin(i * 17.31) * 400 + Math.cos(i * .71) * 100)
    for (let y = 110; y < 500; y += 13) for (let x = 110; x < 500; x += 17) {
      const ix = Math.floor(x / 100), iy = Math.floor(y / 100), i = iy * 7 + ix, corners = [z[i]!, z[i + 1]!, z[i + 7]!, z[i + 8]!]
      const value = sampleRegionalCubic(grid, z, x, y)
      expect(value).toBeGreaterThanOrEqual(Math.min(...corners) - 1e-8)
      expect(value).toBeLessThanOrEqual(Math.max(...corners) + 1e-8)
    }
  })
  it('joins slopes continuously across the original 100m grid seams', () => {
    const z = Float32Array.from({ length: 49 }, (_, i) => (i % 7) ** 2 * 10 + Math.floor(i / 7) ** 2 * 3)
    const value = (x: number) => sampleRegionalCubic(grid, z, x, 247)
    const left = (value(300) - value(299.999)) / .001, right = (value(300.001) - value(300)) / .001
    expect(Math.abs(left - right)).toBeLessThan(1e-5)
  })
})
