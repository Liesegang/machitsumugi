import type { CityMap } from '../domain/types'
import { drawViewport } from './viewport-render'
import type { ViewportCommand, ViewportResult } from './viewport-render'

let map: CityMap | undefined
// Complex vector strokes are rasterized off the UI/GPU presentation queue.
// The finished bitmap is then composited by the page without replaying paths.
const canvas = new OffscreenCanvas(1, 1), context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
globalThis.onmessage = (event: MessageEvent<ViewportCommand>) => {
  const command = event.data
  if (command.type === 'map') { map = command.map; return }
  if (!map) return
  try {
    drawViewport(canvas, context, map, command.request)
    const bitmap = canvas.transferToImageBitmap(), result: ViewportResult = { type: 'frame', request: command.request, bitmap }
    globalThis.postMessage(result, { transfer: [bitmap] })
  } catch (error) {
    const result: ViewportResult = { type: 'error', message: error instanceof Error ? error.message : String(error) }
    globalThis.postMessage(result)
  }
}
