/** The same raster helpers run in the page and in the map drawing worker. */
export type DrawingCanvas = HTMLCanvasElement | OffscreenCanvas
export type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export function createDrawingSurface(width: number, height: number): { canvas: DrawingCanvas; context: DrawingContext } {
  const canvas = typeof document === 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d') as DrawingContext | null
  if (!context) throw new Error('地図の描画領域を確保できませんでした')
  return { canvas, context }
}
