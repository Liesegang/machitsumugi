import { erodeTerrain } from './hydrology.ts'

export interface RegionalTerrain {
  extent: number
  columns: number
  rows: number
  resolution: number
  seed: number
  initialDEM: Float32Array
  rawDEM: Float32Array
  hydroDEM: Float32Array
  flowTo: Int32Array
  accumulatedArea: Float64Array
  ocean: Uint8Array
  order: Int32Array
  processedCells: number
  outletArea: number
  fillVolume: number
}
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const fade = (t: number) => t * t * (3 - 2 * t)
export function terrainSeed(seed: string) { let n = 2166136261; for (const c of seed) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return n >>> 0 }
export function terrainNoise(seed: number, x: number, y: number) {
  const hash = (i: number, j: number) => { let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ seed; n = Math.imul(n ^ n >>> 13, 1274126177); return ((n ^ n >>> 16) >>> 0) / 4294967295 }
  const i = Math.floor(x), j = Math.floor(y), u = fade(x - i), v = fade(y - j)
  return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v
}
export function sampleRegional(world: RegionalTerrain, field: Float32Array | Float64Array, x: number, y: number) {
  const gx = clamp(x / world.resolution, 0, world.columns - 1.001), gy = clamp(y / world.resolution, 0, world.rows - 1.001)
  const ix = Math.floor(gx), iy = Math.floor(gy), u = gx - ix, v = gy - iy, i = iy * world.columns + ix
  return (field[i]! * (1 - u) + field[i + 1]! * u) * (1 - v) + (field[i + world.columns]! * (1 - u) + field[i + world.columns + 1]! * u) * v
}
const cache = new Map<string, RegionalTerrain>()

/** Regional landforms precede the 4×3km city crop; river catchments are never viewport-sized. */
export function getRegionalTerrain(seedText: string): RegionalTerrain {
  const cached = cache.get(seedText)
  if (cached) { cache.delete(seedText); cache.set(seedText, cached); return cached }
  const extent = 24_000, resolution = 50, columns = extent / resolution + 1, rows = columns, count = columns * rows
  const seed = terrainSeed(`${seedText}:watershed-v4`), initial = new Float32Array(count)
  const ridges = [-1, 1].map((side, ridge) => Array.from({ length: 7 }, (_, i) => ({ x: extent * (.56 + side * (ridge === 0 ? .17 : .30)) + (terrainNoise(seed + 51 + ridge, i * 1.71, 8) - .5) * 1900, y: i * extent / 6 })))
  const segmentDistance = (x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y, t = clamp(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy))
    return Math.hypot(x - a.x - dx * t, y - a.y - dy * t)
  }
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const x = col * resolution, y = row * resolution, nx = x / extent, ny = y / extent
    const t = .79 - ny
    // Regional coastal subsidence opens the valley into a bay rather than ending
    // the drainage in a narrow, accidentally enclosed negative-elevation pit.
    const coast = fade(clamp((ny - .72) / .28))
    const base = 430 * Math.sign(t) * Math.pow(Math.abs(t), 1.6) - coast * 220
    // A broad, wandering structural valley joins the mountain catchments. Its cross
    // slope must exceed D8's angular threshold away from the floor; a nearly
    // uniform tilted plane otherwise creates many artificial parallel channels.
    const valleyAxis = .56 + (terrainNoise(seed + 409, 0, y / 5200) - .5) * .08 + (terrainNoise(seed + 683, 0, y / 1900) - .5) * .045
    const valleyDistance = Math.abs(nx - valleyAxis), transverse = 1250 * Math.pow(valleyDistance, 1.4)
    let uplift = 0
    for (const [ridgeIndex, ridge] of ridges.entries()) {
      let d = Infinity
      for (let i = 1; i < ridge.length; i++) d = Math.min(d, segmentDistance(x, y, ridge[i - 1]!, ridge[i]!))
      uplift += (ridgeIndex === 0 ? 265 : 190) * Math.exp(-((d / 1850) ** 2))
    }
    const roughness = 14 + clamp(valleyDistance / .30) * 76
    const low = (terrainNoise(seed, x / 3700, y / 3700) - .5) * roughness
    const medium = (terrainNoise(seed + 119, x / 1350, y / 1350) - .5) * roughness * .36
    const detail = (terrainNoise(seed + 217, x / 520, y / 520) - .5) * roughness * .08
    initial[row * columns + col] = base + transverse + uplift + low + medium + detail
  }
  const eroded = erodeTerrain(initial, columns, rows, resolution, 2)
  const ocean = new Uint8Array(count), queue = new Int32Array(count)
  let head = 0, tail = 0
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) if (!row || !col || row === rows - 1 || col === columns - 1) {
    const i = row * columns + col
    if (eroded.rawDEM[i]! <= 0 && !ocean[i]) { ocean[i] = 1; queue[tail++] = i }
  }
  while (head < tail) {
    const i = queue[head++]!, x = i % columns, y = Math.floor(i / columns)
    for (const j of [x > 0 ? i - 1 : -1, x + 1 < columns ? i + 1 : -1, y > 0 ? i - columns : -1, y + 1 < rows ? i + columns : -1]) {
      if (j >= 0 && !ocean[j] && eroded.rawDEM[j]! <= 0) { ocean[j] = 1; queue[tail++] = j }
    }
  }
  const result: RegionalTerrain = { extent, columns, rows, resolution, seed, ...eroded, ocean }
  cache.set(seedText, result)
  while (cache.size > 2) cache.delete(cache.keys().next().value!)
  return result
}
