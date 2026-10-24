import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ViewportRenderer } from './viewport-renderer'
import type { CityMap } from '../domain/types'
import type { RenderOptions } from './render'
import type { ViewportCommand, ViewportRequest } from './viewport-render'

const draw = vi.hoisted(() => vi.fn())
vi.mock('./render', () => ({ renderMap: draw }))

class DrawingWorker {
  static all: DrawingWorker[] = []
  messages: ViewportCommand[] = []
  onmessage?: (event: { data: unknown }) => void
  onerror?: () => void
  terminate = vi.fn()
  constructor() { DrawingWorker.all.push(this) }
  postMessage(message: ViewportCommand) { this.messages.push(message) }
  finish(request: ViewportRequest, bitmap = { width: 1392, height: 1092, close: vi.fn() }) { this.onmessage?.({ data: { type: 'frame', request, bitmap } }); return bitmap }
  requests() { return this.messages.filter((m): m is Extract<ViewportCommand, { type: 'render' }> => m.type === 'render').map(m => m.request) }
}

const map = { width: 4000, height: 3000, config: {}, buildings: [], roads: [], areas: [], railways: [], stations: [], facilities: [], districts: [], description: '' } as unknown as CityMap
const options = { layers: { buildings: true, roads: true, railway: true, labels: true, facilities: true, terrain: true, grid: false }, style: 'standard', annotations: [], showSecrets: false, scale: 1 } satisfies RenderOptions
const viewport = { width: 1200, height: 900, ratio: 2, view: { x: 0, y: 0, scale: .3 } }
let frames: FrameRequestCallback[], context: { setTransform: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn>; translate: ReturnType<typeof vi.fn>; scale: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.useFakeTimers()
  DrawingWorker.all = []; frames = []; draw.mockClear()
  context = { setTransform: vi.fn(), fillRect: vi.fn(), translate: vi.fn(), scale: vi.fn(), drawImage: vi.fn() }
  vi.stubGlobal('Worker', DrawingWorker); vi.stubGlobal('OffscreenCanvas', class {})
  vi.stubGlobal('window', { clearTimeout, setTimeout })
  vi.stubGlobal('document', { createElement: () => canvas() })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
const canvas = () => {
  let width = 0, height = 0
  return { get width() { return width }, set width(value: number) { width = value }, get height() { return height }, set height(value: number) { height = value }, getContext: () => context } as unknown as HTMLCanvasElement
}
const flush = () => { const callbacks = frames; frames = []; for (const callback of callbacks) callback(0) }

describe('bounded background map drawing', () => {
  it('coalesces a drag to one in-flight render and the newest pending view', () => {
    const renderer = new ViewportRenderer(canvas()), worker = DrawingWorker.all[0]!
    renderer.update(map, options, viewport)
    for (let i = 1; i <= 120; i++) renderer.update(map, options, { ...viewport, view: { ...viewport.view, x: i } })
    expect(worker.messages.filter(m => m.type === 'map')).toHaveLength(1)
    expect(worker.requests()).toHaveLength(1)
    const bitmap = worker.finish(worker.requests()[0]!)
    expect(worker.requests()).toHaveLength(2)
    expect(worker.requests()[1]!.view.x).toBe(120)
    flush(); expect(context.drawImage).toHaveBeenCalledTimes(1)
    expect(draw).not.toHaveBeenCalled()
    worker.finish(worker.requests()[1]!); expect(bitmap.close).toHaveBeenCalledTimes(1)
    renderer.dispose()
  })
  it('never shows a stale old map or old layer bitmap after the displayed snapshot changes', () => {
    const renderer = new ViewportRenderer(canvas()), worker = DrawingWorker.all[0]!
    renderer.update(map, options, viewport)
    renderer.update({ ...map }, { ...options, style: 'night' }, viewport)
    const old = worker.finish(worker.requests()[0]!)
    flush(); expect(old.close).toHaveBeenCalledTimes(1); expect(context.drawImage).not.toHaveBeenCalled()
    const current = worker.finish(worker.requests()[1]!); flush(); expect(context.drawImage).toHaveBeenCalledTimes(1)
    renderer.dispose(); expect(current.close).toHaveBeenCalledTimes(1); expect(worker.terminate).toHaveBeenCalledTimes(1)
    const late = worker.finish(worker.requests()[1]!); expect(late.close).toHaveBeenCalledTimes(1)
  })
  it('does not resize the live canvas again for a pan, preserving its backing buffer', () => {
    const live = canvas(), renderer = new ViewportRenderer(live), worker = DrawingWorker.all[0]!
    renderer.update(map, options, viewport); worker.finish(worker.requests()[0]!); flush()
    expect(live.width).toBe(2400); expect(live.height).toBe(1800)
    const width = vi.spyOn(live, 'width', 'set')
    renderer.update(map, options, { ...viewport, view: { ...viewport.view, x: -180 } }); flush()
    expect(width).not.toHaveBeenCalled()
    renderer.dispose()
  })
  it('keeps the complete painter as a bounded fallback when worker canvases are unavailable', () => {
    vi.stubGlobal('Worker', undefined)
    const renderer = new ViewportRenderer(canvas())
    renderer.update(map, options, viewport); vi.advanceTimersByTime(0); flush()
    expect(draw).toHaveBeenCalledTimes(1)
    for (let i = 1; i <= 120; i++) renderer.update(map, options, { ...viewport, view: { x: i, y: -i, scale: .75 } })
    flush(); expect(context.drawImage).toHaveBeenCalled(); expect(draw).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(79); expect(draw).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1); expect(draw).toHaveBeenCalledTimes(2)
    expect(draw.mock.calls[1]![2]).toEqual({ ...options, scale: .75 })
    renderer.update(map, options, viewport); renderer.dispose(); vi.advanceTimersByTime(1000)
    expect(draw).toHaveBeenCalledTimes(2)
  })
})
