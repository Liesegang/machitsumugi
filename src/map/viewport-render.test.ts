import { describe, expect, it } from 'vitest'
import { drawingSnapshot, rasterTransform } from './viewport-render'
import type { ViewportFrame } from './viewport-render'
import type { CityMap } from '../domain/types'

describe('map raster coordinates', () => {
  it('keeps the same world point under the current cursor after pan, zoom and DPR changes', () => {
    const previous: ViewportFrame = { width: 1200, height: 900, ratio: 2, padding: 96, view: { x: -84.5, y: 31.25, scale: .7 } }
    for (const scale of [.13, .7, 1.63, 4.2]) {
      const current = { ...previous, ratio: 1.25, view: { x: 120.25, y: -215.75, scale } }, transform = rasterTransform(previous, current)
      for (const world of [{ x: 0, y: 0 }, { x: 1234.56, y: 789.12 }, { x: 4000, y: 3000 }]) {
        const oldX = world.x * previous.view.scale + previous.view.x + previous.padding, oldY = world.y * previous.view.scale + previous.view.y + previous.padding
        expect(oldX * transform.scale + transform.x).toBeCloseTo(world.x * scale + current.view.x, 10)
        expect(oldY * transform.scale + transform.y).toBeCloseTo(world.y * scale + current.view.y, 10)
      }
    }
  })
  it('transfers just the displayed snapshot without copying the entire simulated history', () => {
    const map = { width: 4000, height: 3000, config: {}, buildings: [], roads: [], areas: [], railways: [], stations: [], facilities: [], districts: [], description: 'history', parcels: [], timeline: { marker: 'large historical state' }, events: ['event'], regionalContext: { marker: 'wide DEM' }, terrainSurface: { columns: 2, rows: 2, cellSize: 10, elevations: [1, 2, 3, 4] }, previewCrop: [{ x: 1, y: 2 }] } as unknown as CityMap
    const snapshot = drawingSnapshot(map)
    expect(snapshot.timeline).toBeUndefined(); expect(snapshot.events).toBeUndefined(); expect(snapshot.regionalContext).toBeUndefined()
    expect(snapshot.areas).toBe(map.areas); expect(snapshot.terrainSurface).toBe(map.terrainSurface); expect(snapshot.previewCrop).toBe(map.previewCrop)
    expect(map.timeline).toBeDefined(); expect(map.events).toBeDefined()
  })
  it('keeps an exactly settled image at its original full pixel scale', () => {
    const frame: ViewportFrame = { width: 1231, height: 823, ratio: 1.5, padding: 96, view: { x: -312.28, y: 47.935, scale: 1.234 } }
    expect(rasterTransform(frame, frame)).toEqual({ scale: 1, x: -96, y: -96 })
  })
})
