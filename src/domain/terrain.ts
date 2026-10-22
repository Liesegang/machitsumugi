import type { Area, CityType, Point, Terrain } from './types'
import { getRegionalTerrain, sampleRegional } from './regional-terrain.ts'
import type { RegionalTerrain } from './regional-terrain.ts'

export interface TerrainModelInput {
  width: number
  height: number
  seed: string
  terrain: Terrain
  forest: number
  type: CityType
}

export interface TerrainModel {
  areas: Area[]
  elevation: (point: Point) => number
  slope: (point: Point) => number
  waterAt: (point: Point) => boolean
  bridgeSites: Point[]
  cityOrigin: Point
  landform: (point: Point) => 'water' | 'valley' | 'terrace' | 'hillside' | 'ridge'
  wetness: (point: Point) => number
  terrainCost: (point: Point) => number
  cultivable: (point: Point) => boolean
  rivers: TerrainRiver[]
  bridgeCandidates: { point: Point; bankA: Point; bankB: Point; width: number; cost: number; riverId: string }[]
  hydrology: RegionalTerrain & { cropOrigin: Point; frame: { worldAnchor: Point; localAnchor: Point; angle: number; mirrored: boolean }; localResolution: number; localDEM: Float32Array; localColumns: number; localRows: number }
}
export interface TerrainRiver { id: string; points: Point[]; widths: number[]; drainageArea: number[]; surfaceElevation: number[] }

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const smooth = (t: number) => t * t * (3 - 2 * t)
function seedNumber(seed: string) {
  let n = 2166136261
  for (const c of seed) n = Math.imul(n ^ c.charCodeAt(0), 16777619)
  return n >>> 0
}
function noise(seed: number, x: number, y: number) {
  const hash = (i: number, j: number) => {
    let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ seed
    n = Math.imul(n ^ n >>> 13, 1274126177)
    return ((n ^ n >>> 16) >>> 0) / 4294967295
  }
  const i = Math.floor(x), j = Math.floor(y), u = smooth(x - i), v = smooth(y - j)
  return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v
}
function inside(point: Point, polygon: Point[]) {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}
function area(polygon: Point[]) {
  return polygon.reduce((sum, p, i) => {
    const q = polygon[(i + 1) % polygon.length]!
    return sum + p.x * q.y - q.x * p.y
  }, 0) / 2
}
function simplifyLine(path: Point[], tolerance: number): Point[] {
  if (path.length < 3) return path
  const a = path[0]!, b = path.at(-1)!, dx = b.x - a.x, dy = b.y - a.y
  let farthest = 0, distance = tolerance
  for (let i = 1; i < path.length - 1; i++) {
    const p = path[i]!, t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
    const d = Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t)
    if (d > distance) { distance = d; farthest = i }
  }
  return farthest ? [...simplifyLine(path.slice(0, farthest + 1), tolerance).slice(0, -1), ...simplifyLine(path.slice(farthest), tolerance)] : [a, b]
}
function simplifyLoop(polygon: Point[], tolerance: number) {
  let farthest = 1
  for (let i = 2; i < polygon.length; i++) if (Math.hypot(polygon[i]!.x - polygon[0]!.x, polygon[i]!.y - polygon[0]!.y) > Math.hypot(polygon[farthest]!.x - polygon[0]!.x, polygon[farthest]!.y - polygon[0]!.y)) farthest = i
  return [...simplifyLine(polygon.slice(0, farthest + 1), tolerance).slice(0, -1), ...simplifyLine([...polygon.slice(farthest), polygon[0]!], tolerance).slice(0, -1)]
}
function soften(polygon: Point[], iterations: number, width: number, height: number) {
  let result = polygon
  for (let pass = 0; pass < iterations; pass++) {
    const next: Point[] = []
    for (let i = 0; i < result.length; i++) {
      const p = result[i]!, q = result[(i + 1) % result.length]!
      if ((p.x === 0 || p.x === width) && (p.y === 0 || p.y === height)) next.push(p)
      next.push({ x: p.x * .75 + q.x * .25, y: p.y * .75 + q.y * .25 }, { x: p.x * .25 + q.x * .75, y: p.y * .25 + q.y * .75 })
    }
    result = next
  }
  return result
}

/** Remove tiny offset-bank loops where bend radius is smaller than half-width. */
function cleanBank(path: Point[]) {
  let result = path
  for (let guard = 0; guard < path.length; guard++) {
    let changed = false
    outer: for (let i = 0; i < result.length - 1; i++) for (let j = i + 2; j < result.length - 1; j++) {
      const a = result[i]!, b = result[i + 1]!, c = result[j]!, d = result[j + 1]!
      const ax = b.x - a.x, ay = b.y - a.y, bx = d.x - c.x, by = d.y - c.y, det = ax * by - ay * bx
      if (Math.abs(det) < 1e-10) continue
      const t = ((c.x - a.x) * by - (c.y - a.y) * bx) / det, u = ((c.x - a.x) * ay - (c.y - a.y) * ax) / det
      if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue
      result = [...result.slice(0, i + 1), { x: a.x + ax * t, y: a.y + ay * t }, ...result.slice(j + 1)]
      changed = true; break outer
    }
    if (!changed) break
  }
  return result
}

/** Trace contour masks as connected woodland boundaries, rather than isolated ellipse stamps. */
function contours(mask: boolean[][], stepX: number, stepY: number) {
  type Edge = { a: Point; b: Point; direction: number; used: boolean }
  const edges: Edge[] = [], outgoing = new Map<string, Edge[]>()
  const key = (p: Point) => `${p.x}:${p.y}`
  const occupied = (x: number, y: number) => mask[y]?.[x] === true
  const add = (a: Point, b: Point, direction: number) => {
    const edge = { a, b, direction, used: false }
    edges.push(edge)
    const group = outgoing.get(key(a)) ?? []; group.push(edge); outgoing.set(key(a), group)
  }
  for (let y = 0; y < mask.length; y++) for (let x = 0; x < mask[y]!.length; x++) {
    if (!occupied(x, y)) continue
    if (!occupied(x, y - 1)) add({ x, y }, { x: x + 1, y }, 0)
    if (!occupied(x + 1, y)) add({ x: x + 1, y }, { x: x + 1, y: y + 1 }, 1)
    if (!occupied(x, y + 1)) add({ x: x + 1, y: y + 1 }, { x, y: y + 1 }, 2)
    if (!occupied(x - 1, y)) add({ x, y: y + 1 }, { x, y }, 3)
  }
  const polygons: Point[][] = []
  const priority = [1, 0, 3, 2]
  for (const first of edges) {
    if (first.used) continue
    const path: Point[] = []
    let edge: Edge | undefined = first
    for (let guard = 0; edge && guard <= edges.length; guard++) {
      edge.used = true; path.push({ x: edge.a.x * stepX, y: edge.a.y * stepY })
      if (key(edge.b) === key(first.a)) break
      const direction: number = edge.direction
      edge = (outgoing.get(key(edge.b)) ?? []).filter(candidate => !candidate.used).sort((a, b): number => priority.indexOf((a.direction - direction + 4) % 4) - priority.indexOf((b.direction - direction + 4) % 4))[0]
    }
    if (path.length > 5 && area(path) > 12_000) polygons.push(soften(simplifyLoop(path, Math.max(stepX, stepY) * .8), 3, mask[0]!.length * stepX, mask.length * stepY))
  }
  return polygons
}

/** Regional watershed formation precedes urban site choice and the local map crop. */
export function createTerrainModel(input: TerrainModelInput): TerrainModel {
  const { width: w, height: h } = input, world = getRegionalTerrain(input.seed), seed = seedNumber(`${input.seed}:local-terrain-v4`)
  const worldPoint = (i: number): Point => ({ x: i % world.columns * world.resolution, y: Math.floor(i / world.columns) * world.resolution })
  const indexAt = (p: Point) => Math.round(clamp(p.y / world.resolution, 0, world.rows - 1)) * world.columns + Math.round(clamp(p.x / world.resolution, 0, world.columns - 1))
  const worldSlope = (i: number) => {
    const x = i % world.columns, y = Math.floor(i / world.columns)
    if (!x || !y || x === world.columns - 1 || y === world.rows - 1) return 1
    return Math.hypot(world.rawDEM[i + 1]! - world.rawDEM[i - 1]!, world.rawDEM[i + world.columns]! - world.rawDEM[i - world.columns]!) / (2 * world.resolution)
  }
  let pivot = -1, score = Infinity
  for (let i = 0; i < world.rawDEM.length; i++) {
    const p = worldPoint(i), catchment = world.accumulatedArea[i]!, z = world.rawDEM[i]!, next = world.flowTo[i]!
    if (p.x < 3500 || p.x > world.extent - 3500 || p.y < 3500 || p.y > world.extent - (input.terrain === 'coast' ? 500 : 2100) || world.ocean[i]) continue
    if (input.terrain === 'plain') {
      if (z < 28 || z > 150 || catchment > 300_000 || worldSlope(i) > .035) continue
      let surroundings = 0
      for (const [dx, dy] of [[-8, 0], [8, 0], [0, -8], [0, 8]]) surroundings += worldSlope(i + dy! * world.columns + dx!)
      if (surroundings > .17) continue
      const cost = Math.abs(p.x / world.extent - .71) + Math.abs(p.y / world.extent - .54) + worldSlope(i) * 12 + surroundings * 4
      if (cost < score) { score = cost; pivot = i }
    } else if (input.terrain === 'coast') {
      if (next < 0 || !world.ocean[next] || catchment < 5_000_000) continue
      const cost = -Math.log(catchment) + Math.abs(p.x / world.extent - .57) * .5
      if (cost < score) { score = cost; pivot = i }
    } else {
      if (catchment < 12_000_000 || z < 28 || z > 270 || worldSlope(i) > .13) continue
      const cost = Math.abs(p.x / world.extent - .59) * 2 + Math.abs(p.y / world.extent - .53) * 1.5 + Math.abs(Math.log(catchment / 55_000_000)) * .12
      if (cost < score) { score = cost; pivot = i }
    }
  }
  if (pivot < 0) pivot = indexAt({ x: world.extent * .59, y: world.extent * (input.terrain === 'coast' ? .80 : .55) })
  // The viewport is a surveyed window into the entire regional watershed. A
  // fixed river-at-68% crop made every seed have the same west-bank composition.
  // Transform *all* regional sampling, including the DEM and ocean, rather than
  // rotating already clipped polygons (which would leave unsupported corners).
  const frameSeed = seedNumber(`${input.seed}:map-frame-v1`)
  const style = noise(frameSeed, 0, 8), mirrored = frameSeed % 2 === 1, mirror = mirrored ? -1 : 1
  const angle = (style - .5) * .9, cosine = Math.cos(angle), sine = Math.sin(angle)
  const oppositeBank = style > .5
  const localAnchor = { x: w * (input.terrain === 'plain' ? .5 : (oppositeBank ? .26 : .64) + noise(frameSeed, 7.4, 9.2) * .12), y: h * (input.terrain === 'coast' ? .7 : .5) }
  const offset = (p: Point): Point => ({ x: cosine * mirror * (p.x - localAnchor.x) - sine * (p.y - localAnchor.y), y: sine * mirror * (p.x - localAnchor.x) + cosine * (p.y - localAnchor.y) })
  const corners = [{ x: -1000, y: -1000 }, { x: w + 1000, y: -1000 }, { x: -1000, y: h + 1000 }, { x: w + 1000, y: h + 1000 }].map(offset)
  const anchor = worldPoint(pivot)
  anchor.x = clamp(anchor.x, 100 - Math.min(...corners.map(p => p.x)), world.extent - 100 - Math.max(...corners.map(p => p.x)))
  anchor.y = clamp(anchor.y, 100 - Math.min(...corners.map(p => p.y)), world.extent - 100 - Math.max(...corners.map(p => p.y)))
  const regional = (p: Point): Point => { const q = offset(p); return { x: anchor.x + q.x, y: anchor.y + q.y } }
  const cropOrigin = regional({ x: 0, y: 0 })
  const local = (p: Point): Point => ({ x: localAnchor.x + mirror * (cosine * (p.x - anchor.x) + sine * (p.y - anchor.y)), y: localAnchor.y - sine * (p.x - anchor.x) + cosine * (p.y - anchor.y) })
  const channel = (i: number) => i >= 0 && world.accumulatedArea[i]! >= 4_000_000 && !world.ocean[i]
  const upstream = (i: number) => {
    const result: number[] = [], x = i % world.columns, y = Math.floor(i / world.columns)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy
      if ((!dx && !dy) || nx < 0 || nx >= world.columns || ny < 0 || ny >= world.rows) continue
      const j = ny * world.columns + nx
      if (world.flowTo[j] === i && channel(j)) result.push(j)
    }
    return result
  }
  const main: number[] = [], used = new Uint8Array(world.rawDEM.length)
  for (let i = pivot, guard = 0; channel(i) && guard < world.rawDEM.length; guard++) {
    main.push(i)
    const branches = upstream(i).sort((a, b) => world.accumulatedArea[b]! - world.accumulatedArea[a]!)
    if (!branches.length) break
    i = branches[0]!
  }
  main.reverse()
  for (let i = world.flowTo[pivot]!, guard = 0; i >= 0 && guard < world.rawDEM.length; guard++, i = world.flowTo[i]!) { main.push(i); if (world.ocean[i]) break }
  for (const i of main) used[i] = 1
  const cellPaths: number[][] = main.length > 1 ? [main] : []
  for (let i = 0; i < world.rawDEM.length; i++) {
    if (!channel(i) || used[i] || upstream(i).length) continue
    const path: number[] = []
    for (let j = i, guard = 0; j >= 0 && guard < world.rawDEM.length; guard++, j = world.flowTo[j]!) {
      path.push(j)
      if (used[j] || world.ocean[j]) break
      used[j] = 1
    }
    if (path.length > 3) cellPaths.push(path)
  }
  const nearestOnLine = (p: Point, a: Point, b: Point) => {
    const dx = b.x - a.x, dy = b.y - a.y, t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
    return { t, distance: Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t) }
  }
  const smoothOpen = (path: Point[]) => {
    const tangents = path.map((p, i) => {
      const a = path[Math.max(0, i - 1)]!, b = path[Math.min(path.length - 1, i + 1)]!
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1
      const left = i ? Math.hypot(p.x - a.x, p.y - a.y) : Math.hypot(b.x - p.x, b.y - p.y)
      const right = i + 1 < path.length ? Math.hypot(b.x - p.x, b.y - p.y) : left
      const scale = Math.min(left, right) * .9 / length
      return { x: (b.x - a.x) * scale, y: (b.y - a.y) * scale }
    })
    const result: Point[] = [path[0]!]
    // Shared Hermite tangents keep the bank offset continuous at confluences.
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, ta = tangents[i - 1]!, tb = tangents[i]!
      const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 20))
      for (let j = 1; j <= steps; j++) {
        const t = j / steps, t2 = t * t, t3 = t2 * t
        const f0 = 2 * t3 - 3 * t2 + 1, f1 = t3 - 2 * t2 + t, f2 = -2 * t3 + 3 * t2, f3 = t3 - t2
        result.push({ x: a.x * f0 + ta.x * f1 + b.x * f2 + tb.x * f3, y: a.y * f0 + ta.y * f1 + b.y * f2 + tb.y * f3 })
      }
    }
    return result
  }
  const rivers: TerrainRiver[] = []
  for (const [pathIndex, fullPath] of cellPaths.entries()) {
    const visible = fullPath.map(i => local(worldPoint(i)))
    let first = -1, last = -1
    for (let i = 0; i < visible.length; i++) { const p = visible[i]!; if (p.x > -450 && p.x < w + 450 && p.y > -450 && p.y < h + 450) { if (first < 0) first = i; last = i } }
    if (first < 0 || last - first < 2) continue
    const cells = fullPath.slice(Math.max(0, first - 2), Math.min(fullPath.length, last + 3)), original = cells.map(i => local(worldPoint(i)))
    // Junctions are shared geometric constraints. Smoothing a whole trunk would
    // move its confluences away from the tributary endpoints and break the water.
    const knots = [0, ...cells.flatMap((cell, i) => i > 0 && i < cells.length - 1 && upstream(cell).length > 1 ? [i] : []), cells.length - 1]
    const controls: Point[] = []
    for (let i = 1; i < knots.length; i++) {
      // Sub-grid D8 zigzags are numerical routing detail, not tiny meanders.
      const run = simplifyLine(original.slice(knots[i - 1]!, knots[i]! + 1), world.resolution * 1.2)
      controls.push(...(controls.length ? run.slice(1) : run))
    }
    const points = smoothOpen(controls)
    const widths: number[] = [], drainageArea: number[] = [], surfaceElevation: number[] = []
    let lastElevation = Infinity, lastArea = 0
    for (const p of points) {
      let closest = 0, fraction = 0, d = Infinity
      for (let j = 1; j < original.length; j++) { const hit = nearestOnLine(p, original[j - 1]!, original[j]!); if (hit.distance < d) { d = hit.distance; closest = j - 1; fraction = hit.t } }
      const a = cells[closest]!, b = cells[Math.min(cells.length - 1, closest + 1)]!
      const areaA = world.accumulatedArea[a]!, areaB = pathIndex > 0 && closest + 1 === cells.length - 1 ? Math.min(world.accumulatedArea[b]!, areaA * 1.02) : world.accumulatedArea[b]!
      const accumulated = Math.max(lastArea, areaA * (1 - fraction) + areaB * fraction)
      const z = Math.min(lastElevation, world.hydroDEM[a]! * (1 - fraction) + world.hydroDEM[b]! * fraction)
      // Regional bankfull-width proxy, not a discharge forecast or universal Japanese coefficient.
      widths.push(clamp(4.8 * Math.pow(accumulated / 1_000_000, .46), 5, 130))
      drainageArea.push(accumulated); surfaceElevation.push(z); lastArea = accumulated; lastElevation = z
    }
    rivers.push({ id: pathIndex === 0 ? 'river' : `river-branch-${pathIndex}`, points, widths, drainageArea, surfaceElevation })
  }
  const clippedPolygon = (polygon: Point[]) => {
    let result = polygon
    for (const [axis, edge, sign] of [['x', 0, 1], ['x', w, -1], ['y', 0, 1], ['y', h, -1]] as const) {
      const next: Point[] = []
      for (let i = 0; i < result.length; i++) {
        const a = result[i]!, b = result[(i + 1) % result.length]!, da = (a[axis] - edge) * sign, db = (b[axis] - edge) * sign
        if (da >= 0) next.push(a)
        if ((da < 0) !== (db < 0)) { const t = da / (da - db); next.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }) }
      }
      result = next
    }
    return result.map(p => ({ x: clamp(p.x, 0, w), y: clamp(p.y, 0, h) }))
  }
  const areas: Area[] = []
  for (const river of rivers) {
    const left: Point[] = [], right: Point[] = []
    for (let i = 0; i < river.points.length; i++) {
      const p = river.points[i]!, a = river.points[Math.max(0, i - 1)]!, b = river.points[Math.min(river.points.length - 1, i + 1)]!
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1, nx = -(b.y - a.y) / length, ny = (b.x - a.x) / length, half = river.widths[i]! / 2
      left.push({ x: p.x + nx * half, y: p.y + ny * half }); right.push({ x: p.x - nx * half, y: p.y - ny * half })
    }
    const polygon = clippedPolygon([...cleanBank(left), ...cleanBank(right).reverse()])
    if (polygon.length > 3 && Math.abs(area(polygon)) > 400) areas.push({ id: river.id, kind: 'water', polygon, name: river.id === 'river' ? '水杜川' : undefined })
  }
  if (input.terrain === 'coast') {
    const cols = Math.ceil(w / 25), rows = Math.ceil(h / 25), sx = w / cols, sy = h / rows
    const mask = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => world.ocean[indexAt(regional({ x: (x + .5) * sx, y: (y + .5) * sy }))] === 1))
    for (const [i, polygon] of contours(mask, sx, sy).entries()) areas.push({ id: i ? `sea-${i}` : 'sea', kind: 'water', polygon, name: i ? undefined : '青凪湾' })
  }
  const waterRegions = areas.filter(a => a.kind === 'water').map(a => ({ polygon: a.polygon, x0: Math.min(...a.polygon.map(p => p.x)), x1: Math.max(...a.polygon.map(p => p.x)), y0: Math.min(...a.polygon.map(p => p.y)), y1: Math.max(...a.polygon.map(p => p.y)) }))
  const waterAt = (p: Point) => waterRegions.some(a => p.x >= a.x0 && p.x <= a.x1 && p.y >= a.y0 && p.y <= a.y1 && inside(p, a.polygon))
  type RiverSegment = { a: Point; b: Point; widthA: number; widthB: number; zA: number; zB: number }
  const riverBuckets = new Map<string, RiverSegment[]>(), bucketSize = 220
  for (const river of rivers) for (let i = 1; i < river.points.length; i++) {
    const a = river.points[i - 1]!, b = river.points[i]!, segment: RiverSegment = { a, b, widthA: river.widths[i - 1]!, widthB: river.widths[i]!, zA: river.surfaceElevation[i - 1]!, zB: river.surfaceElevation[i]! }
    for (let x = Math.floor((Math.min(a.x, b.x) - 320) / bucketSize); x <= Math.floor((Math.max(a.x, b.x) + 320) / bucketSize); x++) for (let y = Math.floor((Math.min(a.y, b.y) - 320) / bucketSize); y <= Math.floor((Math.max(a.y, b.y) + 320) / bucketSize); y++) { const key = `${x},${y}`, bucket = riverBuckets.get(key) ?? []; bucket.push(segment); riverBuckets.set(key, bucket) }
  }
  const nearRiver = (p: Point) => {
    let distance = Infinity, width = 0, z = 0
    for (const segment of riverBuckets.get(`${Math.floor(p.x / bucketSize)},${Math.floor(p.y / bucketSize)}`) ?? []) {
      const hit = nearestOnLine(p, segment.a, segment.b)
      if (hit.distance < distance) { distance = hit.distance; width = segment.widthA * (1 - hit.t) + segment.widthB * hit.t; z = segment.zA * (1 - hit.t) + segment.zB * hit.t }
    }
    return { distance, width, z, bankDistance: distance - width / 2 }
  }
  const localResolution = 10, localColumns = Math.ceil((w + 2000) / localResolution) + 1, localRows = Math.ceil((h + 2000) / localResolution) + 1
  const localDEM = new Float32Array(localColumns * localRows)
  for (let y = 0; y < localRows; y++) for (let x = 0; x < localColumns; x++) {
    const p = { x: x * localResolution - 1000, y: y * localResolution - 1000 }, r = nearRiver(p)
    const worldPosition = regional(p)
    let z = sampleRegional(world, world.rawDEM, worldPosition.x, worldPosition.y)
    const detail = (noise(seed, p.x / 150, p.y / 150) - .5) * Math.min(.9, r.distance / 250)
    z += detail
    if (r.bankDistance < 180) {
      const target = r.z + Math.max(0, r.bankDistance) * .055
      z -= Math.max(0, z - target) * smooth(clamp(1 - Math.max(0, r.bankDistance) / 180))
    }
    localDEM[y * localColumns + x] = z
  }
  const elevation = (p: Point) => {
    const gx = clamp((p.x + 1000) / localResolution, 0, localColumns - 1.001), gy = clamp((p.y + 1000) / localResolution, 0, localRows - 1.001)
    const x = Math.floor(gx), y = Math.floor(gy), u = gx - x, v = gy - y, i = y * localColumns + x
    return (localDEM[i]! * (1 - u) + localDEM[i + 1]! * u) * (1 - v) + (localDEM[i + localColumns]! * (1 - u) + localDEM[i + localColumns + 1]! * u) * v
  }
  const slope = (p: Point) => Math.hypot(elevation({ x: p.x + 10, y: p.y }) - elevation({ x: p.x - 10, y: p.y }), elevation({ x: p.x, y: p.y + 10 }) - elevation({ x: p.x, y: p.y - 10 })) / 20
  const wetness = (p: Point) => {
    const r = nearRiver(p), z = elevation(p), worldPosition = regional(p), flow = sampleRegional(world, world.accumulatedArea, worldPosition.x, worldPosition.y)
    return clamp((r.distance < 320 ? Math.exp(-Math.max(0, z - r.z) / 3) * Math.exp(-Math.max(0, r.bankDistance) / 180) : 0) * .7 + Math.log1p(flow / 2500) / 15 * .3)
  }
  const landform: TerrainModel['landform'] = p => waterAt(p) ? 'water' : slope(p) > .16 ? 'ridge' : slope(p) > .065 ? 'hillside' : wetness(p) > .5 ? 'valley' : 'terrace'
  const terrainCost = (p: Point) => waterAt(p) ? Infinity : 1 + slope(p) ** 2 * 140 + wetness(p) * .6
  const cultivable = (p: Point) => !waterAt(p) && slope(p) < .06 && landform(p) !== 'ridge'
  const mainRiver = rivers.find(r => r.id === 'river') ?? rivers.reduce<TerrainRiver | undefined>((best, river) => !best || river.drainageArea.at(-1)! > best.drainageArea.at(-1)! ? river : best, undefined)
  const desired: Point = input.type === 'onsen' && mainRiver ? { x: mainRiver.points[Math.floor(mainRiver.points.length * .5)]!.x - 250, y: h * .54 } : input.type === 'port' ? { x: w * .50, y: h * .58 } : input.type === 'temple' ? { x: w * .31, y: h * .36 } : { x: w * .45, y: h * .48 }
  let cityOrigin: Point = { x: w * .45, y: h * .48 }, originScore = Infinity
  const coreRadius = input.type === 'castle' || input.type === 'temple' ? 270 : 90
  for (let y = 380; y < h - 330; y += 35) for (let x = 380; x < w - 330; x += 35) {
    const p = { x, y }, r = nearRiver(p), gradient = slope(p)
    if (waterAt(p) || gradient > .12 || r.bankDistance < coreRadius) continue
    if ([0, 1, 2, 3, 4, 5, 6, 7].some(i => waterAt({ x: x + Math.cos(i * Math.PI / 4) * coreRadius, y: y + Math.sin(i * Math.PI / 4) * coreRadius }))) continue
    const bankPreference = input.type === 'port' ? Math.abs(r.bankDistance - 180) * .8 : input.type === 'onsen' ? Math.abs(r.bankDistance - 220) * .25 : 0
    const cost = Math.hypot(x - desired.x, y - desired.y) + gradient * 1200 + wetness(p) * 140 + bankPreference
    if (cost < originScore) { originScore = cost; cityOrigin = p }
  }
  const bridgeCandidates: TerrainModel['bridgeCandidates'] = []
  for (const river of rivers) for (let i = 3; i < river.points.length - 3; i += 3) {
    const p = river.points[i]!, a = river.points[i - 3]!, b = river.points[i + 3]!, length = Math.hypot(b.x - a.x, b.y - a.y), width = river.widths[i]!
    if (p.x < 260 || p.x > w - 260 || p.y < 220 || p.y > h - 220 || width < 12 || width > 110 || !waterAt(p) || length < 1) continue
    const nx = -(b.y - a.y) / length, ny = (b.x - a.x) / length, span = width / 2 + 35
    const bankA = { x: p.x + nx * span, y: p.y + ny * span }, bankB = { x: p.x - nx * span, y: p.y - ny * span }
    if (waterAt(bankA) || waterAt(bankB) || slope(bankA) > .12 || slope(bankB) > .12) continue
    const cost = width + Math.abs(elevation(bankA) - elevation(bankB)) * 3 + (slope(bankA) + slope(bankB)) * 200 + Math.abs(p.x - w * .67) * .03
    bridgeCandidates.push({ point: p, bankA, bankB, width, cost, riverId: river.id })
  }
  bridgeCandidates.sort((a, b) => a.cost - b.cost)
  // A globally cheapest shortlist would select only narrow tributaries and omit
  // the main river, making a feasible cross-valley road impossible. Survey each
  // connected channel separately and retain several spatially distinct corridors.
  const selected: TerrainModel['bridgeCandidates'] = []
  for (const river of [...rivers].sort((a, b) => Number(b.id === 'river') - Number(a.id === 'river'))) {
    const perRiver: TerrainModel['bridgeCandidates'] = []
    const options = bridgeCandidates.filter(c => c.riverId === river.id).sort((a, b) => a.cost + Math.abs(a.point.y - h * .63) * .035 - b.cost - Math.abs(b.point.y - h * .63) * .035)
    for (const candidate of options) if (perRiver.every(bridge => Math.hypot(bridge.point.x - candidate.point.x, bridge.point.y - candidate.point.y) > 600)) {
      perRiver.push(candidate)
      if (perRiver.length === (river.id === 'river' ? 3 : 2)) break
    }
    selected.push(...perRiver)
    if (selected.length >= 8) break
  }
  const bridgeSites = selected.filter(c => c.riverId === 'river').map(c => c.point)
  for (const candidate of selected) if (bridgeSites.length < 3 && bridgeSites.every(p => Math.hypot(p.x - candidate.point.x, p.y - candidate.point.y) > 650)) bridgeSites.push(candidate.point)
  if (input.forest > 0) {
    const cols = Math.ceil(w / 40), rows = Math.ceil(h / 40), sx = w / cols, sy = h / rows, reference = elevation(cityOrigin)
    const threshold = 110 - clamp(input.forest / 100) * 90
    const mask = Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => {
      const p = { x: (col + .5) * sx, y: (row + .5) * sy }
      if (waterAt(p) || nearRiver(p).bankDistance < 65 || Math.hypot(p.x - cityOrigin.x, p.y - cityOrigin.y) < coreRadius + 75) return false
      const ridge = elevation(p) - reference + slope(p) * 320 + (noise(seed, p.x / 240, p.y / 240) - .5) * 14
      return ridge > threshold
    }))
    for (const [i, polygon] of contours(mask, sx, sy).entries()) if (!polygon.some(waterAt)) areas.push({ id: `forest-${i}`, kind: 'forest', polygon, name: i === 0 ? '北山丘陵' : i === 1 ? '西ノ森' : undefined })
  }
  return { areas, elevation, slope, waterAt, bridgeSites, cityOrigin, landform, wetness, terrainCost, cultivable, rivers, bridgeCandidates: selected.slice(0, 8), hydrology: { ...world, cropOrigin, frame: { worldAnchor: anchor, localAnchor, angle, mirrored }, localResolution, localDEM, localColumns, localRows } }
}
