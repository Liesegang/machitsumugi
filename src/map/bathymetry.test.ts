import { expect, it } from 'vitest'
import { sampleSurface, seaDepthRgb } from './bathymetry'

it('distinguishes real shallow and deep sea continuously in every palette', () => {
  for (const style of ['standard', 'mono', 'night'] as const) {
    const shallow = seaDepthRgb(2, style), shelf = seaDepthRgb(80, style), deep = seaDepthRgb(400, style)
    expect(shallow.reduce((a, b) => a + b)).toBeGreaterThan(shelf.reduce((a, b) => a + b))
    expect(shelf.reduce((a, b) => a + b)).toBeGreaterThan(deep.reduce((a, b) => a + b))
    expect(seaDepthRgb(20 - 1e-6, style)).toEqual(seaDepthRgb(20 + 1e-6, style))
  }
})
it('uses the saved bed rather than a synthetic shore-distance band', () => {
  const surface = { columns: 2, rows: 2, cellSize: 100, elevations: [-10, -90, -10, -90] }
  expect(sampleSurface(surface, { x: 50, y: 50 })).toBe(-50)
  expect(sampleSurface(surface, { x: 100, y: 100 })).toBe(-90)
})
