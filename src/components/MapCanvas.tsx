import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { LocateFixed, Minus, Plus } from 'lucide-react'
import type { Building, CityMap, Facility, Point } from '../domain/types'
import { renderMap } from '../map/render'
import type { Annotation, RenderOptions } from '../map/render'
export interface MapHandle { zoom: (factor: number) => void; fit: () => void; center: (point: Point) => void; getCenter: () => Point }
interface Props { map: CityMap; options: RenderOptions; pinMode: boolean; onPick: (point: Point, feature?: Building | Facility) => void; onAnnotationPick: (pin: Annotation) => void }
interface View { x: number; y: number; scale: number }
function contains(point: Point, polygon: Point[]) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j]
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
export const MapCanvas = forwardRef<MapHandle, Props>(function MapCanvas({ map, options, pinMode, onPick, onAnnotationPick }, ref) {
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 })
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef({ x: 0, y: 0, moved: false })
  const baseScale = Math.min(size.width / map.width, size.height / map.height)
  const fit = useCallback(() => {
    if (!size.width || !size.height) return
    const scale = Math.min(size.width / map.width, size.height / map.height)
    setView({ x: (size.width - map.width * scale) / 2, y: (size.height - map.height * scale) / 2, scale })
  }, [size, map.width, map.height])
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const bounds = element.getBoundingClientRect()
    setSize({ width: bounds.width, height: bounds.height })
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (size.width > 0 && size.width < 850) {
      const scale = Math.max(size.width / map.width, size.height / map.height)
      setView({ x: (size.width - map.width * scale) / 2, y: (size.height - map.height * scale) / 2, scale })
    } else fit()
  }, [fit, map, size])
  const zoomAt = useCallback((factor: number, point: Point) => setView(old => {
    const scale = Math.max(baseScale * .6, Math.min(baseScale * 14, old.scale * factor)), ratio = scale / old.scale
    return { scale, x: point.x - (point.x - old.x) * ratio, y: point.y - (point.y - old.y) * ratio }
  }), [baseScale])
  const zoom = useCallback((factor: number) => zoomAt(factor, { x: size.width / 2, y: size.height / 2 }), [zoomAt, size])
  useImperativeHandle(ref, () => ({ zoom, fit, center: point => setView(old => ({ ...old, x: size.width / 2 - point.x * old.scale, y: size.height / 2 - point.y * old.scale })), getCenter: () => ({ x: (size.width / 2 - view.x) / view.scale, y: (size.height / 2 - view.y) / view.scale }) }), [zoom, fit, size, view])
  useEffect(() => {
    const element = canvas.current; if (!element) return
    const wheel = (event: WheelEvent) => { event.preventDefault(); const rect = element.getBoundingClientRect(); zoomAt(Math.exp(-event.deltaY * .0015), { x: event.clientX - rect.left, y: event.clientY - rect.top }) }
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel)
  }, [zoomAt])
  useLayoutEffect(() => {
    const element = canvas.current; if (!element || !size.width || !size.height) return
    const ratio = window.devicePixelRatio || 1; element.width = Math.round(size.width * ratio); element.height = Math.round(size.height * ratio)
    const ctx = element.getContext('2d'); if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.fillStyle = options.style === 'night' ? '#202f37' : '#eef0ea'; ctx.fillRect(0, 0, size.width, size.height)
    ctx.translate(view.x, view.y); ctx.scale(view.scale, view.scale); renderMap(ctx, map, { ...options, scale: view.scale })
  }, [map, options, view, size])
  function pick(client: Point) {
    const rect = canvas.current!.getBoundingClientRect(), point = { x: (client.x - rect.left - view.x) / view.scale, y: (client.y - rect.top - view.y) / view.scale }
    if (point.x < 0 || point.y < 0 || point.x > map.width || point.y > map.height) return
    if (pinMode) return onPick(point)
    const pin = [...options.annotations].reverse().find(item => (options.showSecrets || !item.secret) && Math.hypot((point.x - item.point.x) * view.scale, (point.y - item.point.y) * view.scale + 20) < 24)
    if (pin) return onAnnotationPick(pin)
    const facility = options.layers.facilities ? map.facilities.find(item => Math.hypot(item.point.x - point.x, item.point.y - point.y) < 16 / view.scale) : undefined
    const building = options.layers.buildings ? map.buildings.find(item => contains(point, item.polygon)) : undefined
    onPick(point, facility || building)
  }
  const scaleMeters = view.scale > 1 ? 100 : view.scale > .5 ? 200 : 500
  return <div className={`map-canvas ${pinMode ? 'pin-mode' : ''}`} ref={container}>
    <canvas ref={canvas} aria-label="生成した都市地図。矢印キーで移動、プラス・マイナスで拡大縮小、Homeで全体を表示" tabIndex={0}
      onKeyDown={event => {
        const moves: Record<string, Point> = { ArrowLeft: { x: 80, y: 0 }, ArrowRight: { x: -80, y: 0 }, ArrowUp: { x: 0, y: 80 }, ArrowDown: { x: 0, y: -80 } }
        if (moves[event.key]) { event.preventDefault(); const d = moves[event.key]; setView(old => ({ ...old, x: old.x + d.x, y: old.y + d.y })) }
        if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.3) }
        if (event.key === '-') { event.preventDefault(); zoom(1 / 1.3) }
        if (event.key === 'Home') { event.preventDefault(); fit() }
      }}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); gesture.current = { x: event.clientX, y: event.clientY, moved: false } }}
      onPointerMove={event => {
        const previous = pointers.current.get(event.pointerId); if (!previous) return
        const current = { x: event.clientX, y: event.clientY }; if (Math.hypot(current.x - gesture.current.x, current.y - gesture.current.y) > 5) gesture.current.moved = true
        if (pointers.current.size === 2) {
          const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)![1], oldDist = Math.hypot(previous.x - other.x, previous.y - other.y), newDist = Math.hypot(current.x - other.x, current.y - other.y), rect = event.currentTarget.getBoundingClientRect()
          if (oldDist > 1) zoomAt(newDist / oldDist, { x: (current.x + other.x) / 2 - rect.left, y: (current.y + other.y) / 2 - rect.top }); gesture.current.moved = true
        } else setView(old => ({ ...old, x: old.x + current.x - previous.x, y: old.y + current.y - previous.y }))
        pointers.current.set(event.pointerId, current)
      }}
      onPointerUp={event => { if (!gesture.current.moved && pointers.current.size === 1) pick({ x: event.clientX, y: event.clientY }); pointers.current.delete(event.pointerId) }}
      onPointerCancel={event => pointers.current.delete(event.pointerId)}
      onDoubleClick={event => { const rect = event.currentTarget.getBoundingClientRect(); zoomAt(1.7, { x: event.clientX - rect.left, y: event.clientY - rect.top }) }} />
    <div className="scale-bar"><span style={{ width: Math.max(40, scaleMeters * view.scale) }} /><b>{scaleMeters} m</b></div>
    <div className="zoom-controls"><button aria-label="拡大" title="拡大 (+)" onClick={() => zoom(1.4)}><Plus size={19} /></button><button aria-label="縮小" title="縮小 (-)" onClick={() => zoom(1 / 1.4)}><Minus size={19} /></button><button aria-label="地図全体を表示" title="地図全体を表示 (Home)" onClick={fit}><LocateFixed size={19} /></button></div><span className="zoom-label">{Math.round(view.scale / (baseScale || 1) * 100)}%</span>
  </div>
})
