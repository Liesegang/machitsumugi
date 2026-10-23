import { describe, expect, it } from 'vitest'
import { routeDrainage } from './hydrology'
import { extractDepressionLakes } from './depression-lakes'

describe('standing water in DEM depressions', () => {
  function bowl(depth = 8, island = false) {
    const columns = 31, rows = 31, cellSize = 20, rawDEM = new Float32Array(columns * rows)
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      const distance = Math.hypot(x - 15, y - 15)
      rawDEM[y * columns + x] = 20 + Math.min(8, (distance - 9) * depth / 9)
      if (island && distance < 2.5) rawDEM[y * columns + x] = 23
    }
    // A real low outlet fixes the horizontal standing-water surface at20m.
    for (let x = 24; x < columns; x++) rawDEM[15 * columns + x] = 20 - (x - 24) * .2
    const drainage = routeDrainage(rawDEM, columns, rows, cellSize)
    return { columns, rows, cellSize, rawDEM, hydroDEM: drainage.hydroDEM }
  }
  it('extracts an actual horizontal spill-level lake and preserves its island as dry land', () => {
    const input = bowl(8, true), result = extractDepressionLakes(input)
    expect(result.bodies).toHaveLength(1)
    const lake = result.bodies[0]!
    expect(lake.level).toBeCloseTo(20)
    expect(lake.kind).toBe('lake')
    expect(lake.maximumDepth).toBeGreaterThan(5)
    expect(lake.polygons[0]!.holes).toHaveLength(1)
    expect(result.at({ x: 300, y: 300 })).toBeNull()
    expect(result.at({ x: 380, y: 300 })?.id).toBe(lake.id)
    for (const region of lake.polygons) for (const point of region.polygon) expect(Number.isFinite(point.x + point.y)).toBe(true)
  })
  it('distinguishes a shallow flooded wetland without changing the underlying bed or water level', () => {
    const input = bowl(.25), original = new Float32Array(input.rawDEM), result = extractDepressionLakes(input)
    expect(result.bodies).toHaveLength(1)
    expect(result.bodies[0]!.kind).toBe('wetland')
    expect(result.bodies[0]!.level).toBeCloseTo(20)
    expect(input.rawDEM).toEqual(original)
  })
  it('does not turn connected marine-bottom depressions into inland lakes', () => {
    const input = bowl(8)
    for (let i = 0; i < input.rawDEM.length; i++) { input.rawDEM[i] -= 30; input.hydroDEM[i] -= 30 }
    const result = extractDepressionLakes(input)
    expect(result.bodies).toEqual([])
    expect(result.diagnostics.excludedOceanVolume).toBeGreaterThan(0)
  })
  it('keeps adjoining depressions with different spill elevations as separate standing-water bodies', () => {
    const columns = 21, rows = 11, cellSize = 20, rawDEM = new Float32Array(columns * rows).fill(30), hydroDEM = new Float32Array(rawDEM)
    for (let y = 3; y <= 7; y++) for (let x = 3; x <= 7; x++) { const i = y * columns + x; rawDEM[i] = 10; hydroDEM[i] = 16 }
    for (let y = 3; y <= 7; y++) for (let x = 8; x <= 12; x++) { const i = y * columns + x; rawDEM[i] = 20; hydroDEM[i] = 24 }
    const result = extractDepressionLakes({ rawDEM, hydroDEM, columns, rows, cellSize, minimumArea: 1000 })
    expect(result.bodies.map(body => body.level)).toEqual([16, 24])
    expect(result.at({ x: 100, y: 100 })!.level).toBe(16)
    expect(result.at({ x: 200, y: 100 })!.level).toBe(24)
  })
})
