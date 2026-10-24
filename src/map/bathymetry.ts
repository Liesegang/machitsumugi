import type { Point, TerrainSurface } from '../domain/types'
import { createDrawingSurface } from './drawing-surface'
import type { DrawingCanvas } from './drawing-surface'

export type SeaStyle = 'standard' | 'mono' | 'night'
const stops = [0, 5, 20, 80, 200, 800]
const palettes = {
  standard: [[199, 230, 226], [184, 220, 224], [165, 208, 220], [134, 183, 204], [108, 157, 187], [82, 122, 158]],
  mono: [[230, 230, 230], [224, 224, 224], [214, 214, 214], [199, 199, 199], [183, 183, 183], [166, 166, 166]],
  night: [[63, 105, 113], [54, 94, 105], [43, 79, 95], [34, 62, 83], [27, 49, 71], [21, 37, 58]],
} as const

/** Colour follows actual saved bed elevation, never distance to an illustrated
 * coastline. It therefore shows shoals, deeper channels and shelf gradients. */
export function seaDepthRgb(depth: number, style: SeaStyle = 'standard'): [number, number, number] {
  const d = Number.isFinite(depth) ? Math.max(0, depth) : 0
  let index = 0
  while (index < stops.length - 2 && d > stops[index + 1]!) index++
  const t = Math.max(0, Math.min(1, (d - stops[index]!) / (stops[index + 1]! - stops[index]!)))
  const a = palettes[style][index]!, b = palettes[style][index + 1]!
  return [0, 1, 2].map(channel => Math.round(a[channel]! * (1 - t) + b[channel]! * t)) as [number, number, number]
}

export function sampleSurface(surface: TerrainSurface, p: Point) {
  const gx = Math.max(0, Math.min(surface.columns - 1, p.x / surface.cellSize)), gy = Math.max(0, Math.min(surface.rows - 1, p.y / surface.cellSize))
  const x = Math.min(surface.columns - 2, Math.floor(gx)), y = Math.min(surface.rows - 2, Math.floor(gy)), u = gx - x, v = gy - y, i = y * surface.columns + x
  return (surface.elevations[i]! * (1 - u) + surface.elevations[i + 1]! * u) * (1 - v) + (surface.elevations[i + surface.columns]! * (1 - u) + surface.elevations[i + surface.columns + 1]! * u) * v
}

const rasterCache = new WeakMap<TerrainSurface, Map<SeaStyle, DrawingCanvas>>()
export function seaDepthRaster(surface: TerrainSurface, style: SeaStyle) {
  let variants = rasterCache.get(surface)
  if (!variants) { variants = new Map(); rasterCache.set(surface, variants) }
  const cached = variants.get(style)
  if (cached) return cached
  const { canvas, context } = createDrawingSurface(surface.columns, surface.rows), pixels = context.createImageData(canvas.width, canvas.height)
  for (let i = 0; i < surface.elevations.length; i++) {
    const rgb = seaDepthRgb(-surface.elevations[i]!, style)
    pixels.data.set([...rgb, 255], i * 4)
  }
  context.putImageData(pixels, 0, 0); variants.set(style, canvas)
  return canvas
}
