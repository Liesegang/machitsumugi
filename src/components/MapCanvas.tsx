import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LocateFixed, Minus, Plus } from 'lucide-react'
import type { CityMap, Point } from '../domain/types'
import { createMapInspector, featureSummary, featureTitle } from '../map/inspect'
import type { MapFeature } from '../map/inspect'
import { ViewportRenderer } from '../map/viewport-renderer'
import type { Annotation, RenderOptions } from '../map/render'
export interface MapHandle { zoom: (factor: number) => void; fit: () => void; center: (point: Point) => void; getCenter: () => Point }
interface Props { map: CityMap; options: RenderOptions; pinMode: boolean; editPoints?: Point[]; editPolygon?: boolean; onPick: (point: Point, feature?: MapFeature) => void; onAnnotationPick: (pin: Annotation) => void }
interface View { x: number; y: number; scale: number }
export const MapCanvas = forwardRef<MapHandle, Props>(function MapCanvas({ map, options, pinMode, editPoints = [], editPolygon = false, onPick, onAnnotationPick }, ref) {
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<ViewportRenderer | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 })
  const [fittedFor, setFittedFor] = useState('')
  const [hover, setHover] = useState<{ point: Point; feature: MapFeature; map: CityMap; view: View; layers: RenderOptions['layers'] } | null>(null)
  const inspect = useMemo(() => createMapInspector(map), [map])
  const lastHover = useRef(0)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef({ x: 0, y: 0, moved: false })
  const mapIdentity = JSON.stringify(map.config)
  const regionalPreview = map.previewPhase === 'landscape' || map.previewPhase === 'erosion'
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
    const observer = new ResizeObserver(([entry]) => setSize(old => old.width === entry.contentRect.width && old.height === entry.contentRect.height ? old : { width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const fitKey = JSON.stringify([mapIdentity, map.width, map.height, size.width, size.height, regionalPreview])
  // Fit before painting a new extent/configuration. Replacing a worker frame
  // with the next phase of the same map leaves the user's view untouched.
  if (size.width > 0 && size.height > 0 && fittedFor !== fitKey) {
    const scale = (size.width < 850 && !regionalPreview ? Math.max : Math.min)(size.width / map.width, size.height / map.height)
    setFittedFor(fitKey)
    setView({ x: (size.width - map.width * scale) / 2, y: (size.height - map.height * scale) / 2, scale })
  }
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
    const element = canvas.current
    if (!element) return
    const drawing = new ViewportRenderer(element); renderer.current = drawing
    return () => { drawing.dispose(); if (renderer.current === drawing) renderer.current = null }
  }, [])
  useLayoutEffect(() => {
    renderer.current?.update(map, options, { ...size, view, ratio: window.devicePixelRatio || 1 })
  }, [map, options, view, size])
  function pick(client: Point) {
    const rect = canvas.current!.getBoundingClientRect(), point = { x: (client.x - rect.left - view.x) / view.scale, y: (client.y - rect.top - view.y) / view.scale }
    if (point.x < 0 || point.y < 0 || point.x > map.width || point.y > map.height) return
    if (pinMode) return onPick(point)
    const pin = [...options.annotations].reverse().find(item => (options.showSecrets || !item.secret) && Math.hypot((point.x - item.point.x) * view.scale, (point.y - item.point.y) * view.scale + 20) < 24)
    if (pin) return onAnnotationPick(pin)
    onPick(point, inspect(point, 7 / view.scale, options.layers))
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
      onPointerDown={event => { setHover(null); event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); gesture.current = { x: event.clientX, y: event.clientY, moved: false } }}
      onPointerMove={event => {
        const previous = pointers.current.get(event.pointerId)
        if (!previous) {
          if (pinMode || event.pointerType === 'touch' || performance.now() - lastHover.current < 50) return
          lastHover.current = performance.now()
          const rect = event.currentTarget.getBoundingClientRect(), cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
          const point = { x: (cursor.x - view.x) / view.scale, y: (cursor.y - view.y) / view.scale }
          const feature = inspect(point, 7 / view.scale, options.layers)
          setHover(feature ? { point: cursor, feature, map, view, layers: options.layers } : null)
          return
        }
        const current = { x: event.clientX, y: event.clientY }; if (Math.hypot(current.x - gesture.current.x, current.y - gesture.current.y) > 5) gesture.current.moved = true
        if (pointers.current.size === 2) {
          const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)![1], oldDist = Math.hypot(previous.x - other.x, previous.y - other.y), newDist = Math.hypot(current.x - other.x, current.y - other.y), rect = event.currentTarget.getBoundingClientRect()
          if (oldDist > 1) zoomAt(newDist / oldDist, { x: (current.x + other.x) / 2 - rect.left, y: (current.y + other.y) / 2 - rect.top }); gesture.current.moved = true
        } else setView(old => ({ ...old, x: old.x + current.x - previous.x, y: old.y + current.y - previous.y }))
        pointers.current.set(event.pointerId, current)
      }}
      onPointerUp={event => { if (!gesture.current.moved && pointers.current.size === 1) pick({ x: event.clientX, y: event.clientY }); pointers.current.delete(event.pointerId) }}
      onPointerCancel={event => pointers.current.delete(event.pointerId)}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={event => { if (editPoints.length) return; const rect = event.currentTarget.getBoundingClientRect(); zoomAt(1.7, { x: event.clientX - rect.left, y: event.clientY - rect.top }) }} />
    {!!editPoints.length && <svg className="edit-draft" aria-hidden="true" width={size.width} height={size.height}>
      {editPolygon && editPoints.length > 2 ? <polygon points={editPoints.map(p => `${p.x * view.scale + view.x},${p.y * view.scale + view.y}`).join(' ')} /> : <polyline points={editPoints.map(p => `${p.x * view.scale + view.x},${p.y * view.scale + view.y}`).join(' ')} />}
      {editPoints.map((p, i) => <g key={i} transform={`translate(${p.x * view.scale + view.x} ${p.y * view.scale + view.y})`}><circle r="4" /><text x="7" y="-7">{i + 1}</text></g>)}
    </svg>}
    {hover && hover.map === map && hover.view === view && hover.layers === options.layers && !pinMode && <div className="map-hover" role="tooltip" style={{ left: Math.max(6, Math.min(size.width - 226, hover.point.x + 14)), top: Math.max(6, Math.min(size.height - 90, hover.point.y + 14)) }}><strong>{featureTitle(hover.feature)}</strong><span>{featureSummary(hover.feature) || 'クリックで履歴を表示'}</span></div>}
    <div className="scale-bar"><span style={{ width: Math.max(40, scaleMeters * view.scale) }} /><b>{scaleMeters} m</b></div>
    <div className="zoom-controls"><button aria-label="拡大" title="拡大 (+)" onClick={() => zoom(1.4)}><Plus size={19} /></button><button aria-label="縮小" title="縮小 (-)" onClick={() => zoom(1 / 1.4)}><Minus size={19} /></button><button aria-label="地図全体を表示" title="地図全体を表示 (Home)" onClick={fit}><LocateFixed size={19} /></button></div><span className="zoom-label">{Math.round(view.scale / (baseScale || 1) * 100)}%</span>
  </div>
})
