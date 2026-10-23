import type { Point } from './types'

export interface LakePolygon { polygon: Point[]; holes: Point[][] }
export interface DepressionLake {
  id: string; level: number; kind: 'lake' | 'wetland'; polygons: LakePolygon[]
  area: number; volume: number; maximumDepth: number; meanDepth: number; cells: number; spill: Point | null
}
export interface DepressionLakeInput {
  rawDEM: Float32Array; hydroDEM: Float32Array; columns: number; rows: number; cellSize: number
  seaLevel?: number; oceanMask?: Uint8Array; minimumArea?: number; depthTolerance?: number
}
const areaOf = (ring: Point[]) => ring.reduce((sum, a, i) => { const b = ring[(i + 1) % ring.length]!; return sum + a.x * b.y - b.x * a.y }, 0) / 2
function inside(point: Point, ring: Point[]) {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i]!, b = ring[j]!; if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) hit = !hit }
  return hit
}
function connectedOcean(input: DepressionLakeInput) {
  if (input.oceanMask) return input.oceanMask
  const { columns, rows, rawDEM } = input, mask = new Uint8Array(rawDEM.length), queue = new Int32Array(rawDEM.length), sea = input.seaLevel ?? 0
  let head = 0, tail = 0
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) if ((!x || !y || x === columns - 1 || y === rows - 1) && rawDEM[y * columns + x]! <= sea) { const i = y * columns + x; mask[i] = 1; queue[tail++] = i }
  while (head < tail) {
    const i = queue[head++]!, x = i % columns, y = Math.floor(i / columns)
    for (const j of [x ? i - 1 : -1, x + 1 < columns ? i + 1 : -1, y ? i - columns : -1, y + 1 < rows ? i + columns : -1]) if (j >= 0 && !mask[j] && rawDEM[j]! <= sea) { mask[j] = 1; queue[tail++] = j }
  }
  return mask
}

/** Marching-squares water-level contour on the original bed. The scalar field
 * is never smoothed; the same interpolated shore is returned to every caller. */
function contourBasin(input: DepressionLakeInput, labels: Int32Array, label: number, level: number, bounds: { minX: number; maxX: number; minY: number; maxY: number }): LakePolygon[] {
  const { columns, rows, cellSize, rawDEM } = input, vertices = new Map<string, Point>(), edges = new Map<string, string[]>(), used = new Set<string>()
  const scalar = (x: number, y: number) => {
    const i = y * columns + x, d = rawDEM[i]! - level
    return labels[i] === label ? Math.min(-1e-6, d) : Math.max(1e-6, d)
  }
  const add = (a: string, b: string) => { if (a === b) return; const first = edges.get(a) ?? [], second = edges.get(b) ?? []; first.push(b); second.push(a); edges.set(a, first); edges.set(b, second) }
  const crossing = (x: number, y: number, horizontal: boolean) => {
    const key = `${horizontal ? 'h' : 'v'}${x}:${y}`
    if (!vertices.has(key)) { const a = scalar(x, y), b = scalar(x + Number(horizontal), y + Number(!horizontal)), t = a / (a - b); vertices.set(key, { x: (x + Number(horizontal) * t) * cellSize, y: (y + Number(!horizontal) * t) * cellSize }) }
    return key
  }
  for (let y = Math.max(0, bounds.minY - 1); y < Math.min(rows - 1, bounds.maxY + 1); y++) for (let x = Math.max(0, bounds.minX - 1); x < Math.min(columns - 1, bounds.maxX + 1); x++) {
    const values = [scalar(x, y), scalar(x + 1, y), scalar(x + 1, y + 1), scalar(x, y + 1)]
    const keys = [(values[0]! < 0) !== (values[1]! < 0) ? crossing(x, y, true) : null, (values[1]! < 0) !== (values[2]! < 0) ? crossing(x + 1, y, false) : null, (values[2]! < 0) !== (values[3]! < 0) ? crossing(x, y + 1, true) : null, (values[3]! < 0) !== (values[0]! < 0) ? crossing(x, y, false) : null]
    const found = keys.filter((key): key is string => key !== null)
    if (found.length === 2) add(found[0]!, found[1]!)
    else if (found.length === 4) {
      const denominator = values[0]! + values[2]! - values[1]! - values[3]!, saddle = denominator ? (values[0]! * values[2]! - values[1]! * values[3]!) / denominator : values.reduce((sum, z) => sum + z, 0) / 4
      if ((saddle < 0) === (values[0]! < 0)) { add(keys[0]!, keys[1]!); add(keys[2]!, keys[3]!) }
      else { add(keys[0]!, keys[3]!); add(keys[1]!, keys[2]!) }
    }
  }
  const loops: { polygon: Point[]; area: number; parent: number; depth: number }[] = [], edgeKey = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`
  for (const [start, neighbors] of edges) for (const next of neighbors) {
    if (used.has(edgeKey(start, next))) continue
    const polygon = [vertices.get(start)!]
    let previous = start, current = next
    for (let guard = 0; guard <= edges.size; guard++) {
      used.add(edgeKey(previous, current))
      if (current === start) break
      const point = vertices.get(current)!
      if (Math.hypot(point.x - polygon.at(-1)!.x, point.y - polygon.at(-1)!.y) > 1e-8) polygon.push(point)
      const following = (edges.get(current) ?? []).find(key => key !== previous && !used.has(edgeKey(current, key)))
      if (!following) break
      previous = current; current = following
    }
    const area = Math.abs(areaOf(polygon))
    if (current === start && polygon.length >= 3 && area > 1e-4) loops.push({ polygon, area, parent: -1, depth: 0 })
  }
  loops.sort((a, b) => b.area - a.area)
  for (let i = 0; i < loops.length; i++) for (let j = i - 1; j >= 0; j--) if (inside(loops[i]!.polygon[0]!, loops[j]!.polygon)) { loops[i]!.parent = j; loops[i]!.depth = loops[j]!.depth + 1; break }
  return loops.flatMap((loop, i) => loop.depth % 2 ? [] : [{ polygon: loop.polygon, holes: loops.filter(hole => hole.parent === i && hole.depth % 2 === 1).map(hole => hole.polygon) }])
}

/** Filled depressions describe standing water at their spill level, not an
 * invented channel through a virtual flat. No physical erosion or bed raising
 * is performed here. Lake/wetland thresholds below are application assumptions
 * at this DEM resolution, not an ecological wetland classification. */
export function extractDepressionLakes(input: DepressionLakeInput) {
  const { rawDEM, hydroDEM, columns, rows, cellSize } = input, count = columns * rows
  if (rawDEM.length !== count || hydroDEM.length !== count || (input.oceanMask && input.oceanMask.length !== count) || columns < 2 || rows < 2 || !(cellSize > 0)) throw new Error('Lake extraction requires matching finite DEM grids')
  const ocean = connectedOcean(input), labels = new Int32Array(count), queue = new Int32Array(count), bodies: DepressionLake[] = []
  const tolerance = input.depthTolerance ?? .01, minimumArea = input.minimumArea ?? cellSize * cellSize * 4
  let label = 0, filledCells = 0, fillVolume = 0, excludedOceanVolume = 0, unresolvedSmallVolume = 0
  for (let i = 0; i < count; i++) { if (!Number.isFinite(rawDEM[i]) || !Number.isFinite(hydroDEM[i])) throw new Error('Lake extraction requires finite elevations'); const depth = hydroDEM[i]! - rawDEM[i]!; if (depth > tolerance) { filledCells++; fillVolume += depth * cellSize ** 2 } }
  for (let seed = 0; seed < count; seed++) {
    if (labels[seed] || hydroDEM[seed]! - rawDEM[seed]! <= tolerance) continue
    const level = hydroDEM[seed]!, currentLabel = ++label, bounds = { minX: columns, minY: rows, maxX: 0, maxY: 0 }
    let head = 0, tail = 1, volume = 0, maximumDepth = 0, marine = false, spill: Point | null = null, spillDepth = Infinity
    queue[0] = seed; labels[seed] = currentLabel
    while (head < tail) {
      const i = queue[head++]!, x = i % columns, y = Math.floor(i / columns), depth = level - rawDEM[i]!
      volume += depth * cellSize ** 2; maximumDepth = Math.max(maximumDepth, depth); marine ||= !!ocean[i]
      bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x); bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= columns || y + dy < 0 || y + dy >= rows) continue
        const j = i + dy * columns + dx, nextDepth = hydroDEM[j]! - rawDEM[j]!
        if (!labels[j] && nextDepth > tolerance && Math.abs(hydroDEM[j]! - level) <= .002) { labels[j] = currentLabel; queue[tail++] = j }
        if (nextDepth <= tolerance && Math.abs(rawDEM[j]! - level) < spillDepth) { spillDepth = Math.abs(rawDEM[j]! - level); spill = { x: (x + dx) * cellSize, y: (y + dy) * cellSize } }
      }
    }
    if (marine) { excludedOceanVolume += volume; continue }
    const polygons = contourBasin(input, labels, currentLabel, level, bounds), area = polygons.reduce((sum, region) => sum + Math.abs(areaOf(region.polygon)) - region.holes.reduce((holes, hole) => holes + Math.abs(areaOf(hole)), 0), 0)
    if (area < minimumArea || !polygons.length) { unresolvedSmallVolume += volume; continue }
    const meanDepth = volume / area
    bodies.push({ id: `lake-${seed}`, level, kind: maximumDepth >= 1.5 && meanDepth >= .5 ? 'lake' : 'wetland', polygons, area, volume, maximumDepth, meanDepth, cells: tail, spill })
  }
  const buckets = new Map<string, DepressionLake[]>()
  for (const body of bodies) for (const region of body.polygons) {
    const xs = region.polygon.map(p => p.x), ys = region.polygon.map(p => p.y)
    for (let x = Math.floor(Math.min(...xs) / 500); x <= Math.floor(Math.max(...xs) / 500); x++) for (let y = Math.floor(Math.min(...ys) / 500); y <= Math.floor(Math.max(...ys) / 500); y++) { const key = `${x}:${y}`, bucket = buckets.get(key) ?? []; if (!bucket.includes(body)) bucket.push(body); buckets.set(key, bucket) }
  }
  const at = (point: Point) => (buckets.get(`${Math.floor(point.x / 500)}:${Math.floor(point.y / 500)}`) ?? []).find(body => body.polygons.some(region => inside(point, region.polygon) && !region.holes.some(hole => inside(point, hole)))) ?? null
  return { bodies, at, diagnostics: { filledCells, fillVolume, excludedOceanVolume, unresolvedSmallVolume, lakeArea: bodies.filter(body => body.kind === 'lake').reduce((sum, body) => sum + body.area, 0), wetlandArea: bodies.filter(body => body.kind === 'wetland').reduce((sum, body) => sum + body.area, 0) } }
}
