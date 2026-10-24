import type { CityMap } from '../domain/types'
import { createDrawingSurface } from './drawing-surface'
import type { DrawingCanvas, DrawingContext } from './drawing-surface'
import type { RenderOptions } from './render'
import { drawingSnapshot, drawViewport, rasterTransform, viewportBackground } from './viewport-render'
import type { ViewportFrame, ViewportRequest, ViewportResult } from './viewport-render'

interface Raster { image: ImageBitmap | DrawingCanvas; request: ViewportRequest }
/** Keep one draw in flight and one latest request, rather than queuing every
 * pointer event. The main thread only composites the last completed image. */
export class ViewportRenderer {
  private canvas: HTMLCanvasElement
  private worker?: Worker
  private context: CanvasRenderingContext2D
  private map?: CityMap
  private sentMap?: CityMap
  private optionsKey = ''
  private revision = 0
  private serial = 0
  private busy = false
  private pending?: ViewportRequest
  private current?: ViewportRequest
  private raster?: Raster
  private frame = 0
  private fallbackTimer = 0
  private fallback?: { canvas: DrawingCanvas; context: DrawingContext }
  private disposed = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('地図の描画領域を確保できませんでした')
    this.context = context
    if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./viewport-render.worker.ts', import.meta.url), { type: 'module' })
        this.worker.onmessage = (event: MessageEvent<ViewportResult>) => {
          if (event.data.type === 'error') { this.useFallback(); return }
          const { bitmap, request } = event.data
          this.busy = false
          if (!this.disposed && request.revision === this.revision) {
            this.releaseRaster(); this.raster = { image: bitmap, request }; this.invalidate()
          } else bitmap.close()
          this.submit()
        }
        this.worker.onerror = () => this.useFallback()
      } catch { this.worker = undefined }
    }
  }

  update(map: CityMap, options: RenderOptions, viewport: Omit<ViewportFrame, 'padding'>) {
    if (this.disposed || !viewport.width || !viewport.height) return
    const optionsKey = JSON.stringify([options.layers, options.style, options.annotations, options.showSecrets, options.contours])
    if (this.map !== map || this.optionsKey !== optionsKey) {
      this.map = map; this.optionsKey = optionsKey; this.revision++; this.releaseRaster()
    }
    const request = { ...viewport, view: { ...viewport.view }, padding: 96, id: ++this.serial, revision: this.revision, options }
    this.current = request; this.pending = request
    this.invalidate(); this.submit()
  }

  private invalidate() {
    if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint() })
  }

  private paint() {
    const request = this.current
    if (!request || this.disposed) return
    const { width, height, ratio, options } = request, pixelsWide = Math.round(width * ratio), pixelsHigh = Math.round(height * ratio)
    if (this.canvas.width !== pixelsWide) this.canvas.width = pixelsWide
    if (this.canvas.height !== pixelsHigh) this.canvas.height = pixelsHigh
    const context = this.context
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.fillStyle = viewportBackground(options); context.fillRect(0, 0, width, height)
    if (!this.raster) return
    const { image, request: previous } = this.raster, transform = rasterTransform(previous, request)
    context.translate(transform.x, transform.y); context.scale(transform.scale, transform.scale)
    context.drawImage(image, 0, 0, image.width / previous.ratio, image.height / previous.ratio)
  }

  private submit() {
    if (this.disposed || !this.pending) return
    if (this.worker) {
      if (this.busy) return
      const request = this.pending; this.pending = undefined; this.busy = true
      if (this.map && this.sentMap !== this.map) {
        this.worker.postMessage({ type: 'map', map: drawingSnapshot(this.map) }); this.sentMap = this.map
      }
      this.worker.postMessage({ type: 'render', request })
      return
    }
    // A browser without worker canvases still gets immediate cached gestures.
    // Its expensive exact redraw waits for the gesture to pause.
    window.clearTimeout(this.fallbackTimer)
    this.fallbackTimer = window.setTimeout(() => {
      const request = this.pending
      if (!request || !this.map || this.disposed) return
      this.pending = undefined
      this.fallback ??= createDrawingSurface(1, 1)
      drawViewport(this.fallback.canvas, this.fallback.context, this.map, request)
      this.releaseRaster(); this.raster = { image: this.fallback.canvas, request }; this.paint()
    }, this.raster ? 80 : 0)
  }

  private useFallback() {
    this.worker?.terminate(); this.worker = undefined; this.busy = false
    this.pending = this.current; this.submit()
  }

  private releaseRaster() {
    if (this.raster && 'close' in this.raster.image) this.raster.image.close()
    this.raster = undefined
  }

  dispose() {
    this.disposed = true; this.worker?.terminate(); cancelAnimationFrame(this.frame); window.clearTimeout(this.fallbackTimer)
    this.releaseRaster(); this.pending = undefined; this.current = undefined; this.map = undefined; this.sentMap = undefined; this.fallback = undefined
  }
}
