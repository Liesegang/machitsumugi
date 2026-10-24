import type { CityMap } from '../domain/types'
import { renderMap } from './render'
import type { RenderOptions } from './render'
import type { DrawingCanvas, DrawingContext } from './drawing-surface'

export interface MapView { x: number; y: number; scale: number }
export interface ViewportFrame { width: number; height: number; ratio: number; view: MapView; padding: number }
export interface ViewportRequest extends ViewportFrame { id: number; revision: number; options: RenderOptions }
export type ViewportCommand = { type: 'map'; map: CityMap } | { type: 'render'; request: ViewportRequest }
export type ViewportResult = { type: 'frame'; request: ViewportRequest; bitmap: ImageBitmap } | { type: 'error'; message: string }

/** Geometry is sent once per displayed map. Historical simulation records and
 * the wider erosion context are never needed to paint its current snapshot. */
export function drawingSnapshot(map: CityMap): CityMap {
  return {
    width: map.width, height: map.height, config: map.config, description: '',
    buildings: map.buildings, roads: map.roads, areas: map.areas, railways: map.railways,
    stations: map.stations, facilities: map.facilities, districts: map.districts,
    parcels: map.parcels, terrainSurface: map.terrainSurface, previewPhase: map.previewPhase,
    previewCrop: map.previewCrop, previewSeaLevel: map.previewSeaLevel,
  }
}

export const viewportBackground = (options: RenderOptions) => options.style === 'night' ? '#202f37' : '#eef0ea'

/** The worker and unsupported-browser fallback use the unchanged map painter,
 * at the actual display DPR and zoom. Padding only covers newly exposed edges
 * during a drag; it does not reduce the settled image's resolution. */
export function drawViewport(canvas: DrawingCanvas, context: DrawingContext, map: CityMap, request: ViewportRequest) {
  const { width, height, ratio, view, padding, options } = request
  const pixelsWide = Math.round((width + padding * 2) * ratio), pixelsHigh = Math.round((height + padding * 2) * ratio)
  if (canvas.width !== pixelsWide) canvas.width = pixelsWide
  if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.fillStyle = viewportBackground(options); context.fillRect(0, 0, pixelsWide / ratio, pixelsHigh / ratio)
  context.translate(view.x + padding, view.y + padding); context.scale(view.scale, view.scale)
  renderMap(context, map, { ...options, scale: view.scale })
}

/** Transform a completed raster from its own view to the latest gesture view.
 * Picking and editing continue to use the exact current world coordinates. */
export function rasterTransform(previous: ViewportFrame, current: ViewportFrame) {
  const scale = current.view.scale / previous.view.scale
  return { scale, x: current.view.x - (previous.view.x + previous.padding) * scale, y: current.view.y - (previous.view.y + previous.padding) * scale }
}
