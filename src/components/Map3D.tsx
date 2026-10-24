import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Area, CityMap, Point } from '../domain/types'
import { DEFAULT_LAYERS, renderMap } from '../map/render'
import { clipSegmentToMap, partitionTerrainWater, roadDeckOffsets, roadSurfaceClearance, splitTerrainFace, terrainMeshGrid } from '../map/scene-geometry'
import type { TerrainWaterFragment } from '../map/scene-geometry'
import type { PolygonRegion } from '../domain/geometry'
import { waterGeometry, waterSurfaceElevation } from '../map/water-surfaces'
import { seaDepthRgb } from '../map/bathymetry'
import './Map3D.css'

interface TerrainSurface { columns: number; rows: number; cellSize: number; elevations: number[] }
interface Map3DProps { map: CityMap; className?: string }
type ViewAction = 'reset' | 'left' | 'right' | 'up' | 'down' | 'rotate-left' | 'rotate-right' | 'zoom-in' | 'zoom-out'
const FLOORS_TO_METRES = 3.2
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
function inside(p: Point, ring: Point[]) { let hit = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i]!, b = ring[j]!; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit } return hit }
function cleanRing(ring: Point[]) { return ring.filter((p, i) => !i || distance(p, ring[i - 1]!) > .001).filter((p, i, r) => i !== r.length - 1 || distance(p, r[0]!) > .001) }

/** One GPU buffer per surface category, not one Mesh per house. */
class TriangleBatch {
  positions: number[] = []
  colors: number[] = []
  triangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color, vertexColors?: THREE.Color[]) {
    for (const [i, point] of [a, b, c].entries()) { const value = vertexColors?.[i] ?? color; this.positions.push(point.x, point.y, point.z); this.colors.push(value.r, value.g, value.b) }
  }
  geometry() {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3))
    geometry.computeVertexNormals(); geometry.computeBoundingSphere()
    return geometry
  }
}

function makeCityScene(map: CityMap, surface: TerrainSurface | undefined) {
  const group = new THREE.Group(), grid = terrainMeshGrid(surface, map.width, map.height), height = grid.elevation
  const world = (point: Point, elevation = height(point)) => new THREE.Vector3(point.x - map.width / 2, elevation, point.y - map.height / 2)
  const regions = new Map<string, Area[]>()
  for (const area of map.areas) {
    const minX = Math.floor(Math.min(...area.polygon.map(p => p.x)) / 160), maxX = Math.floor(Math.max(...area.polygon.map(p => p.x)) / 160), minY = Math.floor(Math.min(...area.polygon.map(p => p.y)) / 160), maxY = Math.floor(Math.max(...area.polygon.map(p => p.y)) / 160)
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) { const key = `${x}:${y}`, found = regions.get(key) ?? []; found.push(area); regions.set(key, found) }
  }
  const waterAt = (point: Point) => (regions.get(`${Math.floor(point.x / 160)}:${Math.floor(point.y / 160)}`) ?? []).some(area => area.kind === 'water' && inside(point, area.polygon) && !area.holes?.some(hole => inside(point, hole)))
  const seaAt = (point: Point) => (regions.get(`${Math.floor(point.x / 160)}:${Math.floor(point.y / 160)}`) ?? []).some(area => (area.id === 'sea' || area.id.startsWith('sea-')) && inside(point, area.polygon) && !area.holes?.some(hole => inside(point, hole)))
  const textureCanvas = document.createElement('canvas'), textureWidth = Math.min(4096, Math.max(1024, Math.round(map.width)))
  textureCanvas.width = textureWidth; textureCanvas.height = Math.max(1, Math.round(textureWidth * map.height / map.width))
  const textureContext = textureCanvas.getContext('2d')
  if (!textureContext) throw new Error('地形の描画領域を確保できませんでした')
  textureContext.scale(textureWidth / map.width, textureCanvas.height / map.height)
  // The shared map renderer retains exact natural-cover edges, agricultural
  // ownership units and holes; 25m vertex colours must not redraw them as cells.
  renderMap(textureContext, map, { layers: { ...DEFAULT_LAYERS, buildings: false, roads: false, railway: false, labels: false, facilities: false, grid: false }, annotations: [], showSecrets: false, style: 'standard', scale: textureWidth / map.width })
  const terrainTexture = new THREE.CanvasTexture(textureCanvas); terrainTexture.colorSpace = THREE.SRGBColorSpace
  const { columns, rows } = grid, ground = new THREE.BufferGeometry(), positions: number[] = [], uvs: number[] = [], indices: number[] = [], normals: number[] = []
  const cornerNormals: THREE.Vector3[] = []
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const left = Math.max(0, x - 1), right = Math.min(columns - 1, x + 1), top = Math.max(0, y - 1), bottom = Math.min(rows - 1, y + 1)
    cornerNormals.push(new THREE.Vector3(-(height(grid.point(right, y)) - height(grid.point(left, y))) / ((right - left) * grid.dx), 1, -(height(grid.point(x, bottom)) - height(grid.point(x, top))) / ((bottom - top) * grid.dy)).normalize())
  }
  const groundNormal = (point: Point) => {
    const x = clamp(point.x / grid.dx, 0, columns - 1), y = clamp(point.y / grid.dy, 0, rows - 1), c = Math.min(columns - 2, Math.floor(x)), r = Math.min(rows - 2, Math.floor(y)), u = x - c, v = y - r
    const a = r * columns + c, b = a + 1, d = a + columns + 1, e = a + columns
    const normal = new THREE.Vector3()
    for (const [index, weight] of u + v <= 1 ? [[a, 1 - u - v], [b, u], [e, v]] : [[d, u + v - 1], [e, 1 - u], [b, 1 - v]]) normal.addScaledVector(cornerNormals[index!]!, weight!)
    return normal.normalize()
  }
  const water = new TriangleBatch(), roads = new TriangleBatch(), buildings = new TriangleBatch(), rail = new TriangleBatch()
  const triangulate = (region: PolygonRegion) => {
    const outer = cleanRing(region.polygon), holes = (region.holes ?? []).map(cleanRing).filter(ring => ring.length >= 3)
    if (outer.length < 3) return { points: [], faces: [] }
    return { points: [...outer, ...holes.flat()], faces: THREE.ShapeUtils.triangulateShape(outer.map(p => new THREE.Vector2(p.x, p.y)), holes.map(ring => ring.map(p => new THREE.Vector2(p.x, p.y)))) }
  }
  const emitRegion = (batch: TriangleBatch, region: PolygonRegion, color: THREE.Color, level: (p: Point) => number, colorAt?: (p: Point) => THREE.Color) => {
    const { points, faces } = triangulate(region)
    for (const face of faces) batch.triangle(...face.map(i => world(points[i]!, level(points[i]!))) as [THREE.Vector3, THREE.Vector3, THREE.Vector3], color, colorAt ? face.map(i => colorAt(points[i]!)) : undefined)
  }
  // Split water at the very same triangles as the ground. Union within each
  // triangle removes duplicate confluence faces; standing levels take priority.
  const waterCells = new Map<number, TerrainWaterFragment[]>()
  for (const area of waterGeometry(map.areas).surfaces) {
    const { points, faces } = triangulate(area), level = area.waterLevel ?? (area.id === 'sea' || area.id.startsWith('sea-') ? 0 : undefined)
    for (const face of faces) for (const part of splitTerrainFace(face.map(i => points[i]!), grid)) {
      const list = waterCells.get(part.key) ?? []
      list.push({ polygon: part.polygon, level }); waterCells.set(part.key, list)
    }
  }
  const appendGround = (region: PolygonRegion) => {
    const { points, faces } = triangulate(region)
    for (const face of faces) {
      const a = points[face[0]!]!, b = points[face[1]!]!, c = points[face[2]!]!
      // XY map coordinates become XZ in Three; keep the upward winding.
      const vertices = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0 ? [a, c, b] : [a, b, c]
      for (const point of vertices) { const v = world(point), normal = groundNormal(point); indices.push(positions.length / 3); positions.push(v.x, v.y, v.z); normals.push(normal.x, normal.y, normal.z); uvs.push(point.x / map.width, 1 - point.y / map.height) }
    }
  }
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const point = { x: x / (columns - 1) * map.width, y: y / (rows - 1) * map.height }, v = world(point)
    const normal = cornerNormals[y * columns + x]!
    positions.push(v.x, v.y, v.z); normals.push(normal.x, normal.y, normal.z); uvs.push(x / (columns - 1), 1 - y / (rows - 1))
  }
  for (let y = 0; y < rows - 1; y++) for (let x = 0; x < columns - 1; x++) for (const upper of [false, true]) {
    const key = grid.key(x, y, upper), fragments = waterCells.get(key)
    if (!fragments) { const a = y * columns + x, b = a + 1, c = a + columns, d = c + 1; indices.push(...upper ? [b, c, d] : [a, c, b]); continue }
    const partition = partitionTerrainWater(grid.triangle(x, y, upper), fragments)
    for (const visible of partition.surfaces) {
      const centre = visible.polygon.reduce((sum, p) => ({ x: sum.x + p.x / visible.polygon.length, y: sum.y + p.y / visible.polygon.length }), { x: 0, y: 0 })
      const colour = seaAt(centre) ? (p: Point) => { const rgb = seaDepthRgb(-height(p)); return new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace) } : undefined
      emitRegion(water, visible, new THREE.Color('#9cc8d2'), p => waterSurfaceElevation({ id: 'surface', kind: 'water', polygon: visible.polygon, waterLevel: visible.level }, p, height), colour)
    }
    // There is no second ground face behind/above the water. Island holes stay
    // in the dry remainder, rather than relying on depth bias to hide a conflict.
    for (const dry of partition.dry) appendGround(dry)
  }
  // Clipped shoreline vertices share the DEM's smooth shading normals; making
  // each clipped face independently flat-shaded would expose a triangle fringe.
  ground.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); ground.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3)); ground.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); ground.setIndex(indices)
  group.add(new THREE.Mesh(ground, new THREE.MeshStandardMaterial({ map: terrainTexture, roughness: 1, metalness: 0 })))
  const ribbon = (batch: TriangleBatch, points: Point[], width: number, color: THREE.Color, level: (p: Point, endIndex: number, fraction: number) => number) => {
    for (let i = 1; i < points.length; i++) {
      const clipped = clipSegmentToMap(points[i - 1]!, points[i]!, map.width, map.height, width / 2)
      if (!clipped) continue
      const a = clipped.from, b = clipped.to, length = distance(a, b)
      if (length < .001) continue
      const nx = -(b.y - a.y) / length * width / 2, ny = (b.x - a.x) / length * width / 2
      const face = [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }]
      for (const part of splitTerrainFace(face, grid)) emitRegion(batch, part, color, p => {
        const t = clamp(((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (length * length), 0, 1)
        return level(p, i, clipped.start + (clipped.end - clipped.start) * t)
      })
    }
  }
  for (const road of map.roads) {
    const clearance = roadSurfaceClearance(road), offsets = roadDeckOffsets(road), levels = road.points.map((point, i) => height(point) + clearance + offsets[i]!), chainage = [0], bridgeSegments = new Set<number>()
    for (let i = 1; i < road.points.length; i++) chainage[i] = chainage[i - 1]! + distance(road.points[i - 1]!, road.points[i]!)
    // A bridge flag describes the route's project history. Only its actual
    // water spans get a deck; lifting the entire regional route would turn
    // kilometres of ordinary streets into a floating viaduct.
    if (road.bridge || road.role === 'bridge') for (let i = 0; i < road.points.length; i++) {
      if (!waterAt(road.points[i]!)) continue
      const first = Math.max(0, i - 1)
      while (i + 1 < road.points.length && waterAt(road.points[i + 1]!)) i++
      const last = Math.min(road.points.length - 1, i + 1), start = levels[first]!, end = levels[last]!, span = chainage[last]! - chainage[first]!
      for (let j = first; j <= last; j++) levels[j] = start + (end - start) * (chainage[j]! - chainage[first]!) / (span || 1) + 1.5
      for (let j = first + 1; j <= last; j++) bridgeSegments.add(j)
    }
    const extra = levels.map((z, i) => z - height(road.points[i]!) - clearance)
    ribbon(roads, road.points, road.width, new THREE.Color(road.role === 'expressway' ? '#85b39c' : road.role === 'ramp' ? '#a4c2ad' : road.kind === 'arterial' ? '#e4c575' : road.role === 'farm' ? '#d5d1bc' : '#f1eee5'), (p, i, t) => bridgeSegments.has(i) ? levels[i - 1]! * (1 - t) + levels[i]! * t : height(p) + clearance + extra[i - 1]! * (1 - t) + extra[i]! * t)
  }
  for (const parcel of map.parcels ?? []) if (parcel.developedYear && parcel.retiredYear === undefined && parcel.access?.length) ribbon(roads, parcel.access, 2.8, new THREE.Color('#f1eee5'), p => height(p) + .18)
  for (const line of map.railways) {
    const levels = (p: Point, i: number, t: number) => (line.elevations ? line.elevations[i - 1]! * (1 - t) + line.elevations[i]! * t : height(p)) + .9
    ribbon(rail, line.points, 5, new THREE.Color('#938f80'), levels)
    ribbon(rail, line.points, 1.4, new THREE.Color('#434b48'), (p, i, t) => levels(p, i, t) + .12)
  }
  for (const building of map.buildings) {
    const polygon = cleanRing(building.polygon)
    if (polygon.length < 3) continue
    const floor = Math.max(...polygon.map(height)) + .3, top = floor + Math.max(1, building.height) * FLOORS_TO_METRES
    const color = new THREE.Color(building.occupancy === 'vacant' ? '#a49d8e' : building.kind === 'industrial' ? '#bcb5a0' : building.kind === 'public' ? '#a6b6b8' : building.kind === 'commercial' ? '#c4ad9e' : '#d3cebf'), roof = color.clone().multiplyScalar(.83)
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, pa = world(a, height(a) + .2), pb = world(b, height(b) + .2), pc = world(a, top), pd = world(b, top)
      buildings.triangle(pa, pb, pc, color); buildings.triangle(pb, pd, pc, color)
    }
    const faces = THREE.ShapeUtils.triangulateShape(polygon.map(p => new THREE.Vector2(p.x, p.y)), [])
    for (const face of faces) buildings.triangle(...face.map(i => world(polygon[i]!, top)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3], roof)
  }
  for (const [batch, unlit] of [[water, true], [roads, true], [rail, true], [buildings, false]] as const) if (batch.positions.length) {
    const material = unlit ? new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }) : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9, side: THREE.DoubleSide })
    group.add(new THREE.Mesh(batch.geometry(), material))
  }
  return { group, height }
}

export function Map3D({ map, className = '' }: Map3DProps) {
  const host = useRef<HTMLDivElement>(null), actions = useRef<(action: ViewAction) => void>(() => {})
  const [renderState, setRenderState] = useState<{ map: CityMap | null; status: 'loading' | 'ready' | 'unsupported' }>({ map: null, status: 'loading' })
  const status = renderState.map === map ? renderState.status : 'loading'
  const surface = (map as CityMap & { terrainSurface?: TerrainSurface }).terrainSurface
  useEffect(() => {
    const element = host.current
    if (!element) return
    let active = true
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' }) }
    catch { queueMicrotask(() => { if (active) setRenderState({ map, status: 'unsupported' }) }); return () => { active = false } }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8)); renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setClearColor('#edf0e9'); renderer.domElement.tabIndex = 0; renderer.domElement.setAttribute('aria-label', `${map.config.name}の立体地図。矢印キーで移動できます`)
    element.appendChild(renderer.domElement)
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(42, 1, 1, 30000), controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true; controls.dampingFactor = .1; controls.minDistance = 45; controls.maxDistance = 15000; controls.maxPolarAngle = Math.PI * .485; controls.screenSpacePanning = false; controls.listenToKeyEvents(renderer.domElement)
    scene.add(new THREE.HemisphereLight('#ffffff', '#a3aa8c', 2))
    const sun = new THREE.DirectionalLight('#fff9e9', 2.4); sun.position.set(-1800, 3000, -1000); scene.add(sun)
    let frame = 0, centerElevation = 0, model: THREE.Group | undefined
    const invalidate = () => { if (!frame && active) frame = requestAnimationFrame(draw) }
    const draw = () => { frame = 0; if (!active) return; const moving = controls.update(); renderer.render(scene, camera); if (moving) invalidate() }
    controls.addEventListener('change', invalidate)
    const reset = () => { controls.target.set(0, centerElevation, 0); camera.position.set(map.width * .55, map.width * .72 + centerElevation, map.height * .95); controls.update(); invalidate() }
    const resize = () => { const width = element.clientWidth, height = element.clientHeight; if (!width || !height) return; camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height); invalidate() }
    const observer = new ResizeObserver(resize); observer.observe(element)
    const contextLost = (event: Event) => { event.preventDefault(); setRenderState({ map, status: 'unsupported' }) }
    renderer.domElement.addEventListener('webglcontextlost', contextLost)
    const build = requestAnimationFrame(() => {
      if (!active) return
      try { const city = makeCityScene(map, surface); model = city.group; scene.add(model); centerElevation = city.height({ x: map.width / 2, y: map.height / 2 }); reset(); resize(); setRenderState({ map, status: 'ready' }) }
      catch { setRenderState({ map, status: 'unsupported' }) }
    })
    actions.current = action => {
      if (action === 'reset') { reset(); return }
      const offset = camera.position.clone().sub(controls.target)
      if (action === 'rotate-left' || action === 'rotate-right') offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), action === 'rotate-left' ? -.28 : .28)
      else if (action === 'zoom-in' || action === 'zoom-out') offset.multiplyScalar(action === 'zoom-in' ? .8 : 1.25)
      else {
        const forward = offset.clone().setY(0).normalize(), right = new THREE.Vector3(forward.z, 0, -forward.x), step = offset.length() * .08
        const move = (action === 'left' || action === 'right' ? right : forward).multiplyScalar((action === 'left' || action === 'up' ? -1 : 1) * step)
        controls.target.add(move)
      }
      camera.position.copy(controls.target).add(offset); controls.update(); invalidate()
    }
    reset(); resize()
    return () => {
      active = false; cancelAnimationFrame(build); cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); actions.current = () => {}
      renderer.domElement.removeEventListener('webglcontextlost', contextLost)
      model?.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); const materials = Array.isArray(object.material) ? object.material : [object.material]; for (const material of materials) { if ('map' in material && material.map instanceof THREE.Texture) material.map.dispose(); material.dispose() } } })
      renderer.dispose(); renderer.domElement.remove()
    }
  }, [map, surface])
  const buttons: { action: ViewAction; label: string; icon: string }[] = [{ action: 'rotate-left', label: '左へ回転', icon: '↶' }, { action: 'rotate-right', label: '右へ回転', icon: '↷' }, { action: 'zoom-in', label: '拡大', icon: '+' }, { action: 'zoom-out', label: '縮小', icon: '−' }, { action: 'left', label: '左へ移動', icon: '←' }, { action: 'up', label: '奥へ移動', icon: '↑' }, { action: 'down', label: '手前へ移動', icon: '↓' }, { action: 'right', label: '右へ移動', icon: '→' }]
  return <section className={`map-3d ${className}`} aria-label="立体地図">
    <div ref={host} className="map-3d-canvas" />
    {status === 'loading' && <div className="map-3d-status" role="status">地形と建物を立ち上げています…</div>}
    {status === 'unsupported' && <div className="map-3d-status" role="status">この環境では3Dを表示できません。2D表示をご利用ください。</div>}
    {status === 'ready' && <>
      <div className="map-3d-note"><strong>地形と建物の高さ</strong><span>建物高は1階あたり約3.2mの仮定です</span>{!surface && <span>この保存地図には標高がないため平面地形で表示</span>}</div>
      <div className="map-3d-controls" aria-label="地図の視点操作">{buttons.map(button => <button key={button.action} type="button" aria-label={button.label} title={button.label} onClick={() => actions.current(button.action)}>{button.icon}</button>)}<button className="map-3d-reset" type="button" onClick={() => actions.current('reset')}>視点を戻す</button></div>
      <p className="map-3d-help">ドラッグで回転 · 右ドラッグで移動 · ホイールで拡大縮小</p>
    </>}
  </section>
}
export default Map3D
